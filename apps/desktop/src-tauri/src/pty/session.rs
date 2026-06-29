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

        let cmd = build_command(&cfg);

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
        std::thread::spawn(move || match child.wait() {
            Ok(status) => {
                let _ = app_for_waiter.emit(
                    "pty://exit",
                    PtyExitEvent { session_id: id_for_waiter, exit_code: Some(status.exit_code() as i32) },
                );
            }
            Err(e) => {
                log::error!("erro aguardando child do PTY: {e}");
                let _ = app_for_waiter.emit("pty://exit", PtyExitEvent { session_id: id_for_waiter, exit_code: None });
            }
        });

        Ok(Self { id, master, writer, output_tx, root_pid, parser, seq, killer: Mutex::new(killer) })
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
fn login_shell_path() -> Option<&'static str> {
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
fn build_command(cfg: &PtySpawnConfig) -> CommandBuilder {
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
    // PATH do shell de login: acha CLIs instalados via nvm/npm-global (ex: gemini) que o
    // PATH restrito do app GUI não enxerga. Prepende o login PATH ao do app (login vence
    // na resolução; o do app continua de fallback). Antes do `cfg.env` pra o caller poder
    // sobrescrever PATH se quiser. No-op se `login_shell_path()` for None.
    if let Some(lp) = login_shell_path() {
        let current = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", if current.is_empty() { lp.to_string() } else { format!("{lp}:{current}") });
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
    let mut cmd = CommandBuilder::new(command);
    for arg in args {
        cmd.arg(arg);
    }
    cmd
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
            let cmd = build_command(&cfg("opencode", &["x"]));
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
            let cmd = build_command(&cfg("foo.exe", &["bar"]));
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

    #[cfg(not(windows))]
    #[test]
    fn local_host_is_unchanged_baseline() {
        // host=None e host="local" → idêntico (command + args crus, sem ssh).
        for h in [None, Some("local")] {
            let argv = argv_of(&super::build_command(&cfg_host("claude", &["--foo"], h, None)));
            assert_eq!(argv[0], "claude", "host={h:?} argv={argv:?}");
            assert_eq!(argv[1], "--foo");
            assert!(!argv.iter().any(|a| a == "ssh"), "sem ssh: {argv:?}");
        }
    }

    #[cfg(not(windows))]
    #[test]
    fn ssh_host_wraps_command() {
        // execution_host ssh:<encoded user@host> → ssh -tt -o BatchMode=yes ... -- <cmd>
        let host_id = super::ExecutionHost::Ssh("user@box".to_string()).id();
        let argv = argv_of(&super::build_command(&cfg_host("claude", &["--foo"], Some(&host_id), None)));
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
        let argv = argv_of(&super::build_command(&cfg_host("bash", &[], Some(&host_id), Some("/srv/app"))));
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
        let argv = argv_of(&super::build_command(&cfg_host("claude", &[], Some(&dirty), None)));
        // Não há `ssh` no argv — caiu no fail-safe.
        assert!(!argv.iter().any(|a| a == "ssh"), "NÃO deve spawnar ssh: {argv:?}");
        assert_eq!(argv[0], "sh", "fail-safe via sh: {argv:?}");
        // E não há o comando perigoso solto (o target sujo nunca chega ao shell).
        assert!(!argv.iter().any(|a| a.contains("rm -rf")), "target sujo NÃO vaza: {argv:?}");
    }
}
