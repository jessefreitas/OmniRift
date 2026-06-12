# Spec — API de Orquestração (herdr → maestri, Sub-projeto B)

- **Data:** 2026-06-12
- **Status:** Aprovado (design) — aguardando revisão do spec
- **Depende de:** Sub-projeto A (motor de detecção) — usa `PtyManager::agent_state()` e `subscribe_state()`
- **Referência:** herdr socket API (`pane.*`, `wait`, `events`) — ver `docs/superpowers/specs/2026-06-12-herdr-detection-engine-design.md §0`

---

## 1. Problema

O MCP server (`mcp/server.rs`, em `127.0.0.1:7844`, JSON-RPC 2.0/SSE) hoje expõe só:
- `list_agents` — lista os terminais marcados como agente na sidebar;
- uma tool dinâmica por agente que faz `send_task`: escreve a tarefa no PTY e **bloqueia** acumulando output até `is_cc_idle` ou timeout, devolvendo tudo.

Um Orquestrador (Claude Code externo conectado ao MCP) só consegue "dispara e espera a resposta inteira". Não consegue: **ler** a tela atual sem mandar tarefa, mandar **texto/teclas granulares**, **esperar um estado** específico (ex.: "espera ficar blocked"), esperar um **padrão de output**, nem **criar** um novo terminal/helper. O herdr resolve tudo isso via socket API — e agora que A dá o estado por sessão, dá pra expor o surface equivalente.

## 2. Objetivo e sucesso

Adicionar 8 tools MCP equivalentes ao surface herdr, mantendo `list_agents`/`send_task` existentes. Sucesso quando o Orquestrador consegue, via MCP:
- [ ] `terminal_list` → ver cada terminal-agente com seu **estado** (idle/working/blocked/done/dead).
- [ ] `terminal_read` → ler a tela atual de um terminal sem enviar nada.
- [ ] `terminal_send_text` / `terminal_run` / `terminal_send_keys` → injetar texto / comando+Enter / teclas.
- [ ] `terminal_wait_status` → bloquear até um terminal atingir um estado alvo (timeout).
- [ ] `terminal_wait_output` → bloquear até o output casar um padrão (timeout).
- [ ] `terminal_spawn` → criar um novo terminal no canvas e recebê-lo addressável (com ack de prontidão).

## 3. Endereçamento (handle)

As tools usam o **label do registry** como handle (o nome do agente que a sidebar já popula via `mcp_register_agent`). Continuidade com o modelo atual: `terminal_list` devolve labels; `terminal_spawn` **auto-registra** o novo terminal com um label, tornando-o addressável imediatamente. Internamente o label resolve pra `session_id` via `AgentRegistry::get_session_id`.

## 4. Tools (schemas e retorno)

Todas retornam `{ content: [{ type: "text", text: ... }] }` (formato MCP). Erros viram texto `❌ ...` no mesmo envelope.

### 4.1 `terminal_list`
- **input:** `{}`
- **ação:** para cada agente registrado, resolve `session_id` e chama `manager.agent_state(id)`.
- **retorno (texto):** linhas `• <label> [<estado>] — <description>`, ex.: `• frontend [blocked] — React/Vite`.

### 4.2 `terminal_read`
- **input:** `{ terminal: string, lines?: number }` (default `lines=40`)
- **ação:** lê o **scrollback** (§5) da sessão, aplica `text::bottom_lines(buf, lines)`.
- **retorno:** o texto limpo das últimas `lines` linhas.

### 4.3 `terminal_send_text`
- **input:** `{ terminal: string, text: string }`
- **ação:** `manager.write(id, text.as_bytes())` — sem Enter.
- **retorno:** `ok` (ou erro).

### 4.4 `terminal_run`
- **input:** `{ terminal: string, command: string }`
- **ação:** `manager.write(id, format!("{command}\r"))` — Enter em `\r` (raw mode, igual ao `send_task` atual).
- **retorno:** `ok`.

### 4.5 `terminal_send_keys`
- **input:** `{ terminal: string, keys: string }`
- **ação:** traduz nomes de tecla comuns → bytes e escreve. Mapa v1: `enter→\r`, `tab→\t`, `esc→\x1b`, `up→\x1b[A`, `down→\x1b[B`, `right→\x1b[C`, `left→\x1b[D`, `ctrl-c→\x03`, `ctrl-d→\x04`, `backspace→\x7f`. Sequências separadas por espaço; texto não-reconhecido é enviado literal.
- **retorno:** `ok`.

### 4.6 `terminal_wait_status`
- **input:** `{ terminal: string, status: "idle"|"working"|"blocked"|"done"|"dead", timeout_ms?: number }` (default `30000`)
- **ação:** se `agent_state(id)` já == alvo, retorna na hora; senão assina `manager.subscribe_state()` e bloqueia até `(id, alvo)` ou timeout (`tokio::time::timeout`).
- **retorno:** `reached <status>` ou `timeout após <ms>ms (estado atual: <x>)`.

### 4.7 `terminal_wait_output`
- **input:** `{ terminal: string, pattern: string, regex?: boolean, timeout_ms?: number }` (default `30000`)
- **ação:** assina `manager.subscribe_by_id(id)`, acumula chunks limpos (`text::clean_terminal_output`), testa `pattern` (substring ou `regex::Regex` se `regex=true`) a cada chunk até casar ou timeout.
- **retorno:** `matched` (+ a linha que casou) ou `timeout`.

### 4.8 `terminal_spawn`
- **input:** `{ command: string, label: string, role?: string, cwd?: string, position?: {x:number,y:number} }`
- **ação (protocolo de evento + ack):**
  1. backend gera `session_id` (uuid);
  2. emite Tauri event `canvas://spawn-request { id, command, label, role, cwd, position }`;
  3. **aguarda** o event `canvas://spawned { id }` (via `app.listen_any`, alimentando um `tokio::sync::oneshot`) — timeout 8s;
  4. auto-registra no `AgentRegistry` (`label → id`, description = `command`);
  5. retorna o `label` (e `id`).
- **lado frontend:** um listener de `canvas://spawn-request` chama `store.addTerminal({ command, role, label, position, id })` (variante que aceita `id` fixo); quando o `useTerminalSession` daquele nó sinaliza `ready`, emite `canvas://spawned { id }`.
- **retorno:** `criado: <label> (id <id>)` ou `timeout: terminal não confirmou prontidão`.

> Decisão registrada: o backend **não** cria o nó React Flow nem sobe o PTY direto — quem é dono do ciclo de vida do nó+PTY é o frontend (`addTerminal` + `useTerminalSession`). O backend só pede e espera o ack. Isso evita spawn duplicado e mantém o id correlacionado (o backend gera o id e o repassa).

## 5. Scrollback ring buffer (capacidade nova)

`PtySession` ganha `scrollback: Arc<Mutex<VecDeque<u8>>>` limitado a `SCROLLBACK_CAP = 32768` bytes. Alimentado no `read_loop` existente (`session.rs`), no mesmo ponto que faz `tx.send(chunk)`:
```rust
{
    let mut sb = scrollback.lock();
    sb.extend(chunk.iter().copied());
    while sb.len() > SCROLLBACK_CAP { sb.pop_front(); }
}
```
Acessor `PtySession::read_scrollback(&self) -> Vec<u8>` (snapshot) e no `PtyManager`: `read_scrollback(&self, id) -> Result<Vec<u8>>`. `terminal_read` consome via `bottom_lines`.

## 6. Arquitetura / arquivos

O `mcp/server.rs` (≈365 linhas) já está no limite do confortável. As tools novas vão num módulo próprio:

**Criar:**
- `apps/desktop/src-tauri/src/mcp/tools.rs` — implementação das 8 tools `terminal_*` (cada uma uma `async fn(state, args) -> String`), o mapa de teclas e o dispatch `terminal_dispatch(state, tool, args)`.

**Modificar:**
- `apps/desktop/src-tauri/src/mcp/server.rs` — `McpState` ganha `app: AppHandle`; `tools/list` inclui as 8 novas; `dispatch_tool` delega `terminal_*` pra `tools::terminal_dispatch`. (Promover o `clean_terminal_output`/`is_cc_idle` locais a `pty::text` onde fizer sentido — dedup oportuno.)
- `apps/desktop/src-tauri/src/mcp/mod.rs` — `pub mod tools;`.
- `apps/desktop/src-tauri/src/pty/session.rs` — scrollback ring buffer + acessor.
- `apps/desktop/src-tauri/src/pty/manager.rs` — `read_scrollback(id)`.
- `apps/desktop/src-tauri/src/lib.rs` — `mcp_router(pm, ar, app)` recebe o `AppHandle` (já disponível no `setup`).
- **Frontend:**
  - `apps/desktop/src/store/canvas-store.ts` — `addTerminal` aceita `id?` opcional (usa o id dado em vez de gerar).
  - `apps/desktop/src/hooks/useTerminalSession.ts` — quando `ready` e a sessão foi originada pelo backend, emite `canvas://spawned { id }`.
  - `apps/desktop/src/lib/mcp-client.ts` (ou novo `apps/desktop/src/lib/orchestration-client.ts`) — listener de `canvas://spawn-request` → `addTerminal`.
  - registrar o listener no boot (App.tsx / Canvas.tsx).

## 7. Testes

- **Rust puro (unit):**
  - `tools.rs` — mapa de teclas (`send_keys`): `"enter"→b"\r"`, `"ctrl-c"→b"\x03"`, `"up down"→b"\x1b[A\x1b[B"`, texto literal passa direto.
  - `terminal_wait_output` matcher — substring e regex contra buffer canônico (função pura extraída: `output_matches(buf, pattern, regex) -> Option<linha>`).
- **Integração (com PtyManager real + comando `echo`/`sleep`):**
  - scrollback: spawnar `printf 'abc\n'`, ler `read_scrollback`, conferir tail.
  - `terminal_wait_status`: spawnar shell, asserir transição pra `idle` via `subscribe_state` (tolerante a timing).
- **Frontend:** sem runner de testes no projeto (ver A) → verificação por `tsc` direcionado + smoke (`terminal_spawn` cria nó visível e fica addressável).

## 8. Fora de escopo (YAGNI para B)

- `events.subscribe`/notificações MCP assíncronas (push do servidor) — próximo incremento.
- `pane split` com direção/layout — no canvas espacial vira `position` no `terminal_spawn`.
- `pane.zoom`/`swap`/`resize`/`focus_direction` — operações de layout TUI sem análogo no canvas v1.
- Reescrever `send_task` — fica como está (atalho de alto nível); as tools novas são o caminho granular.

## 9. Contrato consumido de A

```rust
manager.agent_state(id) -> Option<AgentState>        // terminal_list, terminal_wait_status
manager.subscribe_state() -> Receiver<(SessionId, AgentState)>  // terminal_wait_status
manager.subscribe_by_id(id) -> Receiver<Vec<u8>>     // terminal_wait_output (já existia)
```

## 10. Riscos

- `terminal_spawn` é o ponto mais arriscado (cross-boundary backend↔frontend + ack). Sequenciar por último no plano; se o ack falhar, degrada pra retorno otimista com aviso.
- `app.listen_any` + `oneshot`: garantir unsubscribe do listener após o ack/timeout pra não vazar.
