# RPC mutations (spawn/kill/send via CLI) — Design (Fase 2 do #8)

> Status: active · 2026-06-25. Fase 2 do ref #8 (read-only MVP já shipou no v0.1.35).
> Branch feat/rpc-mutations. Destrava: CLI controla agentes + boot-test de 8 agentes automatizável.

**Goal:** adicionar métodos de ESCRITA ao registro RPC (#8A) pra pilotar agentes pela CLI/socket:
criar, enviar input, e matar agente. Hoje o RPC é read-only (status/agents.list/pty.snapshot).

## Segurança (decisão central)
As mutações ficam **SÓ no socket local** (CLI, socket Unix 0600 = só o usuário). **NÃO entram na
`MOBILE_RPC_METHOD_ALLOWLIST`** — o mobile continua read-only no MVP (steering mobile = opt-in futuro,
exige UX de confirmação). Reusa o token de sessão do #8A. Validação de params via serde (erro claro).

## Métodos novos (`rpc/methods.rs`)
- **`agent.spawn`** params `{command, args?, cwd?, label?, executionHost?}` → gera session_id, chama
  `PtyManager::spawn` (reusa o cfg do `pty_spawn`), **emite evento `rpc://agent-spawned`** (o frontend
  cria o TerminalNode no canvas — agente nasce visível). Retorna `{sessionId, label}`.
- **`agent.send`** params `{sessionId, input}` → `PtyManager::write` (reusa o padrão do `do_send_task`:
  texto → 200ms → `\r` p/ TUIs raw-mode submeterem). Retorna `{ok}`. `not_found` se a sessão sumiu.
- **`agent.kill`** params `{sessionId}` → `PtyManager::kill`. Retorna `{ok}`. Idempotente.

## CLI (`cli/`)
Comandos `omnirift spawn <command> [--args ...] [--cwd P] [--label L]`, `omnirift send <sessionId> <texto>`,
`omnirift kill <sessionId>`. Specs declarativas (help DRY) + handlers que montam params + chamam o socket.

## Frontend (canvas)
Listener `rpc://agent-spawned` no app → adiciona um TerminalNode na store do canvas (posição auto,
reusa o fluxo de "novo agente") apontando pra sessão já spawnada no backend (o PTY já existe — o node só
ATTACHA via sessionId, não re-spawna). Agente criado pela CLI aparece no canvas como qualquer outro.

## Decomposição
- **A (backend+CLI):** rpc/methods.rs (3 write methods, fora da allowlist) + emit do evento + cli/ (3 comandos). Toca rpc/ + cli/.
- **B (frontend):** listener rpc://agent-spawned → cria/attacha TerminalNode (sessão já existe, não re-spawna). Toca o app React. Disjunto de A (depende só do contrato do evento).

## Testing
- cargo: dispatch de cada método valida params (faltou sessionId/command → erro); agent.kill idempotente;
  os 3 NÃO estão na allowlist mobile (teste explícito: `is_allowed("agent.spawn", Mobile)` == false).
- CLI: parse dos 3 comandos novos + help.
- tsc: o listener tipado.
- Boot-test (real): `omnirift spawn bash` ×8 contra o app rodando → 8 nodes no canvas, minimizar, sem crash
  (fecha o aceite do #6 que ficou manual). GLM 5.2 audita (foco: injeção no command spawnado, allowlist).
