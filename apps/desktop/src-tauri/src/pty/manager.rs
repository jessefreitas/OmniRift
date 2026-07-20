use crate::pty::detector::{AgentState, AgentStateMap, StateDetector};
use crate::pty::emulator::{PtySnapshot, TermEmulator};
use crate::pty::profile::profile_for;
use crate::pty::session::{PtySession, PtySpawnConfig, SessionId};
use anyhow::{anyhow, Result};
use dashmap::DashMap;
use parking_lot::Mutex;
use serde::Serialize;
use std::collections::HashMap;
use std::io::Write;
use std::sync::Arc;
use tauri::AppHandle;
use tokio::sync::broadcast;
use tokio::task::JoinHandle;

/// Info de processo de uma sessão PTY (process mgmt na UI).
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcInfo {
    pub pid: u32,
    /// RSS em KB (Linux via /proc; 0 fora do Linux ou se indisponível).
    pub rss_kb: u64,
    pub alive: bool,
}

/// RSS do processo (Linux: /proc/<pid>/statm campo 2 = páginas residentes).
fn read_rss_kb(pid: u32) -> u64 {
    let statm = std::fs::read_to_string(format!("/proc/{pid}/statm")).unwrap_or_default();
    let pages: u64 = statm.split_whitespace().nth(1).and_then(|s| s.parse().ok()).unwrap_or(0);
    pages * 4 // página de 4096 B = 4 KB
}

pub struct PtyManager {
    sessions: Arc<DashMap<SessionId, Arc<PtySession>>>,
    pipes: Arc<Mutex<HashMap<(SessionId, SessionId), JoinHandle<()>>>>,
    state_map: AgentStateMap,
    state_tx: broadcast::Sender<(SessionId, AgentState)>,
    /// Emulador VT headless por sessão (ref P0 #2): a fonte da verdade do scrollback
    /// no backend. Alimentado por uma feeder task que assina o broadcast do PTY; o
    /// front re-hidrata via `pty_snapshot`. **Aditivo** — o emit ao vivo é intocado.
    emulators: Arc<DashMap<SessionId, Arc<Mutex<TermEmulator>>>>,
}

impl Default for PtyManager {
    fn default() -> Self {
        let (state_tx, _) = broadcast::channel(256);
        Self {
            sessions: Arc::default(),
            pipes: Arc::new(Mutex::new(HashMap::new())),
            state_map: Arc::new(DashMap::new()),
            state_tx,
            emulators: Arc::default(),
        }
    }
}

impl PtyManager {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn spawn(&self, id: SessionId, cfg: PtySpawnConfig, app: AppHandle) -> Result<SessionId> {
        if self.sessions.contains_key(&id) {
            return Err(anyhow!("sessão {id} já existe"));
        }
        let profile = profile_for(&cfg.command);
        let session = Arc::new(PtySession::spawn(id.clone(), cfg, app.clone())?);
        self.sessions.insert(id.clone(), session.clone());
        // Estado inicial explícito: agent_state nunca devolve None (sem "unknown").
        self.state_map.insert(id.clone(), AgentState::Idle);

        // Emulador VT headless: cria nas dims iniciais e alimenta-o do MESMO broadcast
        // que o read-loop já publica. Feeder em `tauri::async_runtime::spawn` (não
        // `tokio::spawn`): `spawn` é comando Tauri SÍNCRONO, fora do runtime tokio —
        // mesma razão do StateDetector. Encerra sozinho no `Closed` do broadcast (EOF).
        // `new_with_seq`: o emulador COMPARTILHA o `seq` atômico do `PtySession`. Assim
        // o feeder (abaixo) incrementa-o por chunk pintado E o thread de emit do
        // `pty://output` (em session.rs) lê o mesmo valor pra estampar cada evento ao
        // vivo → `pty://output.seq` e `snapshot.seq` na MESMA escala (dedup do front).
        // O emulador é criado DENTRO do PtySession, antes da thread de leitura, e
        // alimentado lá mesmo — sem feeder task e sem broadcast no caminho. Era ali
        // que a query inicial se perdia (subscribe tardio) e o agente morria.
        self.emulators.insert(id.clone(), session.emulator_arc());

        StateDetector::spawn(
            id.clone(),
            session.subscribe(),
            session.master_arc(),
            session.screen_arc(),
            session.root_pid(),
            profile,
            app,
            self.state_map.clone(),
            self.state_tx.clone(),
        );
        Ok(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<()> {
        self.sessions
            .get(id)
            .ok_or_else(|| anyhow!("sessão {id} não encontrada"))?
            .write(data)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        // Redimensiona o emulador junto (aditivo; se não houver, ignora — degrade limpo).
        if let Some(emu) = self.emulators.get(id) {
            emu.lock().resize(cols, rows);
        }
        self.sessions
            .get(id)
            .ok_or_else(|| anyhow!("sessão {id} não encontrada"))?
            .resize(cols, rows)
    }

    pub fn kill(&self, id: &str) -> Result<()> {
        let (_, session) = self.sessions
            .remove(id)
            .ok_or_else(|| anyhow!("sessão {id} não encontrada"))?;
        // Mata o processo filho ANTES de soltar a sessão: fecha o slave → o read_loop
        // sai por EOF → todas as threads (read/emit/feeder/detector) encerram e o
        // waiter reapeia. O StateDetector segura um clone do master_arc, então NÃO dá
        // pra contar só com o drop fechar o fd — o kill explícito é o que garante o
        // teardown (era o leak de processo+threads a cada terminal fechado).
        session.kill_child();
        self.state_map.remove(id);
        // Remove o emulador: o feeder task encerra sozinho no `Closed` do broadcast.
        self.emulators.remove(id);
        Ok(())
    }

    /// Snapshot serializado (scrollback+viewport em ANSI) do emulador de uma sessão.
    /// Erro claro se a sessão não tem emulador → o front degrada pro fluxo ao vivo atual.
    pub fn snapshot(&self, id: &str, scrollback_rows: usize) -> Result<PtySnapshot> {
        let emu = self
            .emulators
            .get(id)
            .ok_or_else(|| anyhow!("sessão {id} sem emulador (sem snapshot — degrade pro fluxo ao vivo)"))?;
        let snap = emu.lock().snapshot(scrollback_rows);
        Ok(snap)
    }

    /// Insere um emulador já alimentado direto no mapa — só pra testar a leitura do
    /// `snapshot` sem spawnar um PTY real (que exige AppHandle + processo). O caminho
    /// de produção cria o emulador em `spawn` e o alimenta pela feeder task.
    #[cfg(test)]
    pub(crate) fn insert_emulator_for_test(&self, id: &str, emu: TermEmulator) {
        self.emulators
            .insert(id.to_string(), Arc::new(Mutex::new(emu)));
    }

    /// PID raiz + RSS de uma sessão (process mgmt na UI). None se a sessão sumiu.
    pub fn proc_info(&self, id: &str) -> Option<ProcInfo> {
        let sess = self.sessions.get(id)?;
        let pid = sess.root_pid()?;
        // Antes o alive vinha de /proc/<pid>, inexistente no Windows, e por isso lá respondia sempre false.
        Some(ProcInfo {
            pid,
            rss_kb: read_rss_kb(pid),
            alive: sess.is_alive(),
        })
    }
    /// Lista somente sessões cujo processo filho ainda está vivo.
    /// `list()` continua devolvendo TODAS, inclusive mortas, porque o scrollback delas ainda é
    /// consultável; quem vai ATTACHAR precisa desta, senão cola num cadáver e a tela fica vazia
    /// sem erro nenhum.
    pub fn list_alive(&self) -> Vec<SessionId> {
        self.sessions
            .iter()
            .filter(|e| e.value().is_alive())
            .map(|e| e.key().clone())
            .collect()
    }

    /// PID + RSS de TODAS as sessões vivas de uma vez (BATCH). O front fazia N invokes
    /// `pty_proc_info` a cada tick (1 por node) → N chamadas IPC + N re-renders; agora é
    /// 1 invoke que devolve o mapa inteiro. Coletamos os ids ANTES de iterar chamando
    /// `proc_info` (que faz `sessions.get`) — iterar o DashMap e dar get no mesmo map
    /// durante a iteração pode deadlockar no mesmo shard.
    pub fn proc_info_all(&self) -> std::collections::HashMap<String, ProcInfo> {
        let ids: Vec<String> = self.sessions.iter().map(|e| e.key().clone()).collect();
        ids.into_iter()
            .filter_map(|id| self.proc_info(&id).map(|info| (id, info)))
            .collect()
    }

    /// Estado atual de um agente (consumido pelo Sub-projeto B / UI de debug).
    pub fn agent_state(&self, id: &str) -> Option<AgentState> {
        self.state_map.get(id).map(|e| *e.value())
    }

    /// Push autoritativo de estado vindo de fora do detector (ex.: hooks do agente
    /// via `POST /agent-hook/:label`). Atualiza o mapa e propaga no `state_tx` —
    /// mantém o `subscribe_state` (usado por `terminal_wait_status` / send_task) em
    /// sincronia com o que o hook reporta. NÃO emite `agent://status`: o caller
    /// (handler do MCP) faz o emit com o `AppHandle` + nome do agente.
    pub fn set_agent_state(&self, id: &str, state: AgentState) {
        self.state_map.insert(id.to_string(), state);
        let _ = self.state_tx.send((id.to_string(), state));
    }

    /// Stream de mudanças de estado (base do `wait agent-status` do Sub-projeto B).
    pub fn subscribe_state(&self) -> broadcast::Receiver<(SessionId, AgentState)> {
        self.state_tx.subscribe()
    }

    pub fn list(&self) -> Vec<SessionId> {
        self.sessions.iter().map(|e| e.key().clone()).collect()
    }

    /// (session_id, root_pid) das sessões vivas — pro Monitor de Recursos atribuir
    /// CPU/RAM por agente (soma o processo-raiz + descendentes).
    pub fn session_pids(&self) -> Vec<(SessionId, u32)> {
        self.sessions
            .iter()
            .filter_map(|e| e.value().root_pid().map(|pid| (e.key().clone(), pid)))
            .collect()
    }

    pub fn subscribe_by_id(&self, id: &str) -> anyhow::Result<broadcast::Receiver<Vec<u8>>> {
        Ok(self.sessions
            .get(id)
            .ok_or_else(|| anyhow::anyhow!("sessão '{id}' não encontrada"))?
            .subscribe())
    }

    pub fn read_screen(&self, id: &str) -> Result<String> {
        Ok(self.sessions
            .get(id)
            .ok_or_else(|| anyhow!("sessão '{id}' não encontrada"))?
            .read_screen())
    }

    pub fn pipe_parts(
        &self,
        src: &str,
        dst: &str,
    ) -> Result<(broadcast::Receiver<Vec<u8>>, Arc<Mutex<Box<dyn Write + Send>>>)> {
        let rx = self.sessions
            .get(src)
            .ok_or_else(|| anyhow!("sessão origem '{src}' não encontrada"))?
            .subscribe();
        let writer = self.sessions
            .get(dst)
            .ok_or_else(|| anyhow!("sessão destino '{dst}' não encontrada"))?
            .writer_arc();
        Ok((rx, writer))
    }

    pub fn pipe_store(&self, src: SessionId, dst: SessionId, handle: JoinHandle<()>) {
        let mut pipes = self.pipes.lock();
        if let Some(old) = pipes.insert((src, dst), handle) {
            old.abort();
        }
    }

    pub fn pipe_remove(&self, src: &str, dst: &str) -> Result<()> {
        let key = (src.to_string(), dst.to_string());
        let handle = self.pipes.lock().remove(&key)
            .ok_or_else(|| anyhow!("pipe '{src}'→'{dst}' não existe"))?;
        handle.abort();
        Ok(())
    }

    pub fn pipe_list(&self) -> Vec<[SessionId; 2]> {
        self.pipes.lock().keys().map(|(s, d)| [s.clone(), d.clone()]).collect()
    }
}

/// Relay com parser VT100 inline.
///
/// Cada chunk do broadcast é processado byte a byte:
///   \r       → limpa line_buf (TUI vai reescrever a linha do início)
///   ESC[nA   → limpa line_buf (cursor-up: conteúdo obsoleto)
///   ESC[K    → limpa line_buf (erase-to-end-of-line)
///   ESC[nC   → adiciona n espaços (cursor-right = espaçamento do Claude Code)
///   \x08     → backspace (remove último byte)
///   \n       → flush: encaminha line_buf se tiver texto real, depois limpa
///   outros ESC → descartados
///   resto    → acumulado no line_buf
pub(crate) async fn relay_task(
    mut rx: broadcast::Receiver<Vec<u8>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    src: SessionId,
    dst: SessionId,
    src_label: String,
) {
    use tokio::sync::broadcast::error::RecvError;
    let mut line_buf: Vec<u8> = Vec::new();

    loop {
        match rx.recv().await {
            Ok(bytes) => {
                let mut i = 0;
                while i < bytes.len() {
                    match bytes[i] {
                        0x1b => {
                            i += 1;
                            if i >= bytes.len() { break; }
                            match bytes[i] {
                                b'[' => {
                                    i += 1;
                                    let param_start = i;
                                    while i < bytes.len() && !(0x40..=0x7e).contains(&bytes[i]) {
                                        i += 1;
                                    }
                                    if i < bytes.len() {
                                        let cmd = bytes[i];
                                        let param = std::str::from_utf8(&bytes[param_start..i])
                                            .unwrap_or("");
                                        let n: usize = param.split(';').next()
                                            .unwrap_or("1").parse().unwrap_or(1);
                                        match cmd {
                                            b'A' | b'K' => { line_buf.clear(); }
                                            b'C' => {
                                                for _ in 0..n.min(40) { line_buf.push(b' '); }
                                            }
                                            _ => {}
                                        }
                                        i += 1;
                                    }
                                }
                                b']' => {
                                    i += 1;
                                    while i < bytes.len() {
                                        if bytes[i] == 0x07 { i += 1; break; }
                                        if bytes[i] == 0x1b
                                            && i + 1 < bytes.len()
                                            && bytes[i + 1] == b'\\'
                                        {
                                            i += 2; break;
                                        }
                                        i += 1;
                                    }
                                }
                                _ => { i += 1; }
                            }
                        }
                        b'\r' => {
                            i += 1;
                            // PTY ONLCR: \n do processo vira \r\n no master — tratar \r\n como \n
                            // \r sozinho = cursor col-0, TUI vai reescrever → descarta buf
                            if i < bytes.len() && bytes[i] == b'\n' {
                                let has_content = line_buf.iter().any(|&b| b.is_ascii_graphic());
                                if has_content {
                                    let prefix = format!("[{}]: ", src_label);
                                    let mut to_send = prefix.into_bytes();
                                    to_send.extend_from_slice(&line_buf);
                                    to_send.push(b'\n');
                                    let mut w = writer.lock();
                                    if w.write_all(&to_send).is_err() {
                                        log::warn!("pipe {src}→{dst}: erro ao escrever");
                                        return;
                                    }
                                }
                                line_buf.clear();
                                i += 1; // consome o \n junto
                            } else {
                                line_buf.clear();
                            }
                        }
                        0x08 => { line_buf.pop(); i += 1; }
                        b'\n' => {
                            // \n bare (sem \r precedente) — flush
                            let has_content = line_buf.iter().any(|&b| b.is_ascii_graphic());
                            if has_content {
                                let prefix = format!("[{}]: ", src_label);
                                let mut to_send = prefix.into_bytes();
                                to_send.extend_from_slice(&line_buf);
                                to_send.push(b'\n');
                                let mut w = writer.lock();
                                if w.write_all(&to_send).is_err() {
                                    log::warn!("pipe {src}→{dst}: erro ao escrever");
                                    return;
                                }
                            }
                            line_buf.clear();
                            i += 1;
                        }
                        b => { line_buf.push(b); i += 1; }
                    }
                }
            }
            Err(RecvError::Lagged(n)) => {
                log::warn!("pipe {src}→{dst}: {n} msgs perdidas");
            }
            Err(RecvError::Closed) => break,
        }
    }
    log::info!("pipe {src}→{dst} encerrado");
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::pty::detector::AgentState;
    use crate::pty::emulator::SCROLLBACK_LIMIT;

    #[test]
    fn state_map_starts_empty_and_is_subscribable() {
        let m = PtyManager::new();
        assert!(m.agent_state("nope").is_none());
        let _ = AgentState::Idle; // referência ao tipo do contrato
        let _rx = m.subscribe_state();
    }

    #[test]
    fn snapshot_returns_fed_content_and_seq() {
        // Espelha o caminho de produção (feeder alimenta o emulador) sem PTY real:
        // alimenta um emulador, insere no manager, e checa que `snapshot` devolve o
        // conteúdo + o seq pintado.
        let m = PtyManager::new();
        let mut emu = TermEmulator::new(80, 24);
        emu.feed(b"hello\r\nworld");
        let expected_seq = emu.seq();
        m.insert_emulator_for_test("s1", emu);

        let snap = m.snapshot("s1", SCROLLBACK_LIMIT).expect("snapshot ok");
        assert!(snap.data.contains("hello"), "snapshot deve conter hello: {:?}", snap.data);
        assert!(snap.data.contains("world"), "snapshot deve conter world: {:?}", snap.data);
        assert_eq!(snap.seq, expected_seq, "seq do snapshot = seq pintado");
        assert_eq!(snap.cols, 80);
        assert_eq!(snap.rows, 24);
    }

    #[test]
    fn snapshot_missing_emulator_errors_cleanly() {
        // Degrade limpo: sessão sem emulador → erro (não panic) → o front cai pro fluxo ao vivo.
        let m = PtyManager::new();
        let err = m.snapshot("nope", SCROLLBACK_LIMIT).unwrap_err();
        assert!(err.to_string().contains("sem emulador"), "erro claro: {err}");
    }
}
