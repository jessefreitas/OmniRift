//! Integração OmniFS (F1+F2) — file system versionado + busca semântica pros agentes.
//!
//! O OmniFS roda como daemon único (`omnifs-mcp --daemon <store> <mount> <sock>`):
//! FUSE mount + MCP server num unix socket. Cada agente entra como CLIENTE
//! (`omnifs-mcp --connect <sock>`) — NUNCA em modo direto, porque o redb do store
//! é SINGLE-WRITER (dois processos abrindo o mesmo store corrompem o lock).
//!
//! Este módulo fornece:
//! - detecção do binário (`find_omnifs_bin`, mesmo padrão do find_sidecar do compress)
//! - resolução/health do socket (`socket_path` / `socket_alive`)
//! - cliente JSON-RPC newline-delimited mínimo sobre o socket (`call`) — o protocolo
//!   é o MCP stdio do omnifs-mcp/src/main.rs: initialize → notifications/initialized
//!   → tools/call, uma linha JSON por mensagem
//! - daemon gerenciado (`ensure_daemon`) + status (`daemon_status`) + provisão da
//!   "Pasta de Projetos OmniFS" (`provision`)
//! - guard pré-spawn (`preflight_cwd_guard`): cwd dentro do mount + daemon morto =
//!   erro claro em vez de agente nascendo num FUSE ENOTCONN
//!
//! ⚠️ `omnifs_rollback` é GLOBAL (reescreve a árvore inteira) — o server é injetado
//! nos agentes, mas a tool é bloqueada via `--disallowed-tools
//! mcp__omnifs__omnifs_rollback` (DENY_DESTRUCTIVE em agent-contract.ts): o formato
//! do agent-mcp.json não suporta filtro por-tool, só por-server.

use std::path::{Path, PathBuf};
use std::process::Child;
use std::sync::Mutex;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// Timeout de leitura das chamadas de tool (indexar/snapshot podem demorar).
const CALL_READ_TIMEOUT: Duration = Duration::from_secs(60);

/// Filho gerenciado do daemon (quando NÓS o subimos — daemon do usuário não entra
/// aqui). Mutex std const-init; envenenamento é irrelevante (só guardamos um Child).
static MANAGED: Mutex<Option<Child>> = Mutex::new(None);

fn managed_lock() -> std::sync::MutexGuard<'static, Option<Child>> {
    MANAGED.lock().unwrap_or_else(|p| p.into_inner())
}

// ── Detecção ────────────────────────────────────────────────────────────────

/// Binário `omnifs-mcp`: exe-dir (sidecar futuro) → ~/.cargo/bin → PATH.
/// Reusa o resolvedor canônico de sidecars (compress/proxy.rs) — mesma ordem.
pub fn find_omnifs_bin() -> Option<PathBuf> {
    crate::compress::find_sidecar("omnifs-mcp")
}

#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}
#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

/// Socket do daemon: `OMNIRIFT_OMNIFS_SOCK` > `$XDG_RUNTIME_DIR/omnifs.sock` >
/// `~/.omnirift/omnifs.sock` (fallback sem XDG — sessões fora de systemd).
pub fn socket_path() -> PathBuf {
    socket_path_from(
        std::env::var("OMNIRIFT_OMNIFS_SOCK").ok(),
        std::env::var("XDG_RUNTIME_DIR").ok(),
        home_dir(),
    )
}

/// Núcleo puro do [`socket_path`] (testável sem mexer em env global).
fn socket_path_from(overr: Option<String>, xdg: Option<String>, home: Option<String>) -> PathBuf {
    if let Some(o) = overr.filter(|s| !s.trim().is_empty()) {
        return PathBuf::from(o);
    }
    if let Some(x) = xdg.filter(|s| !s.trim().is_empty()) {
        return Path::new(&x).join("omnifs.sock");
    }
    let base = home.unwrap_or_else(|| ".".into());
    Path::new(&base).join(".omnirift").join("omnifs.sock")
}

/// O daemon está atendendo no socket? Connect em unix socket local é imediato
/// (aceita ou ECONNREFUSED/ENOENT) — sem handshake, só a prova de vida do listener.
#[cfg(unix)]
pub fn socket_alive(path: &Path) -> bool {
    std::os::unix::net::UnixStream::connect(path).is_ok()
}
#[cfg(not(unix))]
pub fn socket_alive(_path: &Path) -> bool {
    false // daemon usa UnixListener + FUSE — Windows fica pra fase do sidecar nativo
}

// ── Cliente JSON-RPC (newline-delimited) ────────────────────────────────────

/// Uma request JSON-RPC numa linha. `id=None` → notificação (o server não responde).
fn rpc_request(id: Option<u64>, method: &str, params: Value) -> String {
    let mut msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
    if let Some(id) = id {
        msg["id"] = json!(id);
    }
    msg.to_string()
}

/// Extrai o texto de `result.content[0].text` de uma linha de resposta do server;
/// `error.message` vira Err. É o formato exato do omnifs-mcp (tools/call).
fn parse_tool_text(line: &str) -> Result<String, String> {
    let v: Value =
        serde_json::from_str(line).map_err(|e| format!("resposta inválida do omnifs: {e}"))?;
    if let Some(err) = v.get("error") {
        let msg = err.get("message").and_then(Value::as_str).unwrap_or("erro desconhecido");
        return Err(format!("omnifs: {msg}"));
    }
    v.pointer("/result/content/0/text")
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "omnifs: resposta sem content[0].text".to_string())
}

/// Chama uma tool MCP do daemon no socket default. Bloqueante (use spawn_blocking
/// em comandos async). Usado pela UI (snapshot agora) e pela F3 (auto-snapshot).
pub fn call(tool: &str, args: Value) -> Result<String, String> {
    call_at(&socket_path(), tool, args)
}

/// [`call`] contra um socket explícito (testável com daemon fake).
#[cfg(unix)]
pub fn call_at(sock: &Path, tool: &str, args: Value) -> Result<String, String> {
    use std::io::{BufRead, BufReader, Write};
    use std::os::unix::net::UnixStream;

    let stream = UnixStream::connect(sock)
        .map_err(|e| format!("omnifs daemon não está no ar ({}): {e}", sock.display()))?;
    stream.set_read_timeout(Some(CALL_READ_TIMEOUT)).ok();
    stream.set_write_timeout(Some(Duration::from_secs(10))).ok();
    let mut reader = BufReader::new(stream.try_clone().map_err(|e| e.to_string())?);
    let mut writer = stream;

    let mut send = |line: &str| -> Result<(), String> {
        writer
            .write_all(line.as_bytes())
            .and_then(|_| writer.write_all(b"\n"))
            .and_then(|_| writer.flush())
            .map_err(|e| format!("omnifs: falha escrevendo no socket: {e}"))
    };
    let mut recv = || -> Result<String, String> {
        let mut line = String::new();
        match reader.read_line(&mut line) {
            Ok(0) => Err("omnifs: daemon fechou a conexão".into()),
            Ok(_) => Ok(line),
            Err(e) => Err(format!("omnifs: falha lendo do socket: {e}")),
        }
    };

    // Handshake MCP: o daemon aceita initialize e ignora a notificação initialized
    // (mensagem sem id não gera resposta) — ver serve_conn em omnifs-mcp/src/main.rs.
    send(&rpc_request(
        Some(1),
        "initialize",
        json!({
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": { "name": "omnirift", "version": env!("CARGO_PKG_VERSION") }
        }),
    ))?;
    let init = recv()?;
    let init_v: Value = serde_json::from_str(&init)
        .map_err(|e| format!("omnifs: initialize respondeu lixo: {e}"))?;
    if init_v.get("error").is_some() {
        return Err(format!("omnifs: initialize falhou: {init}"));
    }
    send(&rpc_request(None, "notifications/initialized", json!({})))?;

    send(&rpc_request(
        Some(2),
        "tools/call",
        json!({ "name": tool, "arguments": args }),
    ))?;
    parse_tool_text(&recv()?)
}

#[cfg(not(unix))]
pub fn call_at(_sock: &Path, _tool: &str, _args: Value) -> Result<String, String> {
    Err("OmniFS requer Linux/macOS (daemon usa unix socket + FUSE)".into())
}

// ── Config persistida (~/.omnirift/omnifs.json) ─────────────────────────────

/// Onde ficam o store e o mount que ESTE app provisionou/gerencia. Fonte do
/// `daemon_status().mount` e do guard pré-spawn — sobrevive a reinícios do app.
#[derive(Serialize, Deserialize, Clone)]
pub struct OmniFsConfig {
    pub store: String,
    pub mount: String,
}

fn config_path() -> Option<PathBuf> {
    Some(Path::new(&home_dir()?).join(".omnirift").join("omnifs.json"))
}

pub fn read_config() -> Option<OmniFsConfig> {
    let raw = std::fs::read_to_string(config_path()?).ok()?;
    serde_json::from_str(&raw).ok()
}

fn write_config(cfg: &OmniFsConfig) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "HOME indisponível".to_string())?;
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("criar ~/.omnirift: {e}"))?;
    }
    let raw = serde_json::to_string_pretty(cfg).map_err(|e| e.to_string())?;
    std::fs::write(&path, raw).map_err(|e| format!("gravar {}: {e}", path.display()))
}

// ── Daemon gerenciado + status ──────────────────────────────────────────────

/// Snapshot do estado OmniFS pra UI (Ferramentas → OmniFS + chip do rodapé) e
/// pro guard do front.
#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct DaemonStatus {
    pub bin_found: bool,
    pub bin_path: Option<String>,
    pub socket_alive: bool,
    pub socket_path: String,
    /// Mount conhecido (config provisionada) — None antes da 1ª provisão.
    pub mount: Option<String>,
    pub store: Option<String>,
    /// true = o daemon vivo é FILHO nosso (subimos via ensure_daemon); false =
    /// daemon do usuário (systemd/manual) ou nenhum.
    pub managed: bool,
    /// Tamanho do `store.redb` em bytes (1 stat — barato). None sem provisão.
    pub store_bytes: Option<u64>,
    /// du do `backing/` com CAP de entradas — None = inexistente OU grande demais
    /// pro status barato (a UI mostra só o path nesse caso).
    pub backing_bytes: Option<u64>,
    pub backing_path: Option<String>,
}

/// Tamanho de um arquivo em bytes (None se não existe / erro).
fn file_size(p: &Path) -> Option<u64> {
    std::fs::metadata(p).ok().filter(|m| m.is_file()).map(|m| m.len())
}

/// du recursivo LIMITADO: soma os arquivos até `max_entries`; estourou o cap →
/// None (o backing pode ter dezenas de milhares de arquivos — o status do chip
/// roda a cada 30s e não pode virar um du caro). Sem symlink-follow.
fn dir_size_bounded(root: &Path, max_entries: usize) -> Option<u64> {
    let mut total: u64 = 0;
    let mut seen: usize = 0;
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let entries = std::fs::read_dir(&dir).ok()?;
        for entry in entries.flatten() {
            seen += 1;
            if seen > max_entries {
                return None;
            }
            let Ok(meta) = entry.metadata() else { continue };
            if meta.is_dir() {
                stack.push(entry.path());
            } else if meta.is_file() {
                total += meta.len();
            }
        }
    }
    Some(total)
}

/// Estado atual: binário, socket, mount conhecido, tamanhos e se é gerenciado.
pub fn daemon_status() -> DaemonStatus {
    let sock = socket_path();
    let bin = find_omnifs_bin();
    let cfg = read_config();
    let managed = {
        let mut g = managed_lock();
        match g.as_mut() {
            // try_wait() = Some(status) → morreu; None → segue vivo.
            Some(child) => child.try_wait().map(|st| st.is_none()).unwrap_or(false),
            None => false,
        }
    };
    // Layout do repo_dir do daemon (omnifs-mcp/src/main.rs): <store>/store.redb
    // + <store>/backing/. store.redb = 1 stat; backing = du com cap 20k entradas.
    let (store_bytes, backing_bytes, backing_path) = match cfg.as_ref() {
        Some(c) => {
            let repo = Path::new(&c.store);
            let backing = repo.join("backing");
            (
                file_size(&repo.join("store.redb")),
                dir_size_bounded(&backing, 20_000),
                Some(backing.to_string_lossy().into_owned()),
            )
        }
        None => (None, None, None),
    };
    DaemonStatus {
        bin_found: bin.is_some(),
        bin_path: bin.map(|p| p.to_string_lossy().into_owned()),
        socket_alive: socket_alive(&sock),
        socket_path: sock.to_string_lossy().into_owned(),
        mount: cfg.as_ref().map(|c| c.mount.clone()),
        store: cfg.map(|c| c.store),
        managed,
        store_bytes,
        backing_bytes,
        backing_path,
    }
}

/// Garante um daemon atendendo em `sock`:
/// - socket vivo → no-op (respeita daemon do usuário — systemd/manual);
/// - senão spawna `omnifs-mcp --daemon <store> <mount> <sock>` (NoWindow no
///   Windows via proc_ext) e espera o socket subir (~5s de retry).
///
/// ⚠️ redb SINGLE-WRITER: se o filho gerenciado anterior ainda está vivo mas o
/// socket não responde, NÃO spawna um segundo daemon no mesmo store — erro claro.
#[cfg(unix)]
pub fn ensure_daemon(store: &Path, mount: &Path, sock: &Path) -> Result<(), String> {
    use crate::proc_ext::NoWindow;
    use std::process::{Command, Stdio};
    use std::time::Instant;

    if socket_alive(sock) {
        return Ok(());
    }

    {
        let mut g = managed_lock();
        if let Some(child) = g.as_mut() {
            if child.try_wait().map(|st| st.is_none()).unwrap_or(false) {
                return Err(
                    "o daemon OmniFS gerenciado está rodando mas o socket não responde — \
                     veja ~/.omnirift/omnifs-daemon.log"
                        .into(),
                );
            }
            *g = None; // filho morto: colhido pelo try_wait; libera pra re-spawnar
        }
    }

    let bin = find_omnifs_bin().ok_or_else(|| {
        "binário `omnifs-mcp` não encontrado — compile o OmniFS e copie pra ~/.cargo/bin"
            .to_string()
    })?;
    std::fs::create_dir_all(store).map_err(|e| format!("criar store {}: {e}", store.display()))?;
    std::fs::create_dir_all(mount).map_err(|e| format!("criar mount {}: {e}", mount.display()))?;
    if let Some(dir) = sock.parent() {
        std::fs::create_dir_all(dir).ok();
    }

    // stderr do daemon → ~/.omnirift/omnifs-daemon.log (o daemon loga tudo no
    // stderr; sem isto o diagnóstico de "não subiu" seria cego).
    let stderr = home_dir()
        .map(|h| Path::new(&h).join(".omnirift").join("omnifs-daemon.log"))
        .and_then(|p| {
            std::fs::create_dir_all(p.parent()?).ok()?;
            std::fs::OpenOptions::new().create(true).append(true).open(p).ok()
        })
        .map(Stdio::from)
        .unwrap_or_else(Stdio::null);

    let child = Command::new(&bin)
        .arg("--daemon")
        .arg(store)
        .arg(mount)
        .arg(sock)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(stderr)
        .no_window()
        .spawn()
        .map_err(|e| format!("spawn omnifs-mcp --daemon: {e}"))?;
    log::info!(
        "omnifs: daemon gerenciado (pid {}) — store {}, mount {}, sock {}",
        child.id(),
        store.display(),
        mount.display(),
        sock.display()
    );
    *managed_lock() = Some(child);

    // O bind do socket acontece DEPOIS do mount FUSE — dá um tempo de boot.
    let deadline = Instant::now() + Duration::from_secs(5);
    while Instant::now() < deadline {
        if socket_alive(sock) {
            return Ok(());
        }
        std::thread::sleep(Duration::from_millis(200));
    }

    // Timeout: se o filho já morreu, colhe e devolve a dica certa.
    let mut g = managed_lock();
    if let Some(child) = g.as_mut() {
        if let Ok(Some(st)) = child.try_wait() {
            *g = None;
            return Err(format!(
                "daemon OmniFS terminou ao subir ({st}) — fuse3 instalado? \
                 veja ~/.omnirift/omnifs-daemon.log"
            ));
        }
    }
    Err("daemon OmniFS não respondeu no socket em 5s — veja ~/.omnirift/omnifs-daemon.log".into())
}

#[cfg(not(unix))]
pub fn ensure_daemon(_store: &Path, _mount: &Path, _sock: &Path) -> Result<(), String> {
    Err("OmniFS requer Linux/macOS (daemon usa unix socket + FUSE)".into())
}

/// Provisiona a "Pasta de Projetos OmniFS": store `~/.omnirift/omnifs-drive` +
/// mount (default `~/OmniRift/Projetos`), grava a config e sobe/reusa o daemon.
pub fn provision(mount_dir: Option<String>) -> Result<DaemonStatus, String> {
    let home = home_dir().ok_or_else(|| "HOME indisponível".to_string())?;
    let store = Path::new(&home).join(".omnirift").join("omnifs-drive");
    let mount = match mount_dir.filter(|s| !s.trim().is_empty()) {
        Some(m) => PathBuf::from(m),
        None => Path::new(&home).join("OmniRift").join("Projetos"),
    };
    let sock = socket_path();

    write_config(&OmniFsConfig {
        store: store.to_string_lossy().into_owned(),
        mount: mount.to_string_lossy().into_owned(),
    })?;
    ensure_daemon(&store, &mount, &sock)?;
    Ok(daemon_status())
}

// ── Snapshots: ledger local + timeline + restauração ────────────────────────
//
// O MCP do daemon devolve no `omnifs_log` só o hash CURTO (12 chars), mas o
// `omnifs_rollback` exige o hash COMPLETO (64 hex). Sem depender de mudanças no
// daemon, guardamos um LEDGER local (~/.omnirift/omnifs-snapshots.json) com o
// hash cheio de cada snapshot tirado PELO OmniRift (o `omnifs_snapshot` devolve
// "snapshot: <hex-completo>"). A timeline casa log↔ledger por prefixo; item sem
// match só restaura colando o hash completo (confirmação humana em 2 passos na UI).

/// Snapshot tirado pelo OmniRift — hash COMPLETO + mensagem + epoch-secs.
#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotLedgerEntry {
    pub hash: String,
    pub message: String,
    pub at: u64,
}

fn ledger_path() -> Option<PathBuf> {
    Some(Path::new(&home_dir()?).join(".omnirift").join("omnifs-snapshots.json"))
}

pub fn read_ledger() -> Vec<SnapshotLedgerEntry> {
    ledger_path()
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|raw| serde_json::from_str(&raw).ok())
        .unwrap_or_default()
}

/// Anexa um snapshot ao ledger (cap 500 — mais velhos caem). Falha silenciosa:
/// o ledger é conveniência (sem ele ainda dá pra restaurar colando o hash).
fn record_snapshot(hash: &str, message: &str) {
    let Some(path) = ledger_path() else { return };
    let mut all = read_ledger();
    let at = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    all.push(SnapshotLedgerEntry { hash: hash.to_string(), message: message.to_string(), at });
    if all.len() > 500 {
        let drop_n = all.len() - 500;
        all.drain(..drop_n);
    }
    if let Some(dir) = path.parent() {
        let _ = std::fs::create_dir_all(dir);
    }
    if let Ok(raw) = serde_json::to_string(&all) {
        let _ = std::fs::write(&path, raw);
    }
}

/// Hash completo de commit do OmniFS: 64 chars hex (blake3).
pub fn is_full_hash(s: &str) -> bool {
    s.len() == 64 && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// Item da timeline de snapshots pra UI: hash curto (12), mensagem e — quando o
/// ledger local conhece — o hash COMPLETO (habilita "Restaurar…" sem colar nada).
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LogEntry {
    pub short: String,
    pub message: String,
    pub full_hash: Option<String>,
    /// epoch-secs do ledger (só p/ snapshots tirados pelo OmniRift).
    pub at: Option<u64>,
}

/// Parseia o texto do `omnifs_log` ("{short-12}  {mensagem}" por linha).
fn parse_log_text(text: &str) -> Vec<(String, String)> {
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| match l.split_once("  ") {
            Some((short, msg)) => (short.trim().to_string(), msg.to_string()),
            None => (l.trim().to_string(), String::new()),
        })
        .collect()
}

/// Casa cada linha do log com o ledger por PREFIXO do hash (o log só tem 12 chars).
fn attach_full_hashes(rows: Vec<(String, String)>, ledger: &[SnapshotLedgerEntry]) -> Vec<LogEntry> {
    rows.into_iter()
        .map(|(short, message)| {
            let hit = ledger.iter().rev().find(|e| e.hash.starts_with(&short));
            LogEntry {
                short,
                message,
                full_hash: hit.map(|e| e.hash.clone()),
                at: hit.map(|e| e.at),
            }
        })
        .collect()
}

/// Timeline de snapshots (mais recente primeiro) — `omnifs_log` + ledger local.
pub fn snapshot_log() -> Result<Vec<LogEntry>, String> {
    let text = call("omnifs_log", json!({}))?;
    Ok(attach_full_hashes(parse_log_text(&text), &read_ledger()))
}

/// Tira um snapshot AGORA e registra o hash completo no ledger local.
pub fn snapshot_now(message: &str) -> Result<String, String> {
    let out = call("omnifs_snapshot", json!({ "message": message }))?;
    if let Some(hex) = out.strip_prefix("snapshot: ").map(str::trim) {
        if is_full_hash(hex) {
            record_snapshot(hex, message);
        }
    }
    Ok(out)
}

/// Restaura o drive INTEIRO pra um commit — GLOBAL e destrutivo (apaga o que não
/// está em snapshot). SÓ a UI humana chama (confirmação em 2 passos no OmniFsModal);
/// os agentes têm a tool bloqueada via DENY_DESTRUCTIVE. Exige o hash COMPLETO
/// (o daemon rejeita hash curto — from_hex exige 64 chars).
pub fn rollback_full(commit: &str) -> Result<String, String> {
    let commit = commit.trim();
    if !is_full_hash(commit) {
        return Err("hash de restauração inválido — cole o hash COMPLETO (64 chars hex)".into());
    }
    call("omnifs_rollback", json!({ "commit": commit }))
}

// ── Guard pré-spawn (F2 item 7) ─────────────────────────────────────────────

/// O `cwd` está dentro do `mount`? Componente-a-componente (Path::starts_with),
/// não prefixo de string — `/home/x/Proj2` NÃO está dentro de `/home/x/Proj`.
fn cwd_inside_mount(cwd: &str, mount: &str) -> bool {
    !mount.trim().is_empty() && Path::new(cwd).starts_with(Path::new(mount))
}

/// Health-check pré-spawn: cwd dentro do mount OmniFS conhecido + daemon morto →
/// Err com aviso claro (o nó mostra a mensagem) em vez de spawnar um agente num
/// FUSE desconectado (todo IO daria ENOTCONN).
///
/// Ponto de menor invasão (documentado): chamado nos COMANDOS `pty_spawn` e
/// `acp_spawn` (Rust) — 1 choke-point cobre Sidebar, restore de projeto, pipeline,
/// orquestrador-UI e mobile sem tocar no front. Custo por spawn: 1 leitura de JSON
/// pequeno (`~/.omnirift/omnifs.json`) + 1 connect de socket local, e SÓ quando o
/// cwd bate no prefixo do mount.
pub fn preflight_cwd_guard(cwd: Option<&str>) -> Result<(), String> {
    let Some(cwd) = cwd else { return Ok(()) };
    let Some(cfg) = read_config() else { return Ok(()) };
    if !cwd_inside_mount(cwd, &cfg.mount) {
        return Ok(());
    }
    if socket_alive(&socket_path()) {
        return Ok(());
    }
    Err(format!(
        "OmniFS: a pasta {cwd} está no drive OmniFS ({mount}), mas o daemon não está no ar — \
         os arquivos ficariam inacessíveis (ENOTCONN). Abra Ferramentas → \"OmniFS — Pasta de \
         agentes\" e clique em \"Criar minha Pasta de Projetos OmniFS\" pra religar o daemon, \
         depois inicie o agente de novo.",
        mount = cfg.mount
    ))
}

// ── Testes ──────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn socket_path_prefere_env_override() {
        let p = socket_path_from(
            Some("/tmp/meu.sock".into()),
            Some("/run/user/1000".into()),
            Some("/home/x".into()),
        );
        assert_eq!(p, PathBuf::from("/tmp/meu.sock"));
    }

    #[test]
    fn socket_path_usa_xdg_runtime_dir() {
        let p = socket_path_from(None, Some("/run/user/1000".into()), Some("/home/x".into()));
        assert_eq!(p, PathBuf::from("/run/user/1000/omnifs.sock"));
    }

    #[test]
    fn socket_path_fallback_home_sem_xdg() {
        let p = socket_path_from(None, None, Some("/home/x".into()));
        assert_eq!(p, PathBuf::from("/home/x/.omnirift/omnifs.sock"));
        // Override vazio = ignorado (env setada mas em branco não conta).
        let p2 = socket_path_from(Some("  ".into()), Some(String::new()), Some("/home/x".into()));
        assert_eq!(p2, PathBuf::from("/home/x/.omnirift/omnifs.sock"));
    }

    #[test]
    fn rpc_request_com_e_sem_id() {
        let req: Value = serde_json::from_str(&rpc_request(
            Some(7),
            "tools/call",
            json!({ "name": "omnifs_log" }),
        ))
        .unwrap();
        assert_eq!(req["jsonrpc"], "2.0");
        assert_eq!(req["id"], 7);
        assert_eq!(req["method"], "tools/call");
        assert_eq!(req["params"]["name"], "omnifs_log");

        let notif: Value =
            serde_json::from_str(&rpc_request(None, "notifications/initialized", json!({})))
                .unwrap();
        assert!(notif.get("id").is_none(), "notificação não leva id");
        // Uma linha só (newline-delimited): o corpo não pode conter '\n'.
        assert!(!rpc_request(Some(1), "initialize", json!({})).contains('\n'));
    }

    #[test]
    fn parse_tool_text_result_ok() {
        let line = r#"{"jsonrpc":"2.0","id":2,"result":{"content":[{"type":"text","text":"snapshot: abc123"}]}}"#;
        assert_eq!(parse_tool_text(line).unwrap(), "snapshot: abc123");
    }

    #[test]
    fn parse_tool_text_erro_e_lixo() {
        let err = r#"{"jsonrpc":"2.0","id":2,"error":{"code":-32603,"message":"boom"}}"#;
        assert!(parse_tool_text(err).unwrap_err().contains("boom"));
        assert!(parse_tool_text("not-json").is_err());
        let sem_texto = r#"{"jsonrpc":"2.0","id":2,"result":{"content":[]}}"#;
        assert!(parse_tool_text(sem_texto).is_err());
    }

    #[test]
    fn parse_log_text_linhas_do_daemon() {
        let text = "859f3c2a1b2c  fix: auth pronto\nab12cd34ef56  primeira versão\n\n";
        let rows = parse_log_text(text);
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0], ("859f3c2a1b2c".to_string(), "fix: auth pronto".to_string()));
        assert_eq!(rows[1].0, "ab12cd34ef56");
        // Linha sem separador (defensivo) vira short sem mensagem.
        assert_eq!(parse_log_text("soemhash")[0], ("soemhash".to_string(), String::new()));
        assert!(parse_log_text("").is_empty());
    }

    #[test]
    fn attach_full_hashes_casa_por_prefixo() {
        let full_a = format!("{}{}", "859f3c2a1b2c", "0".repeat(52));
        let ledger = vec![SnapshotLedgerEntry { hash: full_a.clone(), message: "m".into(), at: 42 }];
        let rows = vec![
            ("859f3c2a1b2c".to_string(), "com ledger".to_string()),
            ("ffffffffffff".to_string(), "sem ledger".to_string()),
        ];
        let out = attach_full_hashes(rows, &ledger);
        assert_eq!(out[0].full_hash.as_deref(), Some(full_a.as_str()));
        assert_eq!(out[0].at, Some(42));
        assert!(out[1].full_hash.is_none());
    }

    #[test]
    fn is_full_hash_valida_64_hex() {
        assert!(is_full_hash(&"a".repeat(64)));
        assert!(!is_full_hash(&"a".repeat(63)));
        assert!(!is_full_hash(&"g".repeat(64)));
        assert!(!is_full_hash("859f3c2a1b2c")); // short de 12 NÃO restaura
    }

    #[test]
    fn dir_size_bounded_soma_e_respeita_cap() {
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.txt"), b"12345").unwrap();
        std::fs::create_dir(dir.path().join("sub")).unwrap();
        std::fs::write(dir.path().join("sub/b.txt"), b"123").unwrap();
        assert_eq!(dir_size_bounded(dir.path(), 100), Some(8));
        // Cap estourado (3 entradas: a.txt, sub, sub/b.txt) → None, não trava.
        assert_eq!(dir_size_bounded(dir.path(), 2), None);
        assert_eq!(dir_size_bounded(&dir.path().join("nao-existe"), 10), None);
    }

    #[test]
    fn cwd_inside_mount_e_por_componente() {
        assert!(cwd_inside_mount("/home/x/OmniRift/Projetos/app", "/home/x/OmniRift/Projetos"));
        assert!(cwd_inside_mount("/home/x/OmniRift/Projetos", "/home/x/OmniRift/Projetos"));
        // Prefixo de STRING não conta — só componente inteiro.
        assert!(!cwd_inside_mount("/home/x/OmniRift/Projetos2", "/home/x/OmniRift/Projetos"));
        assert!(!cwd_inside_mount("/home/x/outra", "/home/x/OmniRift/Projetos"));
        assert!(!cwd_inside_mount("/home/x/qualquer", ""));
    }

    /// Integração do cliente contra um daemon FAKE que fala o protocolo exato do
    /// omnifs-mcp (newline-delimited JSON-RPC; notificação sem resposta).
    #[cfg(unix)]
    #[test]
    fn call_at_fala_o_protocolo_do_daemon() {
        use std::io::{BufRead, BufReader, Write};
        use std::os::unix::net::UnixListener;

        let dir = tempfile::tempdir().unwrap();
        let sock = dir.path().join("omnifs.sock");
        let listener = UnixListener::bind(&sock).unwrap();

        // Aceita conexões em LOOP (o socket_alive abaixo abre-e-fecha uma antes do
        // call_at) — cada conexão é servida como o serve_conn real. A thread fica
        // presa no accept ao final do teste; detached, não segura o processo.
        let server = std::thread::spawn(move || {
            for stream in listener.incoming() {
                let stream = match stream {
                    Ok(s) => s,
                    Err(_) => return,
                };
                let reader = BufReader::new(stream.try_clone().unwrap());
                let mut writer = stream;
                for line in reader.lines() {
                    let Ok(line) = line else { break };
                    if line.trim().is_empty() {
                        continue;
                    }
                    let req: Value = serde_json::from_str(&line).unwrap();
                    let id = req.get("id").cloned();
                    let method = req.get("method").and_then(Value::as_str).unwrap_or("");
                    // Notificação (sem id) → sem resposta, igual ao serve_conn real.
                    let Some(id) = id else { continue };
                    let result = match method {
                        "initialize" => json!({ "protocolVersion": "2024-11-05",
                            "capabilities": { "tools": {} },
                            "serverInfo": { "name": "omnifs", "version": "0.0.1" } }),
                        "tools/call" => {
                            let name = req.pointer("/params/name").and_then(Value::as_str);
                            assert_eq!(name, Some("omnifs_snapshot"));
                            let msg = req
                                .pointer("/params/arguments/message")
                                .and_then(Value::as_str)
                                .unwrap_or("");
                            json!({ "content": [{ "type": "text",
                                "text": format!("snapshot: deadbeef ({msg})") }] })
                        }
                        _ => panic!("método inesperado: {method}"),
                    };
                    let resp = json!({ "jsonrpc": "2.0", "id": id, "result": result });
                    writeln!(writer, "{resp}").unwrap();
                    writer.flush().unwrap();
                }
            }
        });

        assert!(socket_alive(&sock), "socket do fake daemon deve responder");
        let out = call_at(&sock, "omnifs_snapshot", json!({ "message": "teste" })).unwrap();
        assert_eq!(out, "snapshot: deadbeef (teste)");
        drop(server); // detach: a thread morre com o processo do teste
        assert!(!socket_alive(dir.path().join("nao-existe.sock").as_path()));
    }
}
