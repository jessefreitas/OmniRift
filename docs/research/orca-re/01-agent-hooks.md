# RE 01 — Status de agente via push (agent-hooks)

> **Fonte primária:** `ref/ref-src/src/main/agent-hooks/`, `ref/ref-src/src/main/claude/hook-*.ts`, `ref/ref-src/src/shared/agent-hook-types.ts`, `ref/ref-src/src/shared/agent-status-types.ts`. Verificado contra o CLI que shipa em `ref/_appimage/.../out/cli/handlers/agent-hooks.js`.

## 1. O que é + por que importa pro OmniRift

A pergunta central de qualquer orquestrador multi-agente é: **"esse agente está trabalhando, travado esperando input, ou terminou?"**. A tentação ingênua é ler o stream do terminal (procurar prompts, spinners, "Done"). Isso é frágil por shell, por TUI, por idioma, e quebra a cada update do agente.

O ref **nunca** infere status do terminal. Em vez disso, ele instala *hooks* na config nativa de cada agente (Claude Code tem hooks, Codex tem, etc.). A cada evento de ciclo de vida o agente roda um script gerenciado pelo ref que faz `POST` de um JSON normalizado pra um listener HTTP loopback do ref. O comentário no topo de `agent-status-types.ts` é explícito:

> "Agent state normally comes from hooks; a narrow interrupt fallback may synthesize a final done state when an agent misses its own cancellation hook. **We still do not infer status from terminal titles anywhere in the data flow.**"

**Pro OmniRift:** isto substitui qualquer lógica de "adivinhar pelo PTY" no `src-tauri/src/agents/`. É a feature P0 #1 do teardown. Como o OmniRift é Claude-Code-first e já injeta config MCP por agente, dá pra entregar o hook do Claude primeiro com esforço pequeno.

## 2. Mapa de componentes (`ref-src/src/main/agent-hooks/`)

| Arquivo | Responsabilidade |
|---------|------------------|
| `server.ts` (62 KB) | O coração. Listener HTTP loopback; geração de porta/token; arquivo de endpoint; cache `last-status.json` (hydrate/TTL/atomic write); normalização do payload; máquina de estado + dedup por turno; broadcast pros listeners (renderer). `eslint-disable max-lines` justificado no topo (única exceção). |
| `managed-agent-hook-controls.ts` | Registro: lista `[agente, install/remove/getStatus]` pros 14 agentes. `installManagedAgentHooks()` roda todos no launch. |
| `installer-utils.ts` | Helpers locais: `readHooksJson`/`writeHooksJson`, `writeManagedScript`, `buildWindowsAgentHookPostCommand`. |
| `installer-utils-remote.ts` | Versões SSH (via `ssh2` SFTP) — instala hooks numa box remota. **Pular no MVP do OmniRift.** |
| `remote-managed-hook-installers.ts` | Orquestra instalação remota por conexão SSH. **Pular.** |
| `install-telemetry.ts` | Telemetria de instalação. |
| `src/main/<agente>/hook-service.ts` + `hook-settings.ts` | Um par por agente (claude, codex, gemini, cursor, …). Define os eventos do agente, o caminho da config, e gera o script. **Sem interface genérica** — cada agente é explícito. |

**Tipos compartilhados:**
- `src/shared/agent-hook-types.ts` — contrato de *instalação* (`AgentHookInstallStatus`) + `ORCA_HOOK_PROTOCOL_VERSION`.
- `src/shared/agent-status-types.ts` — contrato de *runtime* (a máquina de estado + `AgentStatusEntry`).

## 3. Modelo de dados (transcrito)

### 3.1 Instalação (`agent-hook-types.ts`)
```ts
export type AgentHookInstallState = 'installed' | 'not_installed' | 'partial' | 'error'
export type AgentHookInstallStatus = {
  agent: AgentHookTarget          // 'claude' | 'codex' | 'gemini' | ... (14)
  state: AgentHookInstallState
  configPath: string              // ex.: ~/.claude/settings.json
  managedHooksPresent: boolean
  detail: string | null
}
export const ORCA_HOOK_PROTOCOL_VERSION = '1' as const
```

### 3.2 Runtime (`agent-status-types.ts`)
```ts
export const AGENT_STATUS_STATES = ['working', 'blocked', 'waiting', 'done'] as const
export type AgentStatusState = (typeof AGENT_STATUS_STATES)[number]

// AgentType é ABERTO: qualquer string. União "well-known" é só conveniência.
export type AgentType = WellKnownAgentType | (string & {})

export type AgentStatusEntry = {
  state: AgentStatusState
  prompt: string            // último prompt do user; cacheado no turno (eventos de tool não trazem)
  updatedAt: number         // ms do último update
  stateStartedAt: number    // ms de quando o state atual começou (≠ updatedAt)
  agentType?: AgentType
  // paneKey composto: `${tabId}:${leafId}` (leafId = UUID estável do leaf de layout)
  // + toolName, toolInput, lastAssistantMessage, interrupted (só em done)
}

export const AGENT_STATE_HISTORY_MAX = 20   // histórico por agente, limitado p/ memória
```

Os 4 estados:
- **`working`** — agente processando (turno ativo, tool em execução).
- **`blocked`** — esperando permissão/aprovação (ex.: Claude `PermissionRequest`).
- **`waiting`** — turno acabou, esperando o próximo input do user (idle, pronto).
- **`done`** — turno concluído; `interrupted: true` se foi Ctrl+C/cancelamento.

## 4. Protocolo de fio (o suficiente pra reimplementar)

### 4.1 Variáveis de ambiente injetadas no PTY do agente
Quando o ref spawna o terminal do agente, injeta (de `server.ts:1402` + claude script):
```
ORCA_AGENT_HOOK_PORT      # porta efêmera do listener (server faz listen(0) → OS escolhe)
ORCA_AGENT_HOOK_TOKEN     # token aleatório (randomBytes) — auth do POST
ORCA_AGENT_HOOK_ENDPOINT  # caminho do "endpoint file" (ver 4.3)
ORCA_PANE_KEY             # identidade do pane: `${tabId}:${leafId}`
ORCA_TAB_ID
ORCA_AGENT_LAUNCH_TOKEN   # atribuição: qual lançamento gerou este agente
ORCA_WORKTREE_ID          # embute path do worktree
ORCA_AGENT_HOOK_ENV       # rótulo de ambiente
ORCA_AGENT_HOOK_VERSION   # = ORCA_HOOK_PROTOCOL_VERSION
```

### 4.2 O script gerenciado (POSIX — `claude/hook-service.ts`)
O hook do agente roda este script. Ele lê o JSON do hook do **stdin** e faz POST:
```sh
#!/bin/sh
# (opcional) pular se Devin importa hooks do .claude
if [ -n "$ORCA_AGENT_HOOK_ENDPOINT" ] && [ -r "$ORCA_AGENT_HOOK_ENDPOINT" ]; then
  . "$ORCA_AGENT_HOOK_ENDPOINT" 2>/dev/null || :     # carrega PORT/TOKEN vivos (ver 4.3)
fi
if [ -z "$ORCA_AGENT_HOOK_PORT" ] || [ -z "$ORCA_AGENT_HOOK_TOKEN" ] || [ -z "$ORCA_PANE_KEY" ]; then
  exit 0                                              # fail-open: sem coords → não faz nada
fi
payload=$(cat)                                        # o JSON do hook do agente, via stdin
[ -z "$payload" ] && exit 0
curl -sS -X POST "http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}/hook/claude" \
  --connect-timeout 0.5 --max-time 1.5 \             # best-effort: não trava o agente
  -H "Content-Type: application/x-www-form-urlencoded" \
  -H "X-ref-Agent-Hook-Token: ${ORCA_AGENT_HOOK_TOKEN}" \
  --data-urlencode "paneKey=${ORCA_PANE_KEY}" \
  --data-urlencode "tabId=${ORCA_TAB_ID}" \
  --data-urlencode "launchToken=${ORCA_AGENT_LAUNCH_TOKEN}" \
  --data-urlencode "worktreeId=${ORCA_WORKTREE_ID}" \
  --data-urlencode "env=${ORCA_AGENT_HOOK_ENV}" \
  --data-urlencode "version=${ORCA_AGENT_HOOK_VERSION}" \
  --data-urlencode "payload=${payload}"
```
(Variante Windows: `.cmd` com `call "%ORCA_AGENT_HOOK_ENDPOINT%"` + `buildWindowsAgentHookPostCommand`. Claude no Windows roda hooks via Git Bash → usa forward-slashes nos paths.)

**Por que form-urlencoded e não JSON?** O `worktreeId` embute um path; montar JSON à mão em shell POSIX quebra com aspas/newlines no path. Então manda o payload bruto do agente como um campo de form e deixa o receptor parsear.

### 4.3 O "endpoint file" (decisão crítica)
Problema: um PTY que sobreviveu a um restart do ref tem `PORT`/`TOKEN` velhos *baked* no env. A porta é efêmera → muda a cada start. Solução: o ref escreve um arquivo (`endpoint.sh` / `endpoint.cmd`) com `KEY=VALUE` das coords *vivas*; o script faz `source` dele antes de usar o env. Restart → arquivo atualizado → hooks antigos alcançam o servidor novo. (`server.ts: writeEndpointFile`, `ORCA_AGENT_HOOK_ENDPOINT`.)

### 4.4 Wiring na config do agente (Claude — `claude/hook-settings.ts`)
O ref faz merge de hooks em `~/.claude/settings.json` (NÃO `--strict`; preserva os hooks do user). Eventos cobertos:
```
UserPromptSubmit   → working (novo turno; carrega o prompt)
Stop               → waiting/done (turno acabou)
StopFailure        → done (OpenClaude pula Stop após erro de API; sem isso, "spinning" eterno)
PreToolUse  (*)    → working (+ toolName/toolInput pro dashboard)
PostToolUse (*)
PostToolUseFailure (*)
Notification/PermissionRequest (*) → blocked (esperando aprovação)
```
Cada `command` aponta pro script gerenciado. `matcher: '*'` nos tool events.

### 4.5 O servidor (`server.ts`)
- `createServer(...).listen(0, '127.0.0.1')` — **porta efêmera, loopback only** (`server.ts:1234`).
- Roteia por `new URL(req.url, 'http://127.0.0.1').pathname` → `/hook/{agent}`.
- Valida o header `X-ref-Agent-Hook-Token` contra o token gerado.
- **Normaliza** o payload (`server.ts:~1098`): length caps, colapsa newlines embutidos, impõe a invariante "`interrupted` só em `done`", retorna `null` em input malformado.
- Persiste em `last-status.json`: write atômico (tmp `.last-status-<pid>-<uuid>.tmp` + rename), versionado, hydrate no boot com TTL (descarta entries velhas).
- `notifyStatusChangeListeners()` → emite pro renderer (continuidade de UI + sparklines de atividade).

## 5. Ciclo de vida / fluxo de dados

```
Launch do ref
  └─ installManagedAgentHooks()  → p/ cada agente: merge hooks na config + escreve script gerenciado
  └─ AgentHookServer.start()     → listen(0,127.0.0.1); gera token; escreve endpoint file

User abre terminal de agente no canvas
  └─ PTY spawnado com env (PORT/TOKEN/ENDPOINT/PANE_KEY/...)

Agente roda → dispara hook (UserPromptSubmit/PreToolUse/Stop/...)
  └─ script gerenciado: source endpoint file → guards → POST form-urlencoded p/ /hook/{agent}

Servidor recebe
  └─ valida token → parseia form → normaliza payload (caps, invariantes) 
  └─ dedup por turno + transições (done→working, etc.)
  └─ atualiza cache em memória + last-status.json (atômico)
  └─ notifyStatusChangeListeners() → renderer atualiza o status do nó

Fallback (agente perdeu o hook de cancelamento)
  └─ se entry > AGENT_STATUS_STALE_AFTER_MS e veio Ctrl+C → sintetiza done {interrupted:true}
```

## 6. As partes difíceis (os `// Why:` que vão te morder)

1. **Endpoint file** (§4.3) — sem isso, todo PTY sobrevivente a restart fica órfão. Imprescindível.
2. **Fail-open em tudo** — script sem coords → `exit 0` silencioso; `curl` com timeout curto (0.5s/1.5s) pra nunca travar o agente; `. file 2>/dev/null || :` engole erro de TOCTOU/CRLF. A regra é: **o hook nunca atrapalha o agente**, mesmo que o ref esteja morto.
3. **form-urlencoded, não JSON** (§4.2) — quoting de path em shell.
4. **`interrupted` só em `done`** — invariante imposta na normalização; a história de estados preserva esse sinal pra lógica de retenção.
5. **Dedup e transições falsas** (`server.ts:640-758`):
   - `done`→`working` é transição real (novo turno) — não suprimir.
   - TUIs emitem tool/working **atrasado depois do Ctrl+C** → se o anterior era `done {interrupted}`, ignora o `working` tardio.
   - Droid: Ctrl+C não interrompe o turno; Ctrl+C repetido pode inferir turno interrompido — tratamento especial.
6. **`prompt` cacheado no turno** — só `UserPromptSubmit` traz o prompt; eventos de tool não. O servidor mantém o último conhecido.
7. **`paneKey` composto `${tabId}:${leafId}`** com `leafId` UUID estável de layout — sobrevive a re-render/realocação de pane. Tem alias-persistence listener pra migração de paneKey.
8. **Protocol version** (`'1'`) — receptor loga warning se vier de versão diferente (script velho de build antigo fica diagnosticável). Ainda em v1 porque a evolução foi aditiva.
9. **StopFailure** — OpenClaude/Claude pulam `Stop` após erro de modelo; sem cobrir `StopFailure`/`PostToolUseFailure`, o turno fica "girando" pra sempre.

## 7. Design de port pro OmniRift (Rust/Tauri)

### 7.1 Estrutura
```
src-tauri/src/agents/hooks/
  mod.rs               # AgentHookServer: estado público (port, token, endpoint path)
  server.rs            # listener loopback (axum ou hyper); rota POST /hook/{agent}
  status.rs            # AgentStatusState + AgentStatusEntry + normalização + invariantes
  store.rs             # cache em memória + last-status.json (write atômico tmp+rename, versionado, TTL)
  endpoint_file.rs     # escreve/atualiza endpoint.sh|cmd com PORT/TOKEN vivos
  install/
    mod.rs             # registro [agente → install/remove/status]
    claude.rs          # merge hooks em ~/.claude/settings.json + escreve script gerenciado
    script.rs          # gera o script POSIX/Windows (template do §4.2)
```

### 7.2 Decisões adaptadas
- **Listener:** `axum` num `tokio` task, `TcpListener::bind("127.0.0.1:0")` (porta efêmera), lê a porta real de `local_addr()`. Token via `rand`. Body `application/x-www-form-urlencoded` → `serde_urlencoded`.
- **Injeção de env:** no `portable-pty` `CommandBuilder.env(...)` no spawn do agente, setar as 8+ vars. O `paneKey` mapeia pro id do nó-terminal do canvas (use o node id do React Flow como `leafId`).
- **Status → frontend:** em vez do listener de renderer do ref, emitir um evento Tauri (`app_handle.emit("agent-status", entry)`) que o nó do canvas escuta. Persistir em SQLite (já temos) em vez de/ além do `last-status.json` — uma tabela `agent_status` chaveada por paneKey, com hydrate no boot.
- **Endpoint file:** mesmíssimo padrão; escrever em `~/.local/share/omnirift/agent-hook-endpoint.sh`.
- **Instalador Claude:** ler `~/.claude/settings.json`, merge dos 7 eventos apontando pro nosso script gerenciado (preservar hooks do user — merge, não overwrite), escrever o script em `~/.local/share/omnirift/hooks/claude.sh` com +x.
- **Fail-open:** replicar os timeouts curtos do curl e os guards. Nunca deixar o hook travar o agente.

### 7.3 MVP (entregar primeiro)
1. Só **Claude Code**. Listener + token + endpoint file + injeção de env + instalador `~/.claude/settings.json` + script gerenciado + os 4 estados.
2. Eventos mínimos: `UserPromptSubmit`(working), `PreToolUse`(working+tool), `Notification`(blocked), `Stop`+`StopFailure`(waiting/done).
3. Evento Tauri pro nó do canvas pintar o estado (cor/badge: trabalhando/travado/esperando/pronto).
4. `last-status` em SQLite + hydrate.
**Depois:** Codex (segundo hook-service), fallback de interrupt por stale, histórico de atividade (sparkline), dedup de transições tardias.

### 7.4 O que PULAR
- Instalação remota via SSH (`installer-utils-remote.ts`, `remote-managed-hook-installers.ts`).
- Os 12 agentes além de Claude/Codex (adicionar sob demanda).
- Chaves HMAC de trust do Codex; marcadores OSC-777; migração de paneKey legado.

## 8. Apêndice — caminhos `ref-src` citados
- `src/main/agent-hooks/server.ts` (listener, last-status, normalização, fallback)
- `src/main/agent-hooks/managed-agent-hook-controls.ts` (registro dos 14 agentes)
- `src/main/agent-hooks/installer-utils.ts` (+ `-remote.ts`)
- `src/main/claude/hook-service.ts` (script gerenciado POSIX/Windows)
- `src/main/claude/hook-settings.ts` (`CLAUDE_EVENTS`, merge em `~/.claude/settings.json`)
- `src/shared/agent-hook-types.ts` (contrato de instalação + protocol version)
- `src/shared/agent-status-types.ts` (máquina de estado + `AgentStatusEntry`)
- CLI que shipa: `ref/_appimage/resources/app.asar.unpacked/out/cli/handlers/agent-hooks.js`
