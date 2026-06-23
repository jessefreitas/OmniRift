# API de Orquestração (herdr) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expor 8 tools MCP equivalentes ao surface socket do herdr (terminal_list/read/send_text/run/send_keys/wait_status/wait_output/spawn), consumindo o motor de estado do Sub-projeto A.

**Architecture:** Tools novas num módulo `mcp/tools.rs` (helpers puros testáveis + `terminal_dispatch`), despachadas pelo `mcp/server.rs` existente. Backend ganha scrollback ring buffer (pra `terminal_read`) e `terminal_spawn` cria o nó via evento Tauri `canvas://spawn-request` + ack `pty://ready`. Reusa `pty::text`, `agent_state()`/`subscribe_state()` (A) e `subscribe_by_id()`.

**Tech Stack:** Rust (axum/JSON-RPC, tokio, tauri Listener/Emitter, regex), React 19 + TS, Tauri 2.11.

**Spec:** `docs/superpowers/specs/2026-06-12-herdr-orchestration-api-design.md`

> Verificação: Rust → `cd apps/desktop/src-tauri && cargo test --lib <filtro>` / `cargo build`. Frontend → `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0` (o `npm run build` tem quebra **pré-existente** de tooling — esbuild/vite8 + baseUrl deprecado — não usar). Esperado no tsc: os mesmos erros pré-existentes em Canvas/Sidebar/TerminalNode/workspace-client e **nenhum novo** nos arquivos tocados.

---

## File Structure

**Criar:**
- `apps/desktop/src-tauri/src/mcp/tools.rs` — helpers puros (`keys_to_bytes`, `output_matches`), `terminal_tool_defs()`, `terminal_dispatch()`.
- `apps/desktop/src/lib/orchestration-client.ts` — listener de `canvas://spawn-request`.

**Modificar:**
- `apps/desktop/src-tauri/src/pty/session.rs` — scrollback ring buffer + `read_scrollback()`.
- `apps/desktop/src-tauri/src/pty/manager.rs` — `read_scrollback(id)`.
- `apps/desktop/src-tauri/src/mcp/server.rs` — `McpState` fields `pub(crate)` + `app`; `tools/list` estende `terminal_tool_defs()`; `dispatch_tool` delega `terminal_*`.
- `apps/desktop/src-tauri/src/mcp/mod.rs` — `pub mod tools;`.
- `apps/desktop/src-tauri/src/lib.rs` — `mcp_router(pm, ar, app)`.
- `apps/desktop/src/store/canvas-store.ts` — `addTerminal` aceita `id?`.
- `apps/desktop/src/hooks/useTerminalSession.ts` — emite `pty://ready { id }` ao ficar `ready`.
- `apps/desktop/src/App.tsx` — registra o listener de orquestração no boot.

---

## Task 1: Scrollback ring buffer (`session.rs` + `manager.rs`)

**Files:**
- Modify: `apps/desktop/src-tauri/src/pty/session.rs`
- Modify: `apps/desktop/src-tauri/src/pty/manager.rs`

- [ ] **Step 1: Teste do helper de capacidade (puro)**

No fim de `apps/desktop/src-tauri/src/pty/session.rs`, adicione:

```rust
#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::VecDeque;

    #[test]
    fn push_capped_trims_from_front() {
        let mut b: VecDeque<u8> = VecDeque::new();
        push_capped(&mut b, b"abcdef", 4);
        assert_eq!(b.iter().copied().collect::<Vec<u8>>(), b"cdef");
    }

    #[test]
    fn push_capped_under_cap_keeps_all() {
        let mut b: VecDeque<u8> = VecDeque::new();
        push_capped(&mut b, b"hi", 8);
        assert_eq!(b.iter().copied().collect::<Vec<u8>>(), b"hi");
    }
}
```

- [ ] **Step 2: Rodar e ver falhar**

Run: `cd apps/desktop/src-tauri && cargo test --lib session::`
Expected: FAIL — `cannot find function push_capped`.

- [ ] **Step 3: Implementar o helper + campo + alimentação + acessor**

Em `apps/desktop/src-tauri/src/pty/session.rs`:

(a) Ajuste os imports do topo para incluir `VecDeque`:

```rust
use std::collections::VecDeque;
```

(b) Adicione a constante e o helper logo abaixo de `fn default_rows()`:

```rust
const SCROLLBACK_CAP: usize = 32768;

/// Empurra `chunk` no buffer e descarta do início até caber em `cap`.
fn push_capped(buf: &mut VecDeque<u8>, chunk: &[u8], cap: usize) {
    buf.extend(chunk.iter().copied());
    while buf.len() > cap {
        buf.pop_front();
    }
}
```

(c) Adicione o campo na struct `PtySession`:

```rust
pub struct PtySession {
    pub id: SessionId,
    master: Arc<Mutex<Box<dyn MasterPty + Send>>>,
    writer: Arc<Mutex<Box<dyn Write + Send>>>,
    output_tx: broadcast::Sender<Vec<u8>>,
    root_pid: Option<u32>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
}
```

(d) No `spawn`, crie o buffer antes da thread do reader e passe um clone pro `read_loop`. Onde hoje está:

```rust
        let id_for_reader = id.clone();
        std::thread::spawn(move || {
            read_loop(id_for_reader, reader, tx_for_reader, emit_tx);
        });
```

substitua por:

```rust
        let scrollback = Arc::new(Mutex::new(VecDeque::<u8>::new()));
        let scrollback_for_reader = Arc::clone(&scrollback);
        let id_for_reader = id.clone();
        std::thread::spawn(move || {
            read_loop(id_for_reader, reader, tx_for_reader, emit_tx, scrollback_for_reader);
        });
```

(e) Inclua `scrollback` no retorno `Ok(Self { ... })`:

```rust
        Ok(Self { id, master, writer, output_tx, root_pid, scrollback })
```

(f) Adicione o acessor no `impl PtySession` (junto de `root_pid`):

```rust
    pub(crate) fn read_scrollback(&self) -> Vec<u8> {
        self.scrollback.lock().iter().copied().collect()
    }
```

(g) Atualize a assinatura e o corpo de `read_loop` para alimentar o scrollback:

```rust
fn read_loop(
    id: SessionId,
    mut reader: Box<dyn Read + Send>,
    tx: broadcast::Sender<Vec<u8>>,
    emit_tx: mpsc::Sender<Vec<u8>>,
    scrollback: Arc<Mutex<VecDeque<u8>>>,
) {
    let mut buf = [0u8; 4096];
    loop {
        match reader.read(&mut buf) {
            Ok(0) => { log::info!("PTY {id} EOF"); break; }
            Ok(n) => {
                let chunk = buf[..n].to_vec();
                push_capped(&mut scrollback.lock(), &chunk, SCROLLBACK_CAP);
                let _ = tx.send(chunk.clone());
                let _ = emit_tx.send(chunk);
            }
            Err(e) => { log::warn!("erro lendo do PTY {id}: {e}"); break; }
        }
    }
}
```

- [ ] **Step 4: Rodar e ver passar**

Run: `cd apps/desktop/src-tauri && cargo test --lib session::`
Expected: PASS (2 testes).

- [ ] **Step 5: Adicionar `read_scrollback` no manager**

Em `apps/desktop/src-tauri/src/pty/manager.rs`, no `impl PtyManager` (junto de `subscribe_by_id`):

```rust
    pub fn read_scrollback(&self, id: &str) -> Result<Vec<u8>> {
        Ok(self.sessions
            .get(id)
            .ok_or_else(|| anyhow!("sessão '{id}' não encontrada"))?
            .read_scrollback())
    }
```

- [ ] **Step 6: Build**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila (aviso de `read_scrollback` não-usado é esperado — consumido na Task 4).

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/pty/session.rs apps/desktop/src-tauri/src/pty/manager.rs
git commit -m "feat(pty): scrollback ring buffer por sessão + read_scrollback"
```

---

## Task 2: Helpers puros das tools (`mcp/tools.rs`)

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/tools.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (`pub mod tools;`)

- [ ] **Step 1: Declarar o módulo**

Em `apps/desktop/src-tauri/src/mcp/mod.rs`, adicione:

```rust
pub mod tools;
```

- [ ] **Step 2: Escrever os testes que falham**

Crie `apps/desktop/src-tauri/src/mcp/tools.rs` com APENAS os testes:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_named_sequences() {
        assert_eq!(keys_to_bytes("enter"), b"\r");
        assert_eq!(keys_to_bytes("ctrl-c"), b"\x03");
        assert_eq!(keys_to_bytes("up down"), b"\x1b[A\x1b[B");
        assert_eq!(keys_to_bytes("esc"), b"\x1b");
    }

    #[test]
    fn keys_literal_passthrough() {
        assert_eq!(keys_to_bytes("hi"), b"hi");
    }

    #[test]
    fn output_substring_returns_line() {
        let buf = "linha um\nfoo bar baz\nfim";
        assert_eq!(output_matches(buf, "bar", false).as_deref(), Some("foo bar baz"));
        assert_eq!(output_matches(buf, "ausente", false), None);
    }

    #[test]
    fn output_regex_returns_line() {
        let buf = "abc\nerror: 42\nxyz";
        assert_eq!(output_matches(buf, r"error: \d+", true).as_deref(), Some("error: 42"));
        assert_eq!(output_matches(buf, r"^never$", true), None);
    }
}
```

- [ ] **Step 3: Rodar e ver falhar**

Run: `cd apps/desktop/src-tauri && cargo test --lib tools::`
Expected: FAIL — `cannot find function keys_to_bytes`.

- [ ] **Step 4: Implementar os helpers**

No topo de `apps/desktop/src-tauri/src/mcp/tools.rs`, antes do `#[cfg(test)]`:

```rust
//! Tools MCP de orquestração (surface herdr). Helpers puros + dispatch.

/// Traduz nomes de tecla (separados por espaço) em bytes; tokens não-reconhecidos
/// são enviados literais.
pub fn keys_to_bytes(keys: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for tok in keys.split_whitespace() {
        match tok.to_lowercase().as_str() {
            "enter" | "return" => out.push(b'\r'),
            "tab" => out.push(b'\t'),
            "esc" | "escape" => out.push(0x1b),
            "space" => out.push(b' '),
            "up" => out.extend_from_slice(b"\x1b[A"),
            "down" => out.extend_from_slice(b"\x1b[B"),
            "right" => out.extend_from_slice(b"\x1b[C"),
            "left" => out.extend_from_slice(b"\x1b[D"),
            "ctrl-c" => out.push(0x03),
            "ctrl-d" => out.push(0x04),
            "ctrl-z" => out.push(0x1a),
            "backspace" => out.push(0x7f),
            other => out.extend_from_slice(other.as_bytes()),
        }
    }
    out
}

/// Procura `pattern` (substring ou regex) linha a linha; devolve a linha que casou.
pub fn output_matches(buf: &str, pattern: &str, use_regex: bool) -> Option<String> {
    if use_regex {
        let re = regex::Regex::new(pattern).ok()?;
        buf.lines().find(|l| re.is_match(l)).map(|s| s.to_string())
    } else {
        buf.lines().find(|l| l.contains(pattern)).map(|s| s.to_string())
    }
}
```

- [ ] **Step 5: Rodar e ver passar**

Run: `cd apps/desktop/src-tauri && cargo test --lib tools::`
Expected: PASS (4 testes).

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/tools.rs apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(mcp): helpers puros das tools de orquestração (keys/output match)"
```

---

## Task 3: Tools de leitura e envio (list/read/send_text/run/send_keys)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (defs + dispatch das 5 tools)
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs` (fields `pub(crate)`, delega `terminal_*`, estende tools/list)

- [ ] **Step 1: Tornar os campos de `McpState` acessíveis ao módulo tools**

Em `apps/desktop/src-tauri/src/mcp/server.rs`, na struct `McpState`, troque os campos privados por `pub(crate)`:

```rust
#[derive(Clone)]
pub struct McpState {
    pub(crate) pty_manager: Arc<PtyManager>,
    pub(crate) agent_registry: Arc<AgentRegistry>,
    pub(crate) sessions: Arc<DashMap<String, broadcast::Sender<String>>>,
}
```

- [ ] **Step 2: Definir as tools e o dispatch em `tools.rs`**

Em `apps/desktop/src-tauri/src/mcp/tools.rs`, adicione (acima do `#[cfg(test)]`):

```rust
use crate::mcp::server::McpState;
use crate::pty::text::bottom_lines;
use serde_json::{json, Value};

/// Resolve o handle (label do registry) → session_id.
fn resolve(state: &McpState, terminal: &str) -> Result<String, String> {
    state
        .agent_registry
        .get_session_id(terminal)
        .ok_or_else(|| format!("terminal '{terminal}' não encontrado (use terminal_list)"))
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Schemas das tools de orquestração (concatenados no tools/list do server).
pub fn terminal_tool_defs() -> Vec<Value> {
    vec![
        json!({ "name": "terminal_list",
            "description": "Lista os terminais-agente do canvas com seu estado (idle/working/blocked/done/dead).",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "terminal_read",
            "description": "Lê as últimas linhas da tela de um terminal sem enviar nada.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "lines": { "type": "number" } },
                "required": ["terminal"] } }),
        json!({ "name": "terminal_send_text",
            "description": "Injeta texto no terminal (sem Enter).",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "text": { "type": "string" } },
                "required": ["terminal", "text"] } }),
        json!({ "name": "terminal_run",
            "description": "Envia um comando seguido de Enter.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "command": { "type": "string" } },
                "required": ["terminal", "command"] } }),
        json!({ "name": "terminal_send_keys",
            "description": "Envia teclas nomeadas (enter, tab, esc, up/down/left/right, ctrl-c, ctrl-d, backspace), separadas por espaço.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "keys": { "type": "string" } },
                "required": ["terminal", "keys"] } }),
    ]
}

/// Despacha as tools `terminal_*`. Devolve o texto do envelope MCP.
pub async fn terminal_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    match tool {
        "terminal_list" => {
            let agents = state.agent_registry.list();
            if agents.is_empty() {
                return "Nenhum terminal-agente. Marque terminais na sidebar do Maestri.".into();
            }
            agents
                .iter()
                .map(|(label, entry)| {
                    let st = state
                        .pty_manager
                        .agent_state(&entry.session_id)
                        .map(|s| format!("{s:?}").to_lowercase())
                        .unwrap_or_else(|| "unknown".into());
                    format!("• {label} [{st}] — {}", entry.description)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "terminal_read" => {
            let terminal = arg_str(&args, "terminal");
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.read_scrollback(&id) {
                    Ok(buf) => {
                        let text = bottom_lines(&buf, lines);
                        if text.is_empty() { "(tela vazia)".into() } else { text }
                    }
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_send_text" => {
            let terminal = arg_str(&args, "terminal");
            let text = arg_str(&args, "text");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, text.as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_run" => {
            let terminal = arg_str(&args, "terminal");
            let command = arg_str(&args, "command");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, format!("{command}\r").as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_send_keys" => {
            let terminal = arg_str(&args, "terminal");
            let keys = arg_str(&args, "keys");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, &keys_to_bytes(&keys)) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        other => format!("❌ tool de terminal desconhecida: {other}"),
    }
}
```

- [ ] **Step 3: Delegar `terminal_*` no `dispatch_tool` do server**

Em `apps/desktop/src-tauri/src/mcp/server.rs`, no `match tool` de `dispatch_tool`, adicione um braço ANTES do catch-all `tool_name =>`:

```rust
        t if t.starts_with("terminal_") => {
            let text = crate::mcp::tools::terminal_dispatch(&state, t, args).await;
            json!({ "content": [{ "type": "text", "text": text }] })
        }
```

- [ ] **Step 4: Incluir as defs no `tools/list`**

Ainda em `server.rs`, no braço `"tools/list"`, logo antes de `json!({ "tools": tools })`, adicione:

```rust
            tools.extend(crate::mcp::tools::terminal_tool_defs());
```

- [ ] **Step 5: Build**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila. (`read_scrollback` agora é usado — aviso da Task 1 some.)

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/tools.rs apps/desktop/src-tauri/src/mcp/server.rs
git commit -m "feat(mcp): tools terminal_list/read/send_text/run/send_keys"
```

---

## Task 4: Tools de espera (wait_status / wait_output)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Adicionar as defs**

Em `terminal_tool_defs()` (em `tools.rs`), adicione ao vetor (antes do `]` final):

```rust
        json!({ "name": "terminal_wait_status",
            "description": "Bloqueia até o terminal atingir um estado (idle/working/blocked/done/dead) ou timeout.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" },
                "status": { "type": "string" },
                "timeout_ms": { "type": "number" } },
                "required": ["terminal", "status"] } }),
        json!({ "name": "terminal_wait_output",
            "description": "Bloqueia até o output do terminal casar um padrão (substring ou regex) ou timeout.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" },
                "pattern": { "type": "string" },
                "regex": { "type": "boolean" },
                "timeout_ms": { "type": "number" } },
                "required": ["terminal", "pattern"] } }),
```

- [ ] **Step 2: Adicionar os imports no topo de `tools.rs`**

Junto aos `use` já existentes:

```rust
use crate::pty::text::clean_terminal_output;
use std::time::Duration;
```

- [ ] **Step 3: Adicionar os braços no `match tool` de `terminal_dispatch`**

Antes do braço `other =>`:

```rust
        "terminal_wait_status" => {
            let terminal = arg_str(&args, "terminal");
            let target = arg_str(&args, "status").to_lowercase();
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
            let id = match resolve(state, &terminal) { Ok(i) => i, Err(e) => return format!("❌ {e}") };

            let matches = |s: &crate::pty::AgentState| format!("{s:?}").to_lowercase() == target;
            if state.pty_manager.agent_state(&id).map(|s| matches(&s)).unwrap_or(false) {
                return format!("reached {target}");
            }
            let mut rx = state.pty_manager.subscribe_state();
            let wait = async {
                loop {
                    match rx.recv().await {
                        Ok((sid, st)) if sid == id && matches(&st) => return,
                        Ok(_) => continue,
                        Err(_) => return,
                    }
                }
            };
            match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
                Ok(()) => format!("reached {target}"),
                Err(_) => {
                    let cur = state.pty_manager.agent_state(&id)
                        .map(|s| format!("{s:?}").to_lowercase()).unwrap_or_else(|| "unknown".into());
                    format!("timeout após {timeout_ms}ms (estado atual: {cur})")
                }
            }
        }
        "terminal_wait_output" => {
            let terminal = arg_str(&args, "terminal");
            let pattern = arg_str(&args, "pattern");
            let use_regex = args.get("regex").and_then(|v| v.as_bool()).unwrap_or(false);
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
            let id = match resolve(state, &terminal) { Ok(i) => i, Err(e) => return format!("❌ {e}") };
            let mut rx = match state.pty_manager.subscribe_by_id(&id) {
                Ok(r) => r, Err(e) => return format!("❌ {e}"),
            };
            // Já tem o padrão na tela atual?
            if let Ok(buf) = state.pty_manager.read_scrollback(&id) {
                let clean = clean_terminal_output(&buf);
                if let Some(line) = output_matches(&clean, &pattern, use_regex) {
                    return format!("matched: {line}");
                }
            }
            let wait = async {
                let mut acc: Vec<u8> = Vec::new();
                loop {
                    match rx.recv().await {
                        Ok(bytes) => {
                            acc.extend_from_slice(&bytes);
                            let clean = clean_terminal_output(&acc);
                            if let Some(line) = output_matches(&clean, &pattern, use_regex) {
                                return Some(line);
                            }
                        }
                        Err(_) => return None,
                    }
                }
            };
            match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
                Ok(Some(line)) => format!("matched: {line}"),
                Ok(None) => "❌ canal fechado antes do match".into(),
                Err(_) => format!("timeout após {timeout_ms}ms sem casar o padrão"),
            }
        }
```

- [ ] **Step 4: Build**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila sem erro.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): tools terminal_wait_status e terminal_wait_output"
```

---

## Task 5: `terminal_spawn` — backend (evento + ack)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs` (`McpState.app`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (`mcp_router` recebe `app`)
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (def + braço `terminal_spawn`)

- [ ] **Step 1: `McpState` ganha `app` e `mcp_router` recebe o handle**

Em `apps/desktop/src-tauri/src/mcp/server.rs`:

(a) Adicione o campo:

```rust
#[derive(Clone)]
pub struct McpState {
    pub(crate) pty_manager: Arc<PtyManager>,
    pub(crate) agent_registry: Arc<AgentRegistry>,
    pub(crate) sessions: Arc<DashMap<String, broadcast::Sender<String>>>,
    pub(crate) app: tauri::AppHandle,
}
```

(b) Atualize a assinatura e a construção em `mcp_router`:

```rust
pub fn mcp_router(
    pty_manager: Arc<PtyManager>,
    agent_registry: Arc<AgentRegistry>,
    app: tauri::AppHandle,
) -> Router {
    let state = Arc::new(McpState {
        pty_manager,
        agent_registry,
        sessions: Arc::new(DashMap::new()),
        app,
    });
```

- [ ] **Step 2: Passar o `AppHandle` no `lib.rs`**

Em `apps/desktop/src-tauri/src/lib.rs`, dentro do `.setup(move |_app| {`, o handle precisa ir pro router. Troque o início do setup:

```rust
        .setup(move |app| {
            let app_handle = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let router = mcp_router(mcp_pm, mcp_ar, app_handle);
                match tokio::net::TcpListener::bind("127.0.0.1:7844").await {
```

(O resto do bloco — `Ok(listener) => { ... }` etc. — permanece igual.)

- [ ] **Step 3: Def da tool `terminal_spawn`**

Em `terminal_tool_defs()` (em `tools.rs`), adicione ao vetor:

```rust
        json!({ "name": "terminal_spawn",
            "description": "Cria um novo terminal no canvas e o registra como agente addressável.",
            "inputSchema": { "type": "object", "properties": {
                "command": { "type": "string" },
                "label": { "type": "string" },
                "role": { "type": "string" },
                "cwd": { "type": "string" },
                "position": { "type": "object", "properties": {
                    "x": { "type": "number" }, "y": { "type": "number" } } } },
                "required": ["command", "label"] } }),
```

- [ ] **Step 4: Imports para o spawn**

No topo de `tools.rs`, adicione:

```rust
use tauri::{Emitter, Listener};
use tokio::sync::oneshot;
use std::sync::Mutex as StdMutex;
```

- [ ] **Step 5: Braço `terminal_spawn` no dispatch**

Antes do braço `other =>` em `terminal_dispatch`:

```rust
        "terminal_spawn" => {
            let command = arg_str(&args, "command");
            let label = arg_str(&args, "label");
            if command.is_empty() || label.is_empty() {
                return "❌ 'command' e 'label' são obrigatórios".into();
            }
            let role = arg_str(&args, "role");
            let cwd = args.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let position = args.get("position").cloned();
            let id = uuid::Uuid::new_v4().to_string();

            // Ouvir o ack pty://ready ANTES de pedir o spawn, filtrando pelo id.
            let (tx, rx) = oneshot::channel::<()>();
            let tx = std::sync::Arc::new(StdMutex::new(Some(tx)));
            let want = id.clone();
            let listener_id = state.app.listen_any("pty://ready", move |event| {
                if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
                    if v.get("id").and_then(|x| x.as_str()) == Some(want.as_str()) {
                        if let Some(s) = tx.lock().unwrap().take() {
                            let _ = s.send(());
                        }
                    }
                }
            });

            let _ = state.app.emit("canvas://spawn-request", json!({
                "id": id, "command": command, "label": label,
                "role": role, "cwd": cwd, "position": position
            }));

            let acked = tokio::time::timeout(Duration::from_secs(8), rx).await.is_ok();
            state.app.unlisten(listener_id);

            state.agent_registry.register(label.clone(), id.clone(), command.clone());

            if acked {
                format!("criado: {label} (id {id})")
            } else {
                format!("criado: {label} (id {id}) — aviso: terminal não confirmou prontidão em 8s")
            }
        }
```

- [ ] **Step 6: Build**

Run: `cd apps/desktop/src-tauri && cargo build`
Expected: compila sem erro.

- [ ] **Step 7: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/server.rs apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/mcp/tools.rs
git commit -m "feat(mcp): terminal_spawn cria nó no canvas via evento + ack pty://ready"
```

---

## Task 6: Frontend — spawn no canvas + ack de prontidão

**Files:**
- Modify: `apps/desktop/src/store/canvas-store.ts` (`addTerminal` aceita `id?`)
- Modify: `apps/desktop/src/hooks/useTerminalSession.ts` (emite `pty://ready`)
- Create: `apps/desktop/src/lib/orchestration-client.ts`
- Modify: `apps/desktop/src/App.tsx` (registra o listener)

- [ ] **Step 1: `addTerminal` aceita `id` opcional**

Em `apps/desktop/src/store/canvas-store.ts`:

(a) Na interface `CanvasState`, ajuste a assinatura de `addTerminal` para incluir `id?`:

```ts
  addTerminal: (params: {
    command: string;
    role?: AgentRole;
    position?: { x: number; y: number };
    label?: string;
    id?: string;
  }) => TerminalNode;
```

(b) Na implementação, use o `id` dado quando presente:

```ts
  addTerminal: ({ command, role = "shell", position, label, id }) => {
    const nodeId = id ?? nanoid();
    const cwd = get().currentCwd ?? undefined;
    const node: TerminalNode = {
      id: nodeId,
      kind: "terminal",
      session_id: nodeId,
      command,
      role,
      label,
      cwd,
      position: position ?? defaultPosition(),
      size: { width: 520, height: 320 },
    };
    set((state) => ({ nodes: [...state.nodes, node] }));
    return node;
  },
```

- [ ] **Step 2: Emitir `pty://ready` quando o PTY estiver pronto**

Em `apps/desktop/src/hooks/useTerminalSession.ts`:

(a) Adicione o import do `emit` do Tauri (junto ao import de `@tauri-apps/api/event` — hoje só tipos):

```ts
import { emit } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
```

(b) No bloco assíncrono, onde hoje está `if (!disposed) setReady(true);`, substitua por:

```ts
        if (!disposed) {
          setReady(true);
          void emit("pty://ready", { id: sessionId });
        }
```

- [ ] **Step 3: Cliente de orquestração (listener do spawn-request)**

Crie `apps/desktop/src/lib/orchestration-client.ts`:

```ts
// src/lib/orchestration-client.ts
//
// Liga o backend MCP (terminal_spawn) ao canvas: ao receber canvas://spawn-request,
// cria o terminal com o id que o backend gerou. O ack (pty://ready) é emitido pelo
// useTerminalSession quando o PTY sobe.

import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { useCanvasStore } from "@/store/canvas-store";
import type { AgentRole } from "@/types/pty";

interface SpawnRequest {
  id: string;
  command: string;
  label?: string;
  role?: string;
  cwd?: string | null;
  position?: { x: number; y: number } | null;
}

const VALID_ROLES: AgentRole[] = ["shell", "claude-code", "codex", "opencode", "custom"];

function asRole(role?: string): AgentRole {
  return (VALID_ROLES as string[]).includes(role ?? "") ? (role as AgentRole) : "shell";
}

/** Registra o listener de spawn-request. Devolve o unlisten. */
export async function initOrchestrationBridge(): Promise<UnlistenFn> {
  return listen<SpawnRequest>("canvas://spawn-request", (event) => {
    const p = event.payload;
    useCanvasStore.getState().addTerminal({
      id: p.id,
      command: p.command,
      label: p.label,
      role: asRole(p.role),
      position: p.position ?? undefined,
    });
  });
}
```

- [ ] **Step 4: Registrar o bridge no boot**

Em `apps/desktop/src/App.tsx`, dentro do componente, adicione um efeito de montagem (ajuste a posição dos imports conforme o arquivo):

```ts
import { useEffect } from "react";
import { initOrchestrationBridge } from "@/lib/orchestration-client";
```

e, no corpo do componente:

```ts
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    initOrchestrationBridge().then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);
```

- [ ] **Step 5: Typecheck**

Run: `cd apps/desktop && npx tsc -p tsconfig.app.json --noEmit --ignoreDeprecations 6.0`
Expected: nenhum erro **novo** nos arquivos tocados (canvas-store, useTerminalSession, orchestration-client, App). Os erros pré-existentes em Canvas/Sidebar/TerminalNode/workspace-client podem permanecer.

- [ ] **Step 6: Commit**

```bash
git add apps/desktop/src/store/canvas-store.ts apps/desktop/src/hooks/useTerminalSession.ts apps/desktop/src/lib/orchestration-client.ts apps/desktop/src/App.tsx
git commit -m "feat(ui): bridge de orquestração — spawn-request cria nó + ack pty://ready"
```

---

## Task 7: Smoke manual (orquestração end-to-end)

**Files:** nenhum (validação).

- [ ] **Step 1: Subir o app e conectar o Orquestrador**

Run: `npm run tauri:dev`. Num terminal-agente (marcado na sidebar), adicione o MCP server ao Claude Code: o comando vem de `mcpAddCommand()` (`/mcp add --transport sse maestri-agents http://127.0.0.1:7844/sse`).

- [ ] **Step 2: Exercitar as tools pelo Orquestrador**

1. `terminal_list` → deve listar os agentes com estado (ex.: `[idle]`).
2. `terminal_run { terminal, command: "echo oi" }` → `terminal_read { terminal }` mostra `oi`.
3. `terminal_send_keys { terminal, keys: "ctrl-c" }` → interrompe.
4. `terminal_wait_status { terminal, status: "idle", timeout_ms: 5000 }` → `reached idle`.
5. `terminal_wait_output { terminal, pattern: "done", timeout_ms: 5000 }` após um `terminal_run` que imprime `done`.
6. `terminal_spawn { command: "bash", label: "helper" }` → um novo nó aparece no canvas e `terminal_list` passa a incluir `helper`.

- [ ] **Step 3: Se algo não casar**

Output real divergente em `terminal_read`/`wait_output` → conferir o strip-ANSI (`pty::text`). `terminal_spawn` sem nó → conferir o listener (`initOrchestrationBridge` registrado no App) e o evento `canvas://spawn-request`. Ack falhando (aviso de 8s) → conferir o `emit("pty://ready")` no `useTerminalSession`.

---

## Resumo de tarefas

| # | Entrega | Verificação |
|---|---------|-------------|
| 1 | scrollback ring buffer + read_scrollback | `cargo test --lib session::` + build |
| 2 | helpers puros (keys/output match) | `cargo test --lib tools::` |
| 3 | tools list/read/send_text/run/send_keys | `cargo build` |
| 4 | tools wait_status/wait_output | `cargo build` |
| 5 | terminal_spawn backend (evento + ack) | `cargo build` |
| 6 | frontend spawn-request + pty://ready | `tsc -p tsconfig.app.json` |
| 7 | smoke manual | `npm run tauri:dev` |
