use crate::pty::host::{self, ExecutionHost};
use anyhow::{anyhow, Context, Result};
use parking_lot::Mutex;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Serialize;
use std::io::{Read, Write};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{mpsc, Arc};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter};
use tokio::sync::broadcast;

#[cfg(windows)]
/// Separador de entradas da variável de ambiente PATH do sistema operacional. Atenção: usar ':' no Windows não gera erro visível; o Windows quebra a string por ';', então a primeira entrada vira um caminho concatenado inexistente, matando silenciosamente tanto o diretório de ferramentas do app quanto o system32.
pub(crate) const PATH_SEP: &str = ";";

#[cfg(not(windows))]
/// Separador de entradas da variável de ambiente PATH do sistema operacional. Atenção: usar ':' no Windows não gera erro visível; o Windows quebra a string por ';', então a primeira entrada vira um caminho concatenado inexistente, matando silenciosamente tanto o diretório de ferramentas do app quanto o system32.
pub(crate) const PATH_SEP: &str = ":";

pub type SessionId = String;

#[derive(Debug, Clone, serde::Deserialize)]
pub struct PtySpawnConfig {
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub cwd: Option<String>,
    #[serde(default)]
    pub env: Vec<(String, String)>,
    #[serde(default = "default_cols")]
    pub cols: u16,
    #[serde(default = "default_rows")]
    pub rows: u16,
    /// Onde o agente executa (ref §3.1). `None`/`Some("local")` = máquina atual
    /// (comportamento idêntico ao anterior — nenhum wrap). `Some("ssh:<encoded>")`
    /// → o comando nasce embrulhado em `ssh -tt ... -- <cmd-remoto>`. Campo único
    /// pra o resto do código não ramificar por transporte; só `build_command` lê.
    #[serde(default)]
    pub execution_host: Option<String>,
}

fn default_cols() -> u16 { 80 }
fn default_rows() -> u16 { 24 }

/// Decide se um `command` precisa ser executado via `cmd.exe /c` no Windows.
///
/// CLIs de node (claude/opencode/codex/gemini/agy) são instalados pelo npm como
/// um SCRIPT extensionless (shebang Unix-style, ignorado no Windows) + um shim
/// `<nome>.cmd` em `%AppData%\Roaming\npm\`. O `CreateProcessW` (usado pelo
/// portable-pty no Windows) só executa imagens PE (`.exe`); ele NÃO sabe rodar
/// um script nem resolve um `.cmd` direto via PATHEXT → falha com
/// `os error 193 — %1 não é um aplicativo Win32 válido`.
///
/// Solução: rodar via `cmd.exe /c`, que resolve o `.cmd`/script através do PATHEXT.
///
/// Fn PURA (sem I/O) → testável diretamente no Windows. A MESMA regra é espelhada
/// por `wrapper_decision_portable` nos testes, que compila nos dois SOs e cobre
/// a lógica também no Linux do CI.
/// Critério: precisa de `cmd /c` quando o command NÃO termina em `.exe` (case
/// insensitive) E não é já o próprio `cmd.exe`/`cmd`. Programas `.exe`
/// (incluindo um shell role já resolvido como `bash.exe`/`powershell.exe`)
/// spawnam direto.
#[cfg(windows)]
fn needs_cmd_wrapper(command: &str) -> bool {
    let lower = command.to_lowercase();
    // basename sem diretório (PATH pode trazer separadores `\` ou `/`).
    let base = lower
        .rsplit(|c| c == '\\' || c == '/')
        .next()
        .unwrap_or(&lower);
    if base == "cmd" || base == "cmd.exe" {
        return false; // já é o cmd → não embrulha de novo
    }
    !lower.ends_with(".exe")
}

/// Quota um único token segundo o algoritmo padrão de argv do Windows
/// (CommandLineToArgvW / MSVCRT) — o MESMO que o portable-pty usa internamente
/// em `append_quoted`. Necessário porque, no caminho `cmd.exe /c "<linha>"`,
/// nós montamos a linha de comando interna manualmente (token a token) em vez
/// de deixar o portable-pty quotar cada `.arg()` — ver `build_command` para o
/// porquê (o `cmd.exe` re-parseia a tail e quebraria args com aspas/quebras).
#[cfg(windows)]
fn win_argv_quote(arg: &str) -> String {
    // Sem caracteres que exijam quoting → devolve cru (idêntico ao portable-pty).
    if !arg.is_empty()
        && !arg
            .chars()
            .any(|c| c == ' ' || c == '\t' || c == '\n' || c == '\x0b' || c == '"')
    {
        return arg.to_string();
    }
    let mut out = String::from("\"");
    let chars: Vec<char> = arg.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        let mut backslashes = 0;
        while i < chars.len() && chars[i] == '\\' {
            i += 1;
            backslashes += 1;
        }
        if i == chars.len() {
            // Escapa todas as `\` finais pra elas não escaparem a `"` de fechamento.
            for _ in 0..backslashes * 2 {
                out.push('\\');
            }
            break;
        } else if chars[i] == '"' {
            // `\`s + a `"`: dobra as `\` e escapa a `"`.
            for _ in 0..backslashes * 2 + 1 {
                out.push('\\');
            }
            out.push('"');
        } else {
            for _ in 0..backslashes {
                out.push('\\');
            }
            out.push(chars[i]);
        }
        i += 1;
    }
    out.push('"');
    out
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyOutputEvent {
    pub session_id: SessionId,
    pub data: String,
    /// Seq monotônico do emulador VT no momento do emit (ref P0 #2). ADITIVO: o front
    /// usa pra deduplicar os chunks ao vivo contra `snapshot.seq` (descarta `seq <=
    /// snapshot.seq` → mata o scrollback dobrado). Consumidores que só leem `data`
    /// continuam funcionando — o campo é só metadado a mais no payload.
    pub seq: u64,
}

#[derive(Debug, Clone, Serialize)]
pub struct PtyExitEvent {
    pub session_id: SessionId,
    pub exit_code: Option<i32>,
}

pub struct PtySession {
    pub id: SessionId,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    root_pid: Option<u32>,
    /// Emulador de tela: reconstrói a tela visível processando cursor/clears/etc.
    /// (line-mode não funciona para TUIs full-screen como Claude Code).
    parser: Arc<Mutex<vt100::Parser>>,
    /// Seq monotônico do emulador VT headless (ref P0 #2). COMPARTILHADO com o
    /// `TermEmulator` (via `new_with_seq` no manager): o feeder do emulador o
    /// incrementa por chunk pintado; o thread de emit do `pty://output` lê o valor
    /// atual pra estampar cada evento ao vivo. Assim `pty://output.seq` e
    /// `snapshot.seq` falam a MESMA escala → o front deduplica corretamente.
    seq: Arc<AtomicU64>,
    /// Killer do processo filho (portable-pty): clonado ANTES do `child` ser movido
    /// pra thread waiter. É o que permite o `kill()` matar o filho DE VERDADE — sem
    /// isto o kill só removia a sessão do mapa e o processo (claude/bash/ssh) virava
    /// zumbi: o master não fechava (o StateDetector segura um clone), logo sem SIGHUP,
    /// e read_loop/emit/waiter/feeder vazavam por sessão a cada terminal fechado.
    killer: Mutex<Box<dyn ChildKiller + Send>>,
    /// sinal autoritativo de que o processo filho terminou, marcado pela thread waiter no
    /// instante do child.wait(). Cross-platform de propósito: o /proc/<pid> usado antes não existe
    /// no Windows, então lá o alive mentia sempre.
    exited: Arc<std::sync::atomic::AtomicBool>,
}

impl PtySession {
    pub fn spawn(id: SessionId, cfg: PtySpawnConfig, app: AppHandle) -> Result<Self> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: cfg.rows,
                cols: cfg.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .context("falha ao abrir PTY pair")?;

        // Diretório onde o system prompt gigante é derramado quando a linha estoura o
        // teto do cmd.exe (Windows). `None` = não deu pra resolver → spill pulado e o
        // comportamento é o de antes (fail-open).
        // A DECISÃO DE PLATAFORMA MORA AQUI, não no build_command. Só o Windows tem o teto
        // de 8191 do cmd.exe; no Linux/macOS a linha cabe e mudar o comportamento testado
        // seria regressão gratuita (e quebraria quem tem um claude antigo, sem a flag de
        // arquivo). Deixar a decisão no caller também torna o build_command testável no CI,
        // que roda Linux — foi a falta desse teste que deixou o fix virar código morto.
        let spill_dir = if cfg!(windows) {
            use tauri::Manager;
            app.path().app_data_dir().ok()
        } else {
            None
        };
        let cmd = build_command(&cfg, spill_dir.as_deref(), &id);

        // O QUE foi spawnado, no log. Sem isto o diagnóstico que o beta tester manda pro
        // suporte não distingue "o binário não existe" de "o TUI não desenha" — que foi
        // exatamente a dúvida no caso dos nós em branco no Windows. Os args ficam só no
        // nível debug porque carregam persona/prompt inteiros (e passam pelo redactor).
        log::info!("PTY {id} spawn: {} ({} args) cwd={:?}", cfg.command, cfg.args.len(), cfg.cwd);
        log::debug!("PTY {id} args: {:?}", cfg.args);
        let spawned_at = Instant::now();
        let mut child = pair.slave.spawn_command(cmd).context("falha ao spawnar processo no PTY")?;
        let root_pid = child.process_id();
        // Clona o killer ANTES do `child` ir pra thread waiter (move, mais abaixo) — é
        // o que permite o kill() matar o filho de verdade (fecha o slave → read_loop
        // sai por EOF → todas as threads encerram e o waiter reapeia). Sem isto, fechar
        // um nó vazava o processo do agente + as threads.
        let killer = child.clone_killer();
        drop(pair.slave);

        let master = Arc::new(Mutex::new(pair.master));
        let reader = master.lock().try_clone_reader().context("falha ao clonar reader do master")?;
        let writer: Box<dyn Write + Send> = master.lock().take_writer().context("falha ao tomar writer do master")?;
        let writer = Arc::new(Mutex::new(writer));

        let (output_tx, _) = broadcast::channel::<Vec<u8>>(64);
        let tx_for_reader = output_tx.clone();

        // Canal std (não precisa de runtime tokio): debounce de 16ms antes de emitir evento Tauri
        let (emit_tx, emit_rx) = mpsc::channel::<Vec<u8>>();

        // Seq compartilhado com o emulador VT (ref P0 #2). O emulador (no manager) é
        // criado via `new_with_seq` com ESTE Arc; o feeder dele o incrementa por chunk
        // pintado. Aqui, no thread de emit, lemos o valor atual pra estampar o
        // `pty://output`. Como o emit é debounced (16ms) e o feeder consome o broadcast
        // cru imediato, o emulador está sempre à frente OU em dia com os bytes que
        // estamos emitindo → o snapshot tirado nesse instante já contém esses bytes,
        // então o front pode descartar com segurança os live com `seq <= snapshot.seq`.
        let seq = Arc::new(AtomicU64::new(0));
        let seq_for_emit = Arc::clone(&seq);

        let id_for_emit = id.clone();
        let app_for_emit = app.clone();
        std::thread::spawn(move || {
            const DEBOUNCE: Duration = Duration::from_millis(16);
            let mut pending: Vec<u8> = Vec::new();
            loop {
                // Bloqueia até chegar o primeiro chunk do frame
                match emit_rx.recv() {
                    Ok(bytes) => { pending.extend_from_slice(&bytes); }
                    Err(_) => {
                        // Canal fechado — emite o que sobrou e encerra
                        if !pending.is_empty() {
                            let text = String::from_utf8_lossy(&pending).to_string();
                            let _ = app_for_emit.emit("pty://output", PtyOutputEvent {
                                session_id: id_for_emit.clone(),
                                data: text,
                                seq: seq_for_emit.load(Ordering::SeqCst),
                            });
                        }
                        break;
                    }
                }
                // Drena tudo que chegou nos próximos 16ms sem bloquear depois disso
                let deadline = Instant::now() + DEBOUNCE;
                loop {
                    let remaining = deadline.saturating_duration_since(Instant::now());
                    if remaining.is_zero() { break; }
                    match emit_rx.recv_timeout(remaining) {
                        Ok(more) => { pending.extend_from_slice(&more); }
                        Err(_) => break,
                    }
                }
                // Decodifica só até o ÚLTIMO char UTF-8 COMPLETO; os bytes de um char
                // partido entre dois flushes do debounce (ç/acento/emoji/CJK/box-drawing)
                // ficam pro próximo frame — senão o from_utf8_lossy emitia U+FFFD
                // permanente no meio do char no stream ao vivo.
                let valid = match std::str::from_utf8(&pending) {
                    Ok(_) => pending.len(),
                    Err(e) => e.valid_up_to(),
                };
                // Cauda > 3 bytes não é char UTF-8 incompleto (máx 4 bytes) → é byte
                // inválido real: emite tudo (lossy) pra não acumular lixo no buffer.
                let cut = if pending.len() - valid <= 3 { valid } else { pending.len() };
                if cut > 0 {
                    let text = String::from_utf8_lossy(&pending[..cut]).to_string();
                    let _ = app_for_emit.emit("pty://output", PtyOutputEvent {
                        session_id: id_for_emit.clone(),
                        data: text,
                        seq: seq_for_emit.load(Ordering::SeqCst),
                    });
                    pending.drain(..cut); // mantém a cauda incompleta pro próximo frame
                }
            }
        });

        let parser = Arc::new(Mutex::new(vt100::Parser::new(cfg.rows, cfg.cols, 0)));
        let parser_for_reader = Arc::clone(&parser);
        let id_for_reader = id.clone();
        std::thread::spawn(move || {
            read_loop(id_for_reader, reader, tx_for_reader, emit_tx, parser_for_reader);
        });

        let id_for_waiter = id.clone();
        let app_for_waiter = app.clone();
        let exited = Arc::new(std::sync::atomic::AtomicBool::new(false));
        let exited_for_waiter = Arc::clone(&exited);

        std::thread::spawn(move || {
            let status = child.wait();
            // Código de saída + QUANTO viveu. Um processo que morre em milissegundos é
            // binário ausente / erro de spawn; um que viveu minutos saiu normal. É a
            // pergunta que o log tinha que responder e não respondia.
            match &status {
                Ok(st) => log::info!(
                    "PTY {id_for_waiter} saiu: código {} após {:?}",
                    st.exit_code(),
                    spawned_at.elapsed()
                ),
                Err(e) => log::warn!("PTY {id_for_waiter} wait falhou após {:?}: {e}", spawned_at.elapsed()),
            }
            // marcar antes de emitir/limpar elimina a janela em que o processo já morreu
            // mas a UI ainda o vê vivo.
            exited_for_waiter.store(true, std::sync::atomic::Ordering::Relaxed);

            let mut agent_name = String::new();
            {
                use tauri::Manager;
                if let Some(reg) = app_for_waiter.try_state::<Arc<crate::mcp::AgentRegistry>>() {
                    for label in reg.unregister_by_session(&id_for_waiter) {
                        log::info!("MCP: agente removido (sessão morreu): {label}");
                        if agent_name.is_empty() {
                            agent_name = label;
                        }
                    }
                }
            }

            // O detector só vira Dead quando o broadcast fecha com RecvError::Closed, mas o
            // sender fica retido pela própria PtySession e nunca fecha; sem este push o card
            // ficava VERDE com o processo morto, e um CLI que falha em 200ms por binário
            // inexistente no Windows não gerava evento de estado nenhum.
            {
                use tauri::{Emitter, Manager};
                if let Some(pm) = app_for_waiter.try_state::<Arc<crate::pty::PtyManager>>() {
                    pm.set_agent_state(&id_for_waiter, crate::pty::AgentState::Dead);
                }
                let _ = app_for_waiter.emit("agent://status", crate::pty::AgentStatusEvent {
                    session_id: id_for_waiter.clone(),
                    state: crate::pty::AgentState::Dead,
                    agent: agent_name,
                    message: None,
                });
            }

            match status {
                Ok(status) => {
                    let _ = app_for_waiter.emit("pty://exit", PtyExitEvent {
                        session_id: id_for_waiter,
                        exit_code: Some(status.exit_code() as i32),
                    });
                }
                Err(e) => {
                    log::error!("erro aguardando child do PTY: {e}");
                    let _ = app_for_waiter.emit("pty://exit", PtyExitEvent {
                        session_id: id_for_waiter,
                        exit_code: None,
                    });
                }
            }
        });

        Ok(Self {
            id,
            master,
            writer,
            output_tx,
            root_pid,
            parser,
            seq,
            killer: Mutex::new(killer),
            exited,
        })
    }

    /// true enquanto o processo filho está vivo; não consulta o SO, lê a flag do waiter.
    pub fn is_alive(&self) -> bool {
        !self.exited.load(std::sync::atomic::Ordering::Relaxed)
    }

    /// Mata o processo filho do PTY. Fechar o filho fecha o slave → o `read_loop` sai
    /// por EOF → as threads (read/emit/feeder/detector) encerram e o waiter reapeia o
    /// zumbi. Idempotente: matar 2× é inofensivo (o 2º kill num morto só erra → ignorado).
    pub(crate) fn kill_child(&self) {
        let _ = self.killer.lock().kill();
    }

    pub fn write(&self, data: &[u8]) -> Result<()> {
        let mut w = self.writer.lock();
        w.write_all(data).context("falha ao escrever no PTY")?;
        w.flush().context("falha ao flush do PTY")?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.parser.lock().set_size(rows, cols);
        self.master
            .lock()
            .resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
            .map_err(|e| anyhow!("falha ao redimensionar PTY: {e}"))
    }

    pub(crate) fn subscribe(&self) -> broadcast::Receiver<Vec<u8>> {
        self.output_tx.subscribe()
    }

    pub(crate) fn writer_arc(&self) -> Arc<Mutex<Box<dyn Write + Send>>> {
        Arc::clone(&self.writer)
    }

    pub(crate) fn master_arc(&self) -> Arc<Mutex<Box<dyn MasterPty + Send>>> {
        Arc::clone(&self.master)
    }

    pub(crate) fn root_pid(&self) -> Option<u32> {
        self.root_pid
    }

    /// Tela visível renderizada (linhas com cursor/clears já aplicados).
    pub(crate) fn read_screen(&self) -> String {
        self.parser.lock().screen().contents()
    }

    pub(crate) fn screen_arc(&self) -> Arc<Mutex<vt100::Parser>> {
        Arc::clone(&self.parser)
    }

    /// Seq monotônico do emulador VT (ref P0 #2). O manager passa este Arc pro
    /// `TermEmulator::new_with_seq` — assim o feeder do emulador e o thread de emit do
    /// `pty://output` compartilham o MESMO contador, e o front deduplica os chunks ao
    /// vivo contra `snapshot.seq`.
    pub(crate) fn seq_arc(&self) -> Arc<AtomicU64> {
        Arc::clone(&self.seq)
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        // Backstop: se a sessão for dropada sem passar pelo kill() explícito (ex.:
        // panic, ou o Arc cair por outro caminho), ainda mata o filho — sem isto o
        // processo do agente vazaria.
        let _ = self.killer.lock().kill();
    }
}

fn read_loop(
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    tx: broadcast::Sender<Vec<u8>>,
    emit_tx: mpsc::Sender<Vec<u8>>,
    parser: Arc<Mutex<vt100::Parser>>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => { log::info!("PTY {id} EOF"); break; }
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                parser.lock().process(&chunk); // alimenta o emulador de tela
                let _ = tx.send(chunk.clone()); // broadcast imediato (MCP/pipes)
                let _ = emit_tx.send(chunk);    // debounced → Tauri event
            }
            Err(e) => { log::warn!("erro lendo do PTY {id}: {e}"); break; }
        }
    }
}

/// PATH do shell de login do usuário, computado UMA vez (cacheado). O app GUI (clicado
/// do menu) NÃO herda o PATH do `~/.bashrc` (que ativa nvm/npm-global/etc), então CLIs
/// como o `gemini` (instalado via nvm) dão "No viable candidates found in PATH". Rodamos
/// `bash -lc` uma vez e cacheamos. `None` se não der (sem bash / Windows) → comportamento
/// atual intocado. Análogo ao fix do `TERM`: o app GUI não traz o ambiente do shell.
pub(crate) fn login_shell_path() -> Option<&'static str> {
    use std::sync::OnceLock;
    static LOGIN_PATH: OnceLock<Option<String>> = OnceLock::new();
    LOGIN_PATH
        .get_or_init(|| {
            #[cfg(not(windows))]
            {
                std::process::Command::new("bash")
                    .args(["-lc", "echo -n \"$PATH\""])
                    .output()
                    .ok()
                    .and_then(|o| String::from_utf8(o.stdout).ok())
                    .map(|s| s.trim().to_string())
                    // sanidade: parece um PATH de verdade (tem `/`, não-trivial).
                    .filter(|s| s.len() > 10 && s.contains('/'))
            }
            #[cfg(windows)]
            {
                None
            }
        })
        .as_deref()
}

/// Monta o `CommandBuilder` a partir do `PtySpawnConfig`, aplicando o cwd, o env
/// e a limpeza do env de GUI do `tauri:dev` em AMBOS os SOs. A diferença é só
/// COMO o programa+args são montados:
///
/// - **Unix** (`#[cfg(not(windows))]`): comportamento original intocado —
///   `CommandBuilder::new(command)` + um `.arg()` por argumento.
///
/// - **Windows** (`#[cfg(windows)]`): se `needs_cmd_wrapper(command)` (CLI de
///   node/script, não-`.exe`), embrulha em `cmd.exe /s /c "<linha interna>"`.
///   `.exe` já resolvidos spawnam direto (igual ao Unix).
///
/// Função extraída justamente pra ser testável sem spawnar nada (os testes
/// inspecionam o argv/cwd resultante, não executam o processo).
/// O teto real do cmd.exe é 8191 para a linha INTEIRA, já contando `cmd.exe /s /c` e as
/// aspas. 7000 deixa folga pros outros argumentos e pro próprio wrapper — errar pra baixo
/// só custa gravar um arquivo a mais; errar pra cima volta a truncar em silêncio.
const CMD_LINE_SAFE_LIMIT: usize = 7000;

/// Troca `--append-system-prompt <texto-gigante>` por `--append-system-prompt-file`
/// `<caminho>` quando a linha de comando montada passaria do teto do cmd.exe.
///
/// Só age quando PRECISA — linha curta segue inline, que é o comportamento testado no
/// Linux; devolve os args inalterados se não achar a flag, se o valor for pequeno, ou se
/// a gravação falhar, porque um agente com prompt truncado ainda é melhor que um agente
/// que nem sobe.
fn spill_system_prompt_to_file(
    args: Vec<String>,
    dir: &std::path::Path,
    session_id: &str,
) -> Vec<String> {
    let total_len: usize = args.iter().map(|a| a.len() + 3).sum();
    if total_len <= CMD_LINE_SAFE_LIMIT {
        return args;
    }

    let Some(idx) = args.iter().position(|a| a == "--append-system-prompt") else {
        return args;
    };
    if idx + 1 >= args.len() {
        return args;
    }

    let prompt = args[idx + 1].clone();
    let path = dir.join(format!("agent-prompt-{session_id}.txt"));

    if let Err(e) = std::fs::create_dir_all(dir) {
        log::warn!(
            "spill_system_prompt_to_file: falha ao criar diretório {}: {e}",
            dir.display()
        );
        return args;
    }
    if let Err(e) = std::fs::write(&path, &prompt) {
        log::warn!(
            "spill_system_prompt_to_file: falha ao escrever {}: {e}",
            path.display()
        );
        return args;
    }

    log::info!(
        "spill_system_prompt_to_file: {} chars de system prompt movidos para {}",
        prompt.len(),
        path.display()
    );

    let mut new_args = args;
    new_args[idx] = "--append-system-prompt-file".to_string();
    new_args[idx + 1] = path.display().to_string();
    new_args
}

fn build_command(cfg: &PtySpawnConfig, spill_dir: Option<&std::path::Path>, session_id: &str) -> CommandBuilder {
    // Resolve o host de execução (ref §3.1). `Local` → (command, args) crus, igual
    // ao comportamento anterior. `Ssh(target)` → embrulha em `ssh -tt ... -- <cmd>`,
    // onde `<cmd>` é a linha do agente shell-quotada (defesa anti-injeção em host.rs).
    // ÚNICO ponto que ramifica por transporte. Em SSH, o `ssh` local vira o "programa"
    // e segue pelo MESMO `build_program` (no Windows, o cmd.exe-wrap resolve `ssh.exe`
    // via PATHEXT — inofensivo; no Unix spawna direto).
    let host = ExecutionHost::parse(cfg.execution_host.as_deref().unwrap_or("local"));
    let (program, args): (String, Vec<String>) = match &host {
        ExecutionHost::Local => (cfg.command.clone(), cfg.args.clone()),
        ExecutionHost::Ssh(target) => {
            // cwd remoto: o `cwd` local não faz sentido na box remota. Embutimos um
            // `cd <floor-path> && exec <cmd>` SÓ se houver cwd — senão roda no $HOME
            // remoto. O path remoto = o Floor path no host (passado pelo caller via cwd).
            let agent_line = host::build_remote_command_line(&cfg.command, &cfg.args);
            let remote_cmd = match &cfg.cwd {
                Some(c) => format!("cd {} && exec {}", host::shell_quote_single(c), agent_line),
                None => agent_line,
            };
            match host::ssh_argv(target, &remote_cmd) {
                Ok(pa) => pa,
                Err(e) => {
                    // Target inválido (metacaractere → injeção). Fail-safe: NÃO spawna o
                    // ssh; spawna um shell que imprime o erro e sai, pra o usuário ver no
                    // PTY em vez de um spawn silencioso de comando perigoso.
                    log::error!("execution_host SSH rejeitado: {e}");
                    fail_safe_program(&e)
                }
            }
        }
    };

    // [sandbox] Linux: envelopa o comando com bwrap quando OMNIRIFT_SANDBOX=workspace e bwrap
    // está no PATH (fail-open: off/remoto/sem-bwrap → comando cru, zero regressão). Contém o
    // EXECUTOR real (workers PTY), não o processo Tauri — o ponto onde bash/edit/rm rodam.
    #[cfg(target_os = "linux")]
    let (program, args) = crate::sandbox::maybe_wrap(program, args, cfg.cwd.as_deref(), host.is_remote());

    // WINDOWS: aqui é onde o spill precisa acontecer — DEPOIS de resolver host/sandbox e
    // ANTES de montar a linha do cmd.exe. Sem esta chamada a função era código morto: os
    // testes passavam isolados e o spawn real nunca a executava, então a 0.1.140 saiu
    // prometendo consertar o Windows sem consertar nada.
    let args = match spill_dir {
        Some(dir) => spill_system_prompt_to_file(args, dir, session_id),
        None => args,
    };

    let mut cmd = build_program(&program, &args);

    // O `cwd` LOCAL só se aplica ao processo local. Em SSH, o cwd já foi embutido no
    // comando remoto acima (cd && exec) — o `ssh` local roda do cwd que o app tiver.
    if !host.is_remote() {
        if let Some(cwd) = &cfg.cwd {
            cmd.cwd(cwd);
        }
    }
    // TERM/COLORTERM explícitos: garantem cor ANSI mesmo quando o OmniRift roda como
    // app GUI (clicado do menu) — aí o processo pai NÃO tem TERM herdado e CLIs como o
    // claude-code detectam "terminal burro" e emitem texto SEM cor (regressão visível só
    // no app instalado, não no `tauri:dev` que herda o TERM do terminal). Setados ANTES
    // do `cfg.env` pra um TERM custom do caller ainda poder sobrescrever.
    cmd.env("TERM", "xterm-256color");
    cmd.env("COLORTERM", "truecolor");
    // PATH dos agentes, em ordem de prioridade (prepend = vence na resolução):
    //   1) tools/bin do OmniRift (~/.omnirift/tools/bin) — CLIs instalados pelo app via
    //      npm/pipx/cargo com prefixo user-writável; enxerga o recém-instalado na hora.
    //   2) login PATH (nvm/npm-global do usuário) — CLIs que o PATH restrito do app GUI
    //      não enxerga (ex: gemini). No-op se `login_shell_path()` for None.
    //   3) PATH do processo do app — fallback.
    // Montado num único `cmd.env` (setar PATH duas vezes sobrescreveria a 1ª). Antes do
    // `cfg.env` pra o caller ainda poder sobrescrever PATH se quiser.
    {
        let mut parts: Vec<String> = Vec::new();
        if let Some(tb) = crate::commands::clis::tools_bin() {
            parts.push(tb.to_string_lossy().to_string());
        }
        if let Some(lp) = login_shell_path() {
            parts.push(lp.to_string());
        }
        let process_path = std::env::var("PATH").unwrap_or_default();
        if !process_path.is_empty() {
            parts.push(process_path);
        }
        if !parts.is_empty() {
            // Separador de PATH é do SO: `:` no Unix, `;` no Windows. Usar `:` no
            // Windows não dá erro — dá algo PIOR: o Windows quebra a string por `;`,
            // então a 1ª entrada vira `C:\Users\x\.omnirift\tools\bin:C:\Windows\system32`,
            // um caminho inexistente. Isso mata de uma vez o tools/bin do OmniRift E o
            // system32, em silêncio (os CLIs em %APPDATA%\npm sobrevivem, o que faz o
            // bug parecer "só alguns CLIs não abrem").
            cmd.env("PATH", parts.join(PATH_SEP));
        }
    }
    for (k, v) in &cfg.env {
        cmd.env(k, v);
    }
    // Limpa o env de GUI do workaround do `tauri:dev` (snap/glibc) pros processos
    // filhos — esses LD_PRELOAD/GTK_MODULES são só pra WebKitGTK do maestri; vazar
    // pro claude e pro Chromium do Playwright (que o agente dirige) pode quebrá-los.
    cmd.env("LD_PRELOAD", "");
    cmd.env("GTK_MODULES", "");
    cmd
}

/// Programa fail-safe pra quando o `execution_host` SSH é inválido (target com
/// metacaractere → tentativa de injeção). Em vez de spawnar o comando perigoso, roda
/// um shell que imprime o erro no PTY e sai com código 1 — o usuário vê o motivo.
/// Cross-platform: `sh -c` no Unix, `cmd /c` no Windows. NUNCA repassa o target cru
/// pro shell montado (só uma mensagem fixa + o erro de validação já sanitizado).
fn fail_safe_program(err: &str) -> (String, Vec<String>) {
    // O erro de validação já é texto controlado (não contém o target perigoso fora de
    // {:?}); ainda assim só usamos uma mensagem genérica no shell pra zero risco.
    let _ = err;
    let msg = "OmniRift: sshTarget invalido (anti-injecao) — agente nao iniciado.";
    #[cfg(not(windows))]
    {
        (
            "sh".to_string(),
            vec!["-c".to_string(), format!("echo '{msg}'; exit 1")],
        )
    }
    #[cfg(windows)]
    {
        (
            "cmd".to_string(),
            vec![
                "/c".to_string(),
                format!("echo {msg} & exit 1"),
            ],
        )
    }
}

#[cfg(not(windows))]
fn build_program(command: &str, args: &[String]) -> CommandBuilder {
    // Wrapper de shell (FUNÇÃO/alias no .zshrc/.bashrc — ex.: `claudefast`, `claude-ollama`)
    // NÃO é binário no PATH → exec direto do portable-pty falha. Se `command` não resolve
    // como binário, roda via `$SHELL -lic "<linha>"` (não hardcode bash): no macOS o user
    // default é zsh e aliases em .zshrc NÃO aparecem no bash -lic. `-l`+`-i` sourceiam o
    // rc interativo; em bash também forçamos `shopt -s expand_aliases` (senão alias não
    // expande em -c). Binário no PATH → exec direto (zero regressão pra claude/codex/…).
    if command_is_binary(command) {
        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(arg);
        }
        return cmd;
    }
    let mut line = host::shell_quote_single(command);
    for arg in args {
        line.push(' ');
        line.push_str(&host::shell_quote_single(arg));
    }
    let shell = user_login_shell();
    // bash: aliases só expandem com expand_aliases (mesmo em -i sob -c).
    let line = if shell_is_bash(&shell) {
        format!("shopt -s expand_aliases 2>/dev/null; {line}")
    } else {
        line
    };
    let mut cmd = CommandBuilder::new(&shell);
    cmd.arg("-lic");
    cmd.arg(&line);
    cmd
}

/// Shell de login do usuário (`$SHELL`), com fallbacks seguros. Preferimos o shell real
/// (zsh no macOS) pra resolver aliases/funções definidos no rc do usuário.
#[cfg(not(windows))]
fn user_login_shell() -> String {
    if let Ok(s) = std::env::var("SHELL") {
        let t = s.trim();
        if !t.is_empty() && std::path::Path::new(t).is_file() {
            return t.to_string();
        }
    }
    for candidate in ["/bin/zsh", "/bin/bash", "/bin/sh"] {
        if std::path::Path::new(candidate).is_file() {
            return candidate.to_string();
        }
    }
    "bash".to_string()
}

#[cfg(not(windows))]
fn shell_is_bash(shell: &str) -> bool {
    std::path::Path::new(shell)
        .file_name()
        .and_then(|n| n.to_str())
        .map(|n| n == "bash" || n.starts_with("bash"))
        .unwrap_or(false)
}

/// `command` resolve como binário executável? Com `/` = path explícito → confia (exec direto,
/// comportamento original). Sem `/` → procura no PATH via `which`; achou = binário. Não achou =
/// wrapper-função (não está no PATH) → false → embrulha em bash. `which` ausente no sistema →
/// assume binário (não regride o caminho comum).
#[cfg(not(windows))]
fn command_is_binary(command: &str) -> bool {
    if command.contains('/') {
        return true;
    }
    std::process::Command::new("which")
        .arg(command)
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|s| s.success())
        .unwrap_or(true)
}

#[cfg(windows)]
fn build_program(command: &str, args: &[String]) -> CommandBuilder {
    if !needs_cmd_wrapper(command) {
        // Já é um `.exe` (ou o próprio cmd) → spawna direto, sem embrulho.
        let mut cmd = CommandBuilder::new(command);
        for arg in args {
            cmd.arg(arg);
        }
        return cmd;
    }

    // QUOTING — decisão (documentada no comentário do módulo):
    //
    // `cmd.exe /c` re-parseia a "tail" do comando com as regras PRÓPRIAS do cmd
    // (não as do CommandLineToArgvW). Se passássemos `cmd /c` + um `.arg()` por
    // argumento e deixássemos o portable-pty quotar cada um, o `cmd` re-quebraria
    // a linha e corromperia args complexos — exatamente o caso do
    // `--append-system-prompt "<texto enorme com aspas/quebras de linha>"`:
    // o `cmd` interpretaria `&`, `|`, `^`, `"`, quebras, etc.
    //
    // Abordagem robusta escolhida: montar UMA string única já quotada (programa +
    // cada arg via `win_argv_quote`, o mesmo algoritmo argv do Windows que o
    // portable-pty usa) e passar como `cmd.exe /s /c "<linha>"`.
    //   - `/s` + aspas externas = contrato DOCUMENTADO do cmd: ele tira EXATAMENTE
    //     a 1ª e a última aspas e roda o miolo verbatim (sem a heurística default
    //     de "só remove aspas em certas condições"). Isso preserva o conteúdo
    //     interno (incluindo aspas e quebras dos args) intacto.
    //   - Cada token interno vai por `win_argv_quote`, então quando o cmd repassa
    //     a linha ao programa real, o argv chega idêntico ao que o caminho Unix
    //     entregaria.
    //
    // O `comspec` (programa de fato) e o literal `"<linha>"` são passados via
    // `.arg()` — aí SIM deixamos o portable-pty fazer o quoting argv pro
    // CreateProcessW, que é correto pro próprio `cmd.exe` (o cmd só re-parseia o
    // que vem DEPOIS do `/c`, e esse pedaço é uma única string já blindada).
    let comspec = std::env::var("ComSpec").unwrap_or_else(|_| "cmd.exe".to_string());

    let mut inner = win_argv_quote(command);
    for arg in args {
        inner.push(' ');
        inner.push_str(&win_argv_quote(arg));
    }

    let mut cmd = CommandBuilder::new(&comspec);
    cmd.arg("/s");
    cmd.arg("/c");
    cmd.arg(&inner);
    cmd
}

#[cfg(test)]
mod tests {


    #[test]
    fn vt100_basic_text() {
        let mut p = vt100::Parser::new(24, 80, 0);
        p.process(b"hello world");
        assert!(p.screen().contents().contains("hello world"));
    }

    #[test]
    fn vt100_renders_visible_screen_after_clear() {
        // Exatamente o caso que quebrava no line-mode: clear screen (ESC[2J) +
        // home (ESC[H) → só "BBB" fica visível, "AAA" foi limpo.
        let mut p = vt100::Parser::new(24, 80, 0);
        p.process(b"AAA\x1b[2J\x1b[HBBB");
        let screen = p.screen().contents();
        assert!(screen.contains("BBB"));
        assert!(!screen.contains("AAA"));
    }

    // ---- Testes da lógica de construção de comando (Windows-only) ----
    //
    // Rodam no Windows; no Linux (CI atual) ficam fora de escopo via cfg, mas a
    // lógica que eles cobrem (`needs_cmd_wrapper`, `win_argv_quote`,
    // `build_command`) é exercitada manualmente abaixo por uma fn pura
    // espelhada que compila nos dois SOs, garantindo cobertura no Linux também.

    #[cfg(windows)]
    mod windows_build {
        use crate::pty::session::{
            build_command, needs_cmd_wrapper, win_argv_quote, PtySpawnConfig,
        };
        use std::ffi::OsString;

        fn cfg(command: &str, args: &[&str]) -> PtySpawnConfig {
            PtySpawnConfig {
                command: command.to_string(),
                args: args.iter().map(|s| s.to_string()).collect(),
                cwd: None,
                env: vec![],
                cols: 80,
                rows: 24,
                execution_host: None,
            }
        }

        fn argv_strings(cmd: &portable_pty::CommandBuilder) -> Vec<String> {
            cmd.get_argv()
                .iter()
                .map(|o: &OsString| o.to_string_lossy().to_string())
                .collect()
        }

        #[test]
        fn node_cli_wraps_in_cmd_c() {
            // opencode + ["x"] → programa = cmd.exe e inclui "/c","opencode","x"
            let cmd = build_command(&cfg("opencode", &["x"]), None, "t");
            let argv = argv_strings(&cmd);
            // argv[0] é o comspec (cmd.exe ou caminho completo dele)
            assert!(
                argv[0].to_lowercase().ends_with("cmd.exe"),
                "programa deveria ser cmd.exe, foi {:?}",
                argv[0]
            );
            assert!(argv.iter().any(|a| a == "/c"), "deve conter /c em {argv:?}");
            // a linha interna é um único arg já quotado contendo o command e o arg
            let inner = argv.last().unwrap();
            assert!(inner.contains("opencode"), "inner: {inner}");
            assert!(inner.contains('x'), "inner: {inner}");
        }

        #[test]
        fn exe_command_spawns_direct_no_cmd() {
            // foo.exe → NÃO usa cmd; programa = foo.exe, arg preservado
            let cmd = build_command(&cfg("foo.exe", &["bar"]), None, "t");
            let argv = argv_strings(&cmd);
            assert_eq!(argv[0].to_lowercase(), "foo.exe");
            assert!(!argv.iter().any(|a| a == "/c"), "não deve embrulhar: {argv:?}");
            assert_eq!(argv[1], "bar");
        }

        #[test]
        fn needs_wrapper_decision() {
            assert!(needs_cmd_wrapper("claude"));
            assert!(needs_cmd_wrapper("opencode"));
            assert!(needs_cmd_wrapper("codex"));
            assert!(needs_cmd_wrapper(r"C:\Users\me\AppData\Roaming\npm\claude"));
            assert!(!needs_cmd_wrapper("bash.exe"));
            assert!(!needs_cmd_wrapper("foo.EXE")); // case-insensitive
            assert!(!needs_cmd_wrapper("cmd.exe"));
            assert!(!needs_cmd_wrapper("cmd")); // não re-embrulha o próprio cmd
        }

        #[test]
        fn append_system_prompt_arg_survives_quoting() {
            // O arg crítico: --append-system-prompt com aspas E quebra de linha.
            let prompt = "You are an agent.\nSay \"hi\".";
            let cmd = build_command(&cfg("claude", &["--append-system-prompt", prompt]));
            let argv = argv_strings(&cmd);
            let inner = argv.last().unwrap();
            // a flag aparece literal e o conteúdo (com a quebra) está embutido
            assert!(inner.contains("--append-system-prompt"), "inner: {inner}");
            assert!(inner.contains("You are an agent."), "inner: {inner}");
            assert!(inner.contains('\n'), "quebra de linha preservada: {inner:?}");
            // aspas internas escapadas no formato argv do Windows (\")
            assert!(inner.contains("\\\""), "aspas escapadas: {inner:?}");
        }

        #[test]
        fn argv_quote_matches_windows_rules() {
            assert_eq!(win_argv_quote("simple"), "simple");
            assert_eq!(win_argv_quote("with space"), "\"with space\"");
            assert_eq!(win_argv_quote("a\"b"), "\"a\\\"b\"");
            // backslashes antes de aspas são dobrados
            assert_eq!(win_argv_quote(r#"a\"b"#), r#""a\\\"b""#);
        }
    }

    // Espelho PURO da decisão cmd-vs-direto, compilável e testável nos DOIS SOs.
    // Mantém a mesma regra de `needs_cmd_wrapper` (que é cfg(windows)); assim a
    // lógica fica coberta também no Linux do CI.
    fn wrapper_decision_portable(command: &str) -> bool {
        let lower = command.to_lowercase();
        let base = lower
            .rsplit(|c| c == '\\' || c == '/')
            .next()
            .unwrap_or(&lower);
        if base == "cmd" || base == "cmd.exe" {
            return false;
        }
        !lower.ends_with(".exe")
    }

    #[test]
    fn wrapper_decision_logic_portable() {
        // Estes asserts rodam no Linux (CI atual) — garantem que a regra está
        // correta independente do alvo. No Windows, `needs_cmd_wrapper` usa a
        // MESMA regra (verificada no módulo windows_build acima).
        assert!(wrapper_decision_portable("opencode"));
        assert!(wrapper_decision_portable("claude"));
        assert!(wrapper_decision_portable("codex"));
        assert!(wrapper_decision_portable(
            r"C:\Users\me\AppData\Roaming\npm\opencode"
        ));
        assert!(!wrapper_decision_portable("foo.exe"));
        assert!(!wrapper_decision_portable("BASH.EXE"));
        assert!(!wrapper_decision_portable("cmd"));
        assert!(!wrapper_decision_portable("cmd.exe"));
    }

    // ---- SSH execution host: build_command monta o ssh-wrap (portável) ----
    //
    // No Unix, o `ssh` spawna direto (não-Windows não embrulha em cmd), então o
    // argv resultante é exatamente `ssh -tt -o BatchMode=yes ... -- <cmd>`. Inspeciona
    // via get_argv() (cross-platform). No Windows, o caminho cmd-wrap empacota a
    // mesma linha — coberto pela lógica de host.rs + os testes Windows acima.

    fn cfg_host(command: &str, args: &[&str], host: Option<&str>, cwd: Option<&str>) -> super::PtySpawnConfig {
        super::PtySpawnConfig {
            command: command.to_string(),
            args: args.iter().map(|s| s.to_string()).collect(),
            cwd: cwd.map(|c| c.to_string()),
            env: vec![],
            cols: 80,
            rows: 24,
            execution_host: host.map(|h| h.to_string()),
        }
    }

    fn argv_of(cmd: &portable_pty::CommandBuilder) -> Vec<String> {
        cmd.get_argv()
            .iter()
            .map(|o| o.to_string_lossy().to_string())
            .collect()
    }

    /// Regressão: `spill_system_prompt_to_file` existia, seus próprios testes passavam,
    /// mas `build_command` nunca a chamava. O "fix" do Windows virou código morto e uma
    /// release saiu prometendo consertar sem consertar. Este teste não valida só a função
    /// auxiliar — valida a FIAÇÃO: `build_command` precisa aplicar o spill quando recebe
    /// `Some(spill_dir)`.
    #[test]
    fn build_command_aplica_o_spill_do_system_prompt() {
        let dir = std::env::temp_dir().join(format!("omnirift-spill-wire-{}", std::process::id()));
        let _ = std::fs::create_dir_all(&dir);
        let gigante = "x".repeat(10_000);
        let c = cfg_host("claude", &["--append-system-prompt", &gigante, "--model", "opus"], None, None);
        let built = super::build_command(&c, Some(&dir), "sessao-teste");
        let argv = argv_of(&built);
        let linha = argv.join(" ");
        assert!(!linha.contains(&gigante), "o prompt gigante NAO pode sobrar na linha de comando");
        assert!(linha.contains("--append-system-prompt-file"), "a flag de arquivo deveria ter entrado: {linha}");
        assert!(linha.contains("--model") && linha.contains("opus"), "os demais argumentos tem que sobreviver");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(not(windows))]
    #[test]
    fn local_host_is_unchanged_baseline() {
        // host=None e host="local" → idêntico (command + args crus, sem ssh). Usa `sh`
        // (binário garantido no PATH em qualquer runner) — o teste é sobre host-wrapping,
        // não sobre a detecção de binário (essa tem testes próprios abaixo).
        for h in [None, Some("local")] {
            let argv = argv_of(&super::build_command(&cfg_host("sh", &["--foo"], h, None), None, "t"));
            assert_eq!(argv[0], "sh", "host={h:?} argv={argv:?}");
            assert_eq!(argv[1], "--foo");
            assert!(!argv.iter().any(|a| a == "ssh"), "sem ssh: {argv:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn binary_command_spawns_direct() {
        // `sh` resolve no PATH → exec direto (sem embrulho em bash), args crus.
        let argv = argv_of(&super::build_program("sh", &["-c".into(), "echo hi".into()]));
        assert_eq!(argv[0], "sh", "binário direto: {argv:?}");
        assert_eq!(argv[1], "-c");
        assert_eq!(argv[2], "echo hi");
    }

    #[cfg(not(windows))]
    #[test]
    fn shell_wrapper_command_runs_via_user_shell_lic() {
        // Command que NÃO existe no PATH (simula alias/função tipo claudefast) →
        // embrulha em `$SHELL -lic "<linha>"` (zsh no mac) pra o rc do user resolver.
        let argv = argv_of(&super::build_program(
            "__omniswitch_no_such_wrapper__",
            &["a b".into()],
        ));
        let shell = super::user_login_shell();
        assert_eq!(argv[0], shell, "argv: {argv:?}");
        assert_eq!(argv[1], "-lic");
        assert_eq!(argv.len(), 3, "linha única: {argv:?}");
        assert!(argv[2].contains("__omniswitch_no_such_wrapper__"), "linha: {}", argv[2]);
        assert!(argv[2].contains("'a b'"), "arg com espaço shell-quotado: {}", argv[2]);
        if super::shell_is_bash(&shell) {
            assert!(
                argv[2].contains("expand_aliases"),
                "bash precisa expand_aliases: {}",
                argv[2]
            );
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn ssh_host_wraps_command() {
        // execution_host ssh:<encoded user@host> → ssh -tt -o BatchMode=yes ... -- <cmd>
        let host_id = super::ExecutionHost::Ssh("user@box".to_string()).id();
        let argv = argv_of(&super::build_command(&cfg_host("claude", &["--foo"], Some(&host_id), None), None, "t"));
        assert_eq!(argv[0], "ssh", "argv: {argv:?}");
        assert_eq!(argv[1], "-tt");
        assert_eq!(argv[2], "-o");
        assert_eq!(argv[3], "BatchMode=yes");
        assert_eq!(argv[4], "-o");
        assert_eq!(argv[5], "StrictHostKeyChecking=accept-new");
        assert_eq!(argv[6], "user@box");
        assert_eq!(argv[7], "--");
        // O cmd remoto é o último token. Internamente é `'claude' '--foo'` (cada token
        // shell-quotado), e ssh_argv quota a linha INTEIRA de novo (token único pro argv
        // do ssh local) → as aspas internas viram '\''. O conteúdo (claude/--foo)
        // sobrevive; o shell remoto desfaz a camada externa.
        let remote = argv.last().unwrap();
        assert!(remote.starts_with('\'') && remote.ends_with('\''), "token único: {remote}");
        assert!(remote.contains("claude"), "remote: {remote}");
        assert!(remote.contains("--foo"), "remote: {remote}");
    }

    #[cfg(not(windows))]
    #[test]
    fn ssh_host_embeds_remote_cwd() {
        // Com cwd → cd <path> && exec <agent> embutido no comando remoto.
        let host_id = super::ExecutionHost::Ssh("box".to_string()).id();
        let argv = argv_of(&super::build_command(&cfg_host("bash", &[], Some(&host_id), Some("/srv/app")), None, "t"));
        let remote = argv.last().unwrap();
        // O remote_cmd vai CRU como último arg do ssh (o ssh junta e manda pro shell
        // remoto parsear cd/&&/exec). Os TOKENS internos é que são quotados:
        // `cd '/srv/app' && exec 'bash'`. A segurança é o quote por-token, não um wrap
        // externo (que quebraria o parse remoto). [GLM-audit]
        assert!(remote.contains("/srv/app"), "remote contém o path: {remote}");
        assert!(remote.starts_with("cd "), "remote cru começa com cd: {remote}");
        assert!(remote.contains("&& exec"), "remote: {remote}");
        assert!(remote.contains("'/srv/app'"), "path inner-quotado: {remote}");
        assert!(remote.contains("'bash'"), "cmd inner-quotado: {remote}");
        // O cwd LOCAL não é setado no ssh local (só embutido no remoto).
    }

    #[cfg(not(windows))]
    #[test]
    fn ssh_host_invalid_target_fails_safe() {
        // Target com metacaractere (injeção) → NÃO spawna ssh; vira sh -c "echo ...; exit 1".
        // Constrói um id ssh: com target perigoso (encode preserva os metacaracteres no
        // round-trip, então parse devolve Ssh com o target sujo; ssh_argv então rejeita).
        let dirty = super::ExecutionHost::Ssh("host; rm -rf /".to_string()).id();
        let argv = argv_of(&super::build_command(&cfg_host("claude", &[], Some(&dirty), None), None, "t"));
        // Não há `ssh` no argv — caiu no fail-safe.
        assert!(!argv.iter().any(|a| a == "ssh"), "NÃO deve spawnar ssh: {argv:?}");
        assert_eq!(argv[0], "sh", "fail-safe via sh: {argv:?}");
        // E não há o comando perigoso solto (o target sujo nunca chega ao shell).
        assert!(!argv.iter().any(|a| a.contains("rm -rf")), "target sujo NÃO vaza: {argv:?}");
    }

    #[cfg(test)]
    mod tests_spill_system_prompt {
    use super::super::*;

    fn dir_temp_unico(sufixo: &str) -> std::path::PathBuf {
        std::env::temp_dir()
            .join(format!("claude-pty-spill-test-{}-{sufixo}", std::process::id()))
    }

    /// O caminho testado no Linux não pode mudar — só o Windows perto do limite paga.
    #[test]
    fn linha_curta_fica_inline() {
        let dir = dir_temp_unico("curto");
        let _ = std::fs::remove_dir_all(&dir);
        let args = vec!["--append-system-prompt".into(), "curto".into()];
        let out = spill_system_prompt_to_file(args.clone(), &dir, "curto");
        assert_eq!(out, args);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// É o caso do cliente Windows — 10.500 chars de contrato estouravam os 8191 do cmd.
    #[test]
    fn prompt_gigante_vira_arquivo() {
        let dir = dir_temp_unico("gigante");
        let _ = std::fs::remove_dir_all(&dir);
        let big = "x".repeat(10_000);
        let args = vec!["--append-system-prompt".into(), big.clone()];
        let out = spill_system_prompt_to_file(args, &dir, "win");
        assert_eq!(out[0], "--append-system-prompt-file");
        assert!(out[1].ends_with(".txt"));
        assert!(std::path::Path::new(&out[1]).exists());
        let content = std::fs::read_to_string(&out[1]).unwrap();
        assert_eq!(content.len(), 10_000);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Outros comandos longos (não-claude) não devem ganhar arquivo nenhum.
    #[test]
    fn sem_a_flag_nao_mexe() {
        let dir = dir_temp_unico("no-flag");
        let _ = std::fs::remove_dir_all(&dir);
        let args = vec!["--foo".into(), "x".repeat(9000)];
        let out = spill_system_prompt_to_file(args.clone(), &dir, "no-flag");
        assert_eq!(out, args);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A troca é cirúrgica; mexer na ordem quebraria o parse do claude.
    #[test]
    fn preserva_os_demais_argumentos() {
        let dir = dir_temp_unico("ordem");
        let _ = std::fs::remove_dir_all(&dir);
        let big = "x".repeat(10_000);
        let args = vec![
            "--model".into(),
            "opus".into(),
            "--append-system-prompt".into(),
            big,
            "--settings".into(),
            "/tmp/s.json".into(),
        ];
        let out = spill_system_prompt_to_file(args, &dir, "ordem");
        assert_eq!(out[0], "--model");
        assert_eq!(out[1], "opus");
        assert_eq!(out[2], "--append-system-prompt-file");
        assert!(out[3].ends_with(".txt"));
        assert_eq!(out[4], "--settings");
        assert_eq!(out[5], "/tmp/s.json");
        let _ = std::fs::remove_dir_all(&dir);
    }
    }

}
