# Conductor Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** dar aos agentes do OmniRift um canal de comunicação ativo peer-a-peer — perguntar, avisar e negociar — sobre a infra de orquestração que já existe, unificado sob o nome Conductor.

**Architecture:** 3 tools MCP novas (`agent_status`/`agent_ask`/`agent_tell`) no servidor MCP embutido (`mcp/server.rs` + `mcp/tools.rs`), sobre um **protocolo de marcador** (`[[CONDUCTOR-ASK/REPLY/MSG]]`) injetado no PTY e casado por `uuid` no read-loop. Um **preâmbulo de role** (via `agent_mcp_config`) ensina todo agente a responder o protocolo e a negociar claims. Camadas seguintes (monitor, barramento, FS guard) reusam esse núcleo.

**Tech Stack:** Rust (Tauri 2, tokio, axum, dashmap), `mcp/` (JSON-RPC 2.0 + SSE), `pty/` (portable-pty + VT100 screen), front React/TS.

**Referência viva:** spec `docs/superpowers/specs/2026-07-09-conductor-design.md` (as 7 camadas). Este plano detalha **Fase 4a** (núcleo pull) a granularidade executável; **4b/7/5/6** vêm como tarefas concretas que referenciam as funções definidas na 4a (refinadas a bite-sized quando 4a aterelar as interfaces).

---

## Camadas 1–3 — já existem (sem tarefas, contrato de referência)

Não há trabalho novo aqui; o Conductor consome o que existe:
- **1 Hierarquia:** Orquestrador coroado + teto `maxConcurrentAgents` + aprovação/ondas (v0.1.103).
- **2 Fronteira:** Time = Floor/worktree, blackboard namespaceado (`memory_*`), roster escopado.
- **3 Coordenação passiva:** `claim_acquire/check/release` (`mcp/claims.rs`), overlap por `paths:`.

O trabalho começa na Fase 4a.

---

## File Structure (Fase 4a)

- **Create** `apps/desktop/src-tauri/src/mcp/marker.rs` — tipos + parser puro dos marcadores Conductor (unit-testável sem PTY).
- **Modify** `apps/desktop/src-tauri/src/mcp/mod.rs` — `pub mod marker;`.
- **Modify** `apps/desktop/src-tauri/src/mcp/tools.rs` — definição das 3 tools no vetor de schemas + handlers `agent_status`/`agent_ask`/`agent_tell` no `match tool`.
- **Modify** `apps/desktop/src-tauri/src/mcp/server.rs` — helpers internos `conductor_ask_and_wait()` e `conductor_deliver_msg()` (reusam padrão do `do_send_task`); export pra `tools.rs`.
- **Modify** `apps/desktop/src-tauri/src/commands/mcp.rs` — `agent_mcp_config` injeta o preâmbulo de role Conductor.

Princípio: o **parser** (marker.rs) é puro e isolado → testável sem spawnar agente. A **entrega** (server.rs) reusa `pty_manager.write` + `subscribe_by_id` + `read_screen`, exatamente como `do_send_task`/`terminal_wait_output` já fazem.

---

## FASE 4a — Núcleo pull

### Task 1: Parser de marcadores (puro, unit-testável)

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/marker.rs`
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs`

- [ ] **Step 1: Write the failing test**

Em `marker.rs`, no fim do arquivo:
```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_reply_with_matching_id() {
        let line = "[[CONDUCTOR-REPLY id=abc-123]] refatorando o auth";
        let got = parse_reply(line);
        assert_eq!(got, Some(("abc-123".to_string(), "refatorando o auth".to_string())));
    }

    #[test]
    fn ignores_non_reply_lines() {
        assert_eq!(parse_reply("saída normal do agente"), None);
        assert_eq!(parse_reply("[[CONDUCTOR-ASK from=@A id=x]] oi"), None);
    }

    #[test]
    fn reply_matches_target_id_only() {
        let screen = "linha 1\n[[CONDUCTOR-REPLY id=zzz]] outra\n[[CONDUCTOR-REPLY id=abc]] certa\n";
        assert_eq!(find_reply(screen, "abc"), Some("certa".to_string()));
        assert_eq!(find_reply(screen, "nao-existe"), None);
    }

    #[test]
    fn ask_and_msg_render_expected_bytes() {
        assert_eq!(render_ask("@A", "abc", "o que faz?"),
                   "[[CONDUCTOR-ASK from=@A id=abc]] o que faz?");
        assert_eq!(render_msg("@B", "terminei"),
                   "[[CONDUCTOR-MSG from=@B]] terminei");
    }
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift marker:: 2>&1 | tail -20`
Expected: FAIL — `cannot find function parse_reply` (módulo/funções ainda não existem).

- [ ] **Step 3: Write minimal implementation**

No topo de `marker.rs` (antes do `mod tests`):
```rust
//! Protocolo de marcador Conductor: linhas especiais no PTY que os agentes trocam.
//! `ASK`/`MSG` são injetados pelo control plane; `REPLY` é o que o agente responde.
//! Parser PURO — sem PTY, sem estado — pra ser testável isolado.

/// Renderiza a linha ASK que o control plane injeta no PTY do alvo.
pub fn render_ask(from: &str, id: &str, question: &str) -> String {
    format!("[[CONDUCTOR-ASK from={from} id={id}]] {question}")
}

/// Renderiza a linha MSG (fire-and-forget) injetada no PTY do alvo.
pub fn render_msg(from: &str, message: &str) -> String {
    format!("[[CONDUCTOR-MSG from={from}]] {message}")
}

/// Extrai `(id, resposta)` de UMA linha REPLY. `None` se não for REPLY.
pub fn parse_reply(line: &str) -> Option<(String, String)> {
    let rest = line.trim().strip_prefix("[[CONDUCTOR-REPLY id=")?;
    let close = rest.find("]]")?;
    let id = rest[..close].trim().to_string();
    let answer = rest[close + 2..].trim().to_string();
    if id.is_empty() { return None; }
    Some((id, answer))
}

/// Varre uma tela (multi-linha) e devolve a resposta do REPLY cujo id casa `want_id`.
pub fn find_reply(screen: &str, want_id: &str) -> Option<String> {
    screen.lines().rev().find_map(|l| {
        parse_reply(l).and_then(|(id, ans)| (id == want_id).then_some(ans))
    })
}
```

Em `mcp/mod.rs`, adicionar junto aos outros `pub mod`:
```rust
pub mod marker;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift marker:: 2>&1 | tail -20`
Expected: PASS (4 testes).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/marker.rs apps/desktop/src-tauri/src/mcp/mod.rs
git commit -m "feat(conductor): parser puro dos marcadores ASK/REPLY/MSG"
```

---

### Task 2: `conductor_ask_and_wait` — injeta ASK, bloqueia até REPLY

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs` (junto de `do_send_task`, ~linha 488)

- [ ] **Step 1: Write the failing test**

Este helper depende de PTY real → o teste unitário cobre o **timeout path** (sem alvo respondendo), que é determinístico. No `mod tests` de `server.rs`:
```rust
#[tokio::test]
async fn ask_and_wait_times_out_with_state_hint() {
    // fabrica um McpState mínimo sem agente que responda; id inexistente.
    let st = test_state(); // helper existente ou a criar no mod tests
    let out = conductor_ask_and_wait(&st, "inexistente", "@A", "oi?", 1).await;
    assert!(out.contains("sem resposta") || out.contains("não encontrado"));
}
```
> Se não houver `test_state()` no arquivo, adicionar um builder mínimo no `mod tests` que monte `McpState` com registries vazios (seguir o que os testes de `check_token`/`session_guard` já montam). Se montar `McpState` for caro, marcar `#[ignore]` e cobrir por teste de integração na Task 8.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift ask_and_wait 2>&1 | tail -20`
Expected: FAIL — `cannot find function conductor_ask_and_wait`.

- [ ] **Step 3: Write minimal implementation**

Em `server.rs`, após `do_send_task`:
```rust
use crate::mcp::marker::{render_ask, find_reply};

/// Injeta `[[CONDUCTOR-ASK]]` no PTY do alvo e bloqueia até casar o REPLY pelo id,
/// ou estourar `timeout_s`. Reusa o padrão de `do_send_task` (write + \r atrasado)
/// e de `terminal_wait_output` (assina o stream do id e relê a tela renderizada).
pub async fn conductor_ask_and_wait(
    state: &McpState,
    target_label: &str,
    from: &str,
    question: &str,
    timeout_s: u64,
) -> String {
    let sid = match state.agent_registry.get_session_id(target_label) {
        Some(s) => s,
        None => return format!("❌ Agente '{target_label}' não encontrado."),
    };
    let id = new_uuid(); // helper de uuid; se não houver, usar um contador+session (ver nota)
    let ask = render_ask(from, &id, question);

    let mut rx = match state.pty_manager.subscribe_by_id(&sid) {
        Ok(r) => r,
        Err(e) => return format!("❌ {e}"),
    };
    if let Err(e) = state.pty_manager.write(&sid, ask.as_bytes()) { return format!("❌ {e}"); }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = state.pty_manager.write(&sid, b"\r");

    let check = || state.pty_manager.read_screen(&sid).ok().and_then(|s| find_reply(&s, &id));
    if let Some(ans) = check() { return ans; }
    let wait = async {
        loop {
            match rx.recv().await {
                Ok(_) => if let Some(ans) = check() { return Some(ans); },
                Err(_) => return None,
            }
        }
    };
    match tokio::time::timeout(Duration::from_secs(timeout_s), wait).await {
        Ok(Some(ans)) => ans,
        Ok(None) => "❌ canal fechado antes da resposta".into(),
        Err(_) => {
            let cur = state.pty_manager.agent_state(&sid)
                .map(|s| format!("{s:?}").to_lowercase()).unwrap_or_else(|| "unknown".into());
            format!("sem resposta (timeout) · estado de {target_label} = {cur}")
        }
    }
}
```
> **Nota uuid:** procurar se o crate `uuid` já está no `Cargo.toml`; se sim, `uuid::Uuid::new_v4().to_string()`. Se não, gerar id do par `(session_id, contador AtomicU64)` — determinístico e suficiente pra correlação local. NÃO usar `rand`/relógio se quebrar build.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift ask_and_wait 2>&1 | tail -20`
Expected: PASS (ou `ignored` se marcado — a Task 8 cobre por integração).

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/server.rs
git commit -m "feat(conductor): conductor_ask_and_wait — inject ASK, bloqueia até REPLY correlacionado"
```

---

### Task 3: `conductor_deliver_msg` — injeta MSG fire-and-forget

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs`

- [ ] **Step 1: Write the failing test**

```rust
#[tokio::test]
async fn deliver_msg_errors_on_unknown_target() {
    let st = test_state();
    let out = conductor_deliver_msg(&st, "inexistente", "@A", "aviso").await;
    assert!(out.starts_with("❌"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift deliver_msg 2>&1 | tail -20`
Expected: FAIL — função não existe.

- [ ] **Step 3: Write minimal implementation**

Em `server.rs`:
```rust
use crate::mcp::marker::render_msg;

/// Injeta `[[CONDUCTOR-MSG]]` no PTY do alvo e devolve `ok` sem esperar resposta.
/// É o primitivo de entrega reusado pela camada 5 (barramento).
pub async fn conductor_deliver_msg(state: &McpState, target_label: &str, from: &str, message: &str) -> String {
    let sid = match state.agent_registry.get_session_id(target_label) {
        Some(s) => s,
        None => return format!("❌ Agente '{target_label}' não encontrado."),
    };
    let msg = render_msg(from, message);
    if let Err(e) = state.pty_manager.write(&sid, msg.as_bytes()) { return format!("❌ {e}"); }
    tokio::time::sleep(Duration::from_millis(200)).await;
    let _ = state.pty_manager.write(&sid, b"\r");
    "ok — entregue (o alvo verá no próximo turno)".into()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift deliver_msg 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/server.rs
git commit -m "feat(conductor): conductor_deliver_msg — MSG fire-and-forget (primitivo do barramento)"
```

---

### Task 4: `agent_status` — status barato sem tocar no alvo

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (schema no vetor + handler no `match tool`)

- [ ] **Step 1: Write the failing test**

`agent_status` é fino (compõe funções reais). O teste é de integração leve; se `McpState` for caro de montar, cobrir na Task 8. Registrar o schema é o essencial. Teste do schema:
```rust
#[test]
fn agent_status_is_registered() {
    let names: Vec<String> = tool_schemas().iter()
        .filter_map(|t| t.get("name").and_then(|n| n.as_str()).map(String::from))
        .collect();
    assert!(names.contains(&"agent_status".to_string()));
    assert!(names.contains(&"agent_ask".to_string()));
    assert!(names.contains(&"agent_tell".to_string()));
}
```
> Ajustar `tool_schemas()` pro nome real da função que devolve o vetor de schemas em `tools.rs` (a que contém `json!({ "name": "terminal_list", ... })`).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift agent_status_is_registered 2>&1 | tail -20`
Expected: FAIL — os 3 nomes ainda não estão no vetor.

- [ ] **Step 3: Write minimal implementation**

No vetor de schemas (perto de `orchestration_send`), adicionar:
```rust
json!({ "name": "agent_status",
    "description": "BARATO, NÃO interrompe: o que um agente está fazendo agora (estado + últimas linhas). Use isto por padrão pra 'o que o X está fazendo'.",
    "inputSchema": { "type": "object", "properties": {
        "target": { "type": "string", "description": "label/role/@nome do agente." } },
        "required": ["target"] } }),
json!({ "name": "agent_ask",
    "description": "INTERROMPE o alvo pra ter uma resposta REAL (custa um turno dele). Use pra perguntas que só ele sabe ('como fez X?', 'me passa o resultado').",
    "inputSchema": { "type": "object", "properties": {
        "target": { "type": "string" },
        "question": { "type": "string" },
        "timeout_s": { "type": "integer", "description": "default 90" } },
        "required": ["target", "question"] } }),
json!({ "name": "agent_tell",
    "description": "AVISA o alvo de algo, sem esperar resposta (fire-and-forget). Ex: 'terminei o auth, pode seguir'.",
    "inputSchema": { "type": "object", "properties": {
        "target": { "type": "string" },
        "message": { "type": "string" } },
        "required": ["target", "message"] } }),
```

No `match tool` (perto do handler `terminal_read`), adicionar o handler do status:
```rust
"agent_status" => {
    let target = arg_str(&args, "target");
    match resolve(state, &target) {
        Ok(id) => {
            let st = state.pty_manager.agent_state(&id)
                .map(|s| format!("{s:?}").to_lowercase()).unwrap_or_else(|| "unknown".into());
            let tail = state.pty_manager.read_screen(&id).ok()
                .map(|s| last_lines(&s, 8)).unwrap_or_default();
            format!("estado: {st}\n--- últimas linhas ---\n{tail}")
        }
        Err(e) => format!("❌ {e}"),
    }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift agent_status_is_registered 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/tools.rs
git commit -m "feat(conductor): agent_status (peek barato) + schemas de agent_ask/agent_tell"
```

---

### Task 5: handlers `agent_ask` / `agent_tell` (fiam nos helpers da server.rs)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs` (handlers) **ou** `mcp/server.rs` (`handle_jsonrpc`, perto do roteamento de `review_current`)

> **Decisão de wiring:** `agent_ask`/`agent_tell` são `async` e chamam funções de `server.rs`. Se o `match tool` de `tools.rs` já é `async` (o `orchestration_send`/`terminal_send_text` usam `.await`), fiar lá. Se `conductor_ask_and_wait` não for visível de `tools.rs`, rotear em `server.rs::handle_jsonrpc` (onde `do_send_task` já vive), como já se faz com `review_current`.

- [ ] **Step 1: Write the failing test**

Integração (na Task 8, com 2 agentes reais). Aqui, teste de fumaça de que a tool não cai no branch "desconhecida":
```rust
#[tokio::test]
async fn agent_ask_unknown_target_is_graceful() {
    let st = test_state();
    let out = dispatch_agent_tool(&st, "agent_ask",
        json!({"target":"inexistente","question":"oi"})).await;
    assert!(out.contains("não encontrado") || out.starts_with("❌"));
}
```
> `dispatch_agent_tool` = o ponto real de roteamento escolhido acima (helper de teste que chama esse caminho).

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift agent_ask_unknown 2>&1 | tail -20`
Expected: FAIL — cai em "Tool desconhecida" ou função ausente.

- [ ] **Step 3: Write minimal implementation**

No ponto de roteamento (`server.rs::handle_jsonrpc` ou o `match` async de `tools.rs`):
```rust
"agent_ask" => {
    let target = args.get("target").and_then(|v| v.as_str()).unwrap_or("");
    let question = args.get("question").and_then(|v| v.as_str()).unwrap_or("");
    let timeout_s = args.get("timeout_s").and_then(|v| v.as_u64()).unwrap_or(90);
    let from = "@orquestrador"; // ou derivar do X-Terminal-ID quando disponível (ver Task 7)
    let text = conductor_ask_and_wait(&state, target, from, question, timeout_s).await;
    wrap_tool_text(&state, "agent_ask", text)
}
"agent_tell" => {
    let target = args.get("target").and_then(|v| v.as_str()).unwrap_or("");
    let message = args.get("message").and_then(|v| v.as_str()).unwrap_or("");
    let from = "@orquestrador";
    let text = conductor_deliver_msg(&state, target, from, message).await;
    wrap_tool_text(&state, "agent_tell", text)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift agent_ask_unknown 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/tools.rs apps/desktop/src-tauri/src/mcp/server.rs
git commit -m "feat(conductor): wire agent_ask/agent_tell nos helpers de entrega"
```

---

### Task 6: preâmbulo de role Conductor (agentes nascem cientes do protocolo)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mcp.rs` (`agent_mcp_config`, ~linha 179)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn preamble_contains_reply_protocol_and_claim_etiquette() {
    let p = conductor_preamble();
    assert!(p.contains("CONDUCTOR-ASK"));
    assert!(p.contains("CONDUCTOR-REPLY"));
    assert!(p.contains("claim_check"));
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift preamble_contains 2>&1 | tail -20`
Expected: FAIL — `conductor_preamble` não existe.

- [ ] **Step 3: Write minimal implementation**

Em `commands/mcp.rs`:
```rust
/// Etiqueta injetada no system prompt de todo agente Conductor.
pub fn conductor_preamble() -> &'static str {
    "Você participa do Conductor. Outros agentes falam com você:\n\
     - Ao ver `[[CONDUCTOR-ASK from=@X id=N]] <pergunta>`: responda em UMA linha \
     `[[CONDUCTOR-REPLY id=N]] <resposta curta>` e VOLTE ao que fazia.\n\
     - `[[CONDUCTOR-MSG from=@X]] <aviso>` é informação; incorpore e siga.\n\
     - ANTES de editar um arquivo: `claim_check`. Se travado por outro, use \
     `agent_ask(dono, \"preciso de <arquivo> — libera ou espero?\")` e respeite a resposta."
}
```
E incorporar o retorno de `conductor_preamble()` na string de instrução/append que `agent_mcp_config` já monta pro spawn (concatenar ao bloco de role, sem quebrar o merge de MCP existente).

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift preamble_contains 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/commands/mcp.rs
git commit -m "feat(conductor): preâmbulo de role — agentes nascem cientes do protocolo + negociação"
```

---

### Task 7: `from` real via X-Terminal-ID (correlação de quem pergunta)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs` (extrair o terminal-id do header no `handle_jsonrpc`)

- [ ] **Step 1: Write the failing test**

```rust
#[test]
fn resolves_from_label_from_terminal_id() {
    // dado um X-Terminal-ID conhecido, o `from` vira @<label> daquele agente.
    let st = test_state_with_agent("Backend", "sid-1");
    assert_eq!(from_label(&st, Some("sid-1")), "@Backend");
    assert_eq!(from_label(&st, None), "@desconhecido");
}
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift resolves_from_label 2>&1 | tail -20`
Expected: FAIL — `from_label` não existe.

- [ ] **Step 3: Write minimal implementation**

```rust
/// Resolve quem está perguntando a partir do X-Terminal-ID (header do MCP server).
pub fn from_label(state: &McpState, terminal_id: Option<&str>) -> String {
    terminal_id
        .and_then(|sid| state.agent_registry.label_for_session(sid))
        .map(|l| format!("@{l}"))
        .unwrap_or_else(|| "@desconhecido".into())
}
```
> Se `label_for_session` não existir no `AgentRegistry`, adicionar (inverso do `get_session_id`). Substituir o `from = "@orquestrador"` fixo das Tasks 5 pelo `from_label(&state, terminal_id)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift resolves_from_label 2>&1 | tail -20`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/src/mcp/server.rs apps/desktop/src-tauri/src/mcp/registry.rs
git commit -m "feat(conductor): from real via X-Terminal-ID (quem pergunta é identificado)"
```

---

### Task 8: teste de integração — 2 agentes conversando

**Files:**
- Create: `apps/desktop/src-tauri/tests/conductor_e2e.rs` (ou `#[ignore]` no módulo, rodado sob demanda)

- [ ] **Step 1: Write the failing test**

```rust
// Requer binário `claude`/mock no PATH. Marcar #[ignore] no CI; rodar local com --ignored.
#[tokio::test]
#[ignore]
async fn ask_reply_roundtrip_between_two_agents() {
    // 1. sobe MCP server + spawna 2 agentes (A, B) via PtyManager real
    // 2. B recebe o preâmbulo (Task 6) → sabe responder REPLY
    // 3. A chama agent_ask(B, "diga PONG")
    // 4. assert: resposta contém "PONG", correlacionada ao id
    // 5. agent_status(B) NÃO muda o AgentState de B (não consumiu turno)
}
```

- [ ] **Step 2: Run to verify it fails/ignored**

Run: `cd apps/desktop/src-tauri && cargo test -p omnirift --test conductor_e2e -- --ignored 2>&1 | tail -30`
Expected: FAIL (roundtrip não fecha) — ou compila e fica `ignored` até o harness de agente-mock existir.

- [ ] **Step 3–4: Implementar o harness mínimo** (spawn de 2 PTYs com um script-mock que ecoa REPLY ao ver ASK) até o roundtrip passar localmente.

- [ ] **Step 5: Commit**

```bash
git add apps/desktop/src-tauri/tests/conductor_e2e.rs
git commit -m "test(conductor): e2e ask→reply correlacionado entre 2 agentes (ignored no CI)"
```

---

### Task 9: Regression guard da Fase 4a

- [ ] **Step 1:** `cd apps/desktop/src-tauri && cargo test -p omnirift 2>&1 | tail -30` — TODA a suíte, não só a nova (a 4a mexe no read-loop/dispatch, caminho crítico).
- [ ] **Step 2:** `cd apps/desktop && npm run typecheck 2>&1 | tail -20` — front intacto.
- [ ] **Step 3:** `cd apps/desktop/src-tauri && cargo check 2>&1 | tail -20`.
- [ ] **Step 4: Commit** (se algo precisou de ajuste): `git commit -am "chore(conductor): fase 4a — regression guard verde"`.

---

## FASE 4b — Push dirigido + negociação (após 4a verde)

- **Task 10:** `agent_tell` já existe (Task 3+5); adicionar teste de integração do push (B faz `agent_tell(A, ...)`, A vê o MSG na tela no próximo `read_screen`). Files: `tests/conductor_e2e.rs`.
- **Task 11:** fluxo de negociação e2e — A faz `claim_acquire(x)`; B faz `claim_check(x)` → recebe "travado por A" → `agent_ask(A, "libera x?")` → A responde → assert sem colisão. Files: `tests/conductor_e2e.rs`. Reusa `conductor_ask_and_wait` (Task 2) + `claim_*` (existe). Sem código novo de produção — valida a etiqueta do preâmbulo (Task 6).
- **Task 12:** filtrar os marcadores `[[CONDUCTOR-*]]` do que o xterm renderiza pro humano (meta, não ruído visível). Files: `pty/session.rs` (read-loop) + front `TerminalNode.tsx` (esconder linhas-marcador). TDD no parser (marker.rs já isola o reconhecimento).

## FASE 7 — Monitor passivo / OmniPartner (paralelo a 4b)

- **Task 13:** front consome `agent://status` (evento já emitido, `AgentStatusEvent`) → toast/badge quando um agente vai a `Done`/`Blocked`. Files: `apps/desktop/src/…` (store + componente de notificação). Sem backend novo.
- **Task 14:** ação "o que o X está fazendo?" no monitor → chama `agent_status` (Task 4). Files: front.
- Cruzar escopo com `2026-06-28-omnipartner-aprender-design.md` (vertente "Aprender" já tem spec; aqui é a vertente "vigia").

## FASE 5 — Barramento ativo (só se `recall` por tag não bastar)

- **Task 15:** dispatcher de tópicos sobre `conductor_deliver_msg` (Task 3): tabela `subscriptions(topic, agent)`; `conductor_publish(topic, payload)` injeta MSG em cada inscrito. Files: `mcp/tools.rs` (tools `topic_subscribe`/`topic_publish`) + `mcp/server.rs`. Reusa 100% o primitivo da Task 3.
- Nota: a versão leve (blackboard por tag) já existe — só construir isto sob cenário real com N agentes.

## FASE 6 — Enforcement duro / FS guard (provável never)

- **Task 16 (speculativo, refinar se/quando chegar):** interceptar escrita real num working copy compartilhado. Opções a avaliar na época: fanotify (Linux) com política por claim; fuse overlay; ou rotear escrita por tool. **Pré-condição para nem começar:** existir um caso concreto onde agentes precisam do MESMO working copy E não dá pra confiar no contrato/Floor. Enquanto isso, Floor (worktree) é a garantia dura. Documentado pra não reinventar.

---

## Self-Review (feito)

- **Spec coverage:** camadas 1–3 (contrato, sem tarefa — já existem); 4a (Tasks 1–9, executável); 4b (10–12); 7 (13–14); 5 (15); 6 (16, speculativo). Todas as 7 mapeadas.
- **Placeholder scan:** 4a sem TODO/TBD — código real em cada step. 4b/5/6 são outlines honestos (labelados), não placeholders escondidos; 6 é explicitamente speculativo com pré-condição.
- **Type consistency:** `conductor_ask_and_wait`/`conductor_deliver_msg`/`conductor_preamble`/`from_label`/`render_ask`/`render_msg`/`parse_reply`/`find_reply` — nomes usados de forma idêntica onde referenciados. Tools: `agent_status`/`agent_ask`/`agent_tell` consistentes em schema e handler.
- **Riscos conhecidos anotados na spec:** falso-match de marcador (uuid + só REPLY de ASK pendente), interrupt derailla B (preâmbulo "responda curto e volte"), timeout vs tarefa longa (retorno traz o estado).
