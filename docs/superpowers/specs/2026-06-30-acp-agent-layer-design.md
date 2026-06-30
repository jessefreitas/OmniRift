# ACP Agent Layer (agente estruturado) — Design

> Status: **viabilidade PROVADA** · 2026-06-30. Risco #1 (auth do adapter) **validado com handshake
> ACP real fora do app** — `initialize` retornou `authMethods:[]` (herda `~/.claude`, zero setup) e
> `session/new` devolveu `sessionId` + `models` + `modes`. Pronto pro spike de código. Fonte: ACP
> (Agent Client Protocol — padrão aberto do Zed, JSON-RPC 2.0/stdio) + mapeamento do código atual do
> OmniRift (4 explorações 2026-06-30). A aposta sistêmica: deixar de tratar agente como terminal cego
> e passar a tratá-lo como objeto estruturado.

**Problema:** hoje todo agente nasce como **PTY cru**. `build_command` (`pty/session.rs:413`) só
faz pipe de bytes via `portable-pty`; o `command` é string free-form (`PtySpawnConfig`), resolvido
pelo PATH herdado de `login_shell_path()` (`lib.rs:147`). O backend **não sabe nada** do que o agente
faz: qual arquivo editou, que tool chamou, se está pedindo permissão, se o turno terminou, qual
modelo/contexto. Tudo que poderia ser inteligente sobre agentes está **cego por causa disso**:

- **Conexões agente→agente (Fase 2, o conceito central)** — só dá pra passar *texto de terminal*.
- **Review** — impossível mostrar diff/aprovar mudança no canvas; o backend não sabe o que mudou.
- **Permissões** — sem gating visual ("o agente quer `rm`, aprovar?"); o pedido some no stdout.
- **Status / badges** — "running/idle" é heurística de output; modelo/contexto é raspado e fica *stale*
  (a dor já registrada nas releases não é bug de badge — é o sintoma da cegueira).
- **Memória plugável (Fase 8)** — ingere texto, não tool-calls estruturados.
- **Checkpoint automático** — só dá pra auto-salvar "ao fim de um passo" se você *souber* que terminou.

**Solução:** adicionar uma **camada ACP** ao lado do PTY. ACP é JSON-RPC 2.0 sobre stdio, padrão do
Zed adotado em 2026 por VS Code, JetBrains, Microsoft Terminal e OpenCode — apostar nele **alinha o
OmniRift ao ecossistema**, não é caminho isolado. O backend Rust implementa o lado **Client** via o
**SDK Rust oficial** `agent-client-protocol` (+ `agent-client-protocol-tokio`, e o Tauri já roda Tokio).
Agentes ACP viram um **novo tipo de nó estruturado (`AgentNode`)**, **ADITIVO**: o `TerminalNode`/PTY
universal continua intocado (shell, vim, htop seguem PTY). Moat preservado ("qualquer CLI vira
terminal"), inteligência ganha (agentes que falam ACP viram objetos com estado).

**Por que ACP e não parsear o terminal:** o stream estruturado é nativo e confiável (tool-call,
diff, plano, permissão, fim-de-turno como eventos tipados) vs heurística frágil sobre bytes ANSI.
E o SDK Rust já traz launchers prontos (`AcpAgent::zed_claude_code()`, `::google_gemini()`) — **não
reimplementamos JSON-RPC nem descobrimos o comando do adapter.**

## Arquitetura (MVP / spike)

1. **`acp/client.rs` (NOVO)** — lado Client. `AcpAgent::zed_claude_code()` spawna o adapter como
   subprocesso stdio. `Client.builder()` registra:
   - `.on_receive_notification(SessionNotification …)` → traduz o `session/update` e **emite
     `acp://update`** pro front (message chunk | `tool_call{title,kind,status,diff}` | plan).
   - `.on_receive_request(RequestPermissionRequest …)` → guarda o `responder` num mapa por reqId e
     **emite `acp://permission`** pro front; a resposta volta por comando.
   - Fluxo: `InitializeRequest` → `session/new` → `session/prompt`. `session/cancel` no stop.
2. **`acp/mod.rs` (NOVO)** — `AcpManager { sessions: DashMap<SessionId, AcpHandle> }` (espelha o
   `pty/manager.rs`). `AcpHandle { session_id, cancel_tx, pending_permissions }`.
3. **`commands/acp.rs` (NOVO)** — superfície que espelha `pty_*`: `acp_spawn(config) -> SessionId`,
   `acp_prompt(session_id, text)`, `acp_cancel(session_id)`, `acp_permission_respond(req_id, outcome)`.
   Wire no `lib.rs` `invoke_handler`.
4. **Eventos Tauri** (mesmo padrão `pty://` que o `pty-client.ts` já consome): `acp://update`,
   `acp://permission`, `acp://turn-done` (`stopReason`).
5. **Frontend** — novo nó estruturado:
   - `src/types/canvas.ts`: + tipo `AgentNode` (estruturado), distinto de `TerminalNode`.
   - `src/components/nodes/AgentNode.tsx` (NOVO): stream de mensagens + **tool-call cards** (o diff
     **reusa `DiffLines` do `DiffViewerModal.tsx`**) + botão **approve/deny** no pedido de permissão.
   - `src/lib/acp-client.ts` (NOVO): espelha `pty-client.ts` (invokes + `listen("acp://…")`).
   - `src/store/canvas-store.ts`: estado dos agent nodes + permissão pendente.
6. **Coexistência** — os `PRESETS` (`Sidebar.tsx:203`) ganham flag `acp?: true`. Claude Code / Gemini
   / Codex podem nascer como `AgentNode` (ACP) **ou** `TerminalNode` (PTY) — escolha do user. Demais
   CLIs e shells: só PTY.

## Componentes / arquivos

- `src-tauri/Cargo.toml`: deps `agent-client-protocol` + `agent-client-protocol-tokio`.
- `src-tauri/src/acp/{mod.rs,client.rs}` (NOVO): conexão Client, handlers, `AcpManager`/`AcpHandle`.
- `src-tauri/src/commands/acp.rs` (NOVO): comandos `acp_*`; wire no `lib.rs`.
- `src/lib/acp-client.ts` (NOVO): invokes + listeners tipados.
- `src/components/nodes/AgentNode.tsx` (NOVO): UI estruturada (reusa `DiffLines`).
- `src/types/canvas.ts`, `src/store/canvas-store.ts`, `src/components/Sidebar.tsx`: tipo + estado + flag.

## O spike (prova / derruba) — escopo mínimo

- **Backend:** `acp/client.rs` mínimo + comando `acp_spawn` que lança `zed_claude_code()`,
  faz initialize → `session/new` → `session/prompt` (prompt fixo) e emite `acp://update`.
- **Frontend:** painel cru (nem precisa de nó no canvas) listando os updates recebidos + 1 botão
  approve no `acp://permission`.
- **Critério de SUCESSO:** ver, dentro do OmniRift, os **tool-calls + texto do Claude Code chegando
  estruturados** (não bytes de PTY) e responder a **1 `requestPermission` pela UI**.
- **NÃO fazer no spike:** UI polida, nó no canvas, Codex/Gemini, multi-sessão, conexões semânticas,
  persistência, SSH. Branch descartável.
- **Estimativa:** ~1–2 dias.

## Riscos / questões abertas (validar NO spike, em ordem)

1. **Auth do adapter — ✅ RESOLVIDO (provado 2026-06-30).** Handshake ACP real rodado fora do app
   contra **`npx @agentclientprotocol/claude-agent-acp`** (pacote canônico atual; `@zed-industries/*`
   e `claude-code-acp` estão deprecados/renomeados — **o `zed_claude_code()` do SDK pode apontar pro
   antigo, então lançar via `AcpAgent::from_str("npx @agentclientprotocol/claude-agent-acp")`**).
   `initialize` retornou **`authMethods:[]` → herda a sessão Claude Code de `~/.claude`, zero setup**;
   `session/new` retornou `sessionId` + `models` (Opus/Sonnet/Haiku) + `modes`
   (default/acceptEdits/plan/dontAsk/**bypassPermissions**) + `session/update` streaming. Node 20 +
   `claude` 2.1.193 já presentes; não conflita com `login_shell_path()`. **Resta validar só no Windows.**
2. **Dependência de Node/npx** pro adapter contraria o ideal self-contained → mitiga depois com o
   **binary-manager** (pinar o adapter, como o omnicompress).
3. **Maturidade do SDK Rust** (v0.x, breaking — há `migration_v0.11.x`). Risco de churn; pinar versão.
4. **Paradigma de UI:** ACP não tem "digitar no terminal". Input do user = `session/prompt` (turnos).
   O `AgentNode` é chat-estruturado, não xterm — repensar a interação.
5. **`execution_host` SSH** (workers remotos, `pty/host.rs`): ACP é stdio local; ACP-sobre-SSH é fase futura.
6. **Codex/Gemini** via adapter + auth (login ChatGPT) — depois do Claude Code.

## Decisões propostas (travar antes do código)

- **D1 — Aditivo:** ACP é novo nó, **não substitui** o terminal. *(recomendado)*
- **D2 — Lado Client via SDK Rust oficial:** não reimplementar JSON-RPC, não depender de adapter
  Go/TS externo pro lado client (só o adapter do *agente* é externo). *(recomendado)*
- **D3 — Claude Code primeiro** no spike. *(recomendado)*
- **D4 — Validar auth (risco #1) antes de qualquer UI.** *(recomendado)*

## Fora do MVP (fases seguintes)

UI polida do `AgentNode`; Codex/Gemini; **conexões semânticas (Fase 2)** — output estruturado de A
vira input de B; review/diff-comment in-app; gating de permissão com política persistida
(allow/ask/blocked por tool); ACP-sobre-SSH; **checkpoint automático no fim de turno**; **memória
estruturada (Fase 8)** ingerindo tool-calls em vez de texto.

**Bônus do protocolo a explorar** (confirmados no handshake): `modes` nativos (`plan`,
`bypassPermissions`, `acceptEdits`, …) como base pronta do gating de permissão; `session/fork`
(forking de sessão — sinérgico com floors/worktrees); `session/load`+`resume` (retomar sessão);
`models` estruturados (mata o badge de modelo *stale*); `available_commands_update` (slash commands
do agente expostos como dado, não texto).

## Testing (quando codar)

Rust — **mock agent ACP** (binário que fala o JSON-RPC mínimo) → round-trip initialize / `session/new`,
parse de `session/update` (tool_call + diff), `acp_permission_respond`. **Sem rede, sem auth real.**

## Referências

- ACP: agentclientprotocol.com · Overview do protocolo · SDK Rust `docs.rs/agent-client-protocol`
  (`Client`, `AcpAgent`, `agent-client-protocol-tokio`) · adapter Claude Code mantido pelo Zed.
- Mapas do código (2026-06-30): `pty/session.rs:413` (`build_command`), `commands/pty.rs`,
  `pty/manager.rs`, `lib.rs:147` (`login_shell_path`), `Sidebar.tsx:203` (`PRESETS`),
  `components/nodes/TerminalNode.tsx`, `components/DiffViewerModal.tsx`, `store/canvas-store.ts`.
