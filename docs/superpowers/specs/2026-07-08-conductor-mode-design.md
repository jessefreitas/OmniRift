# Modo Conductor — Barra de Orquestração por Texto

> **Status:** DRAFT → implementação ativa · 2026-07-08
> **Branch:** `feat/conductor-mode` (isolada de `feat/omniswitch`)
> **Não afeta:** nada do fluxo atual — feature flag `conductorMode` (toggle), default OFF

## O que é

Uma barra de texto fixa embaixo do canvas onde você escreve comandos em linguagem natural,
endereça agentes com `@`, e o canvas inteiro responde. O Claude Code atua como **Conductor**
(o maestro invisível) — interpreta, decompõe, despacha, media e reporta.

## O que JÁ existe (não recriar)

| Componente | Onde | O que faz |
|---|---|---|
| `orchestratorSid` | `canvas-store.ts:263` | Campo que define qual agente é o orquestrador |
| `orchestration_send` | `mcp/tools.rs:963` | MCP tool: fan-out de mensagem pra grupo de agentes |
| `resolve_group` | `mcp/mod.rs` | Resolve `@all`, `@idle`, `@worktree:<floor>`, `@<role-ou-label>` |
| `agent_snapshot` | `mcp/tools.rs:agent_snapshot` | Lista agentes com estado (idle/working/blocked/done) |
| `dispatchSpec` | `Sidebar.tsx:dispatchSpec` | Despacha spec pro orquestrador (prompt injetado no PTY) |
| `sendTeamBriefing` | `Sidebar.tsx` | Briefing automático entre agentes MCP |
| `FlowEdge.tsx` | `components/edges/` | Animação idle/sending/received/error nas edges |
| `edgeFlow` | `canvas-store.ts:63` | Estado visual de cada edge |
| `ACP` | `acp/mod.rs` + `acp-client.ts` | Protocolo de agentes (spawn, message, update) |
| `llm_chat` | `commands/llm.rs` | Chamada LLM stateless (modo Leve) |
| `analyzeCanvas` | `lib/companion.ts` | Snapshot do canvas pro LLM |
| `addTerminal` | `canvas-store.ts:544` | Spawna novo agente/terminal no canvas |

## Arquitetura — 4 camadas

```
Barra de Input (texto)
     │
     ▼
┌──────────────────────┐
│ Parser determinístico │  ← regex/PEG, zero LLM. Resolve @, pipe |, |. Devolve ParsedCommand.
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Conductor Engine      │  ← Claude Code (default) | Codex | Hermes | LLM leve | Shell
│ (maestro invisível)   │     Investiga (fs, memory) → decide → despacha via MCP tools
│ hidden: true no canvas│     Recebe respostas como tool_result → continua raciocínio
└──────────┬───────────┘
           │ despacha via orchestrator_dispatch (MCP tool blocking)
           ▼
┌──────────────────────┐
│ Router + Executor     │  ← resolve @nome → AgentNode ID + floor
│ (Rust, orchestrator/) │     despacha via ACP (acp_send_message) ou PTY (pty_send_text)
│                       │     captura acp://update → retorna como tool_result
└──────────┬───────────┘
           │
           ▼
┌──────────────────────┐
│ Agentes (nós visíveis)│  ← cada um no seu floor (worktree git)
│ Backend, Reviewer...  │     usam MCP tools (fs, git, kanban, memory...)
│                       │     emitem acp://update quando terminam
└──────────────────────┘
```

## Novas MCP tools (extendem `orchestration_*` existente)

### 1. `orchestrator_dispatch` (blocking)
Despacha tarefa pra agente. Espera resultado (blocking) ou retorna task_id (async).
```json
{
  "name": "orchestrator_dispatch",
  "description": "Despacha uma tarefa para outro agente no canvas. Use quando você precisa de outro agente para continuar seu trabalho. Blocking = espera resultado. Async = retorna imediatamente com task_id.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": {"type": "string", "description": "@nome | @role:x | @all | @idle | @worktree:floor"},
      "task": {"type": "string", "description": "a tarefa em linguagem natural"},
      "context": {"type": "string", "description": "contexto adicional (diff, logs, etc.)"},
      "priority": {"type": "string", "enum": ["blocking", "async"], "default": "blocking"}
    },
    "required": ["target", "task"]
  }
}
```

### 2. `orchestrator_status`
Lista estado de todos os agentes. Já existe `agent_snapshot` internamente — expor como tool.
```json
{
  "name": "orchestrator_status",
  "description": "Lista o estado de todos os agentes no canvas (idle/working/blocked/done). Use antes de despachar pra saber quem está disponível.",
  "inputSchema": {"type": "object", "properties": {}}
}
```

### 3. `orchestrator_spawn_agent`
Cria um novo agente no canvas. O Conductor chama quando nenhum agente existente tem a capacidade.
```json
{
  "name": "orchestrator_spawn_agent",
  "description": "Cria um novo agente no canvas. Use quando nenhum agente existente tem a capacidade necessária. O agente nasce no floor especificado, com o CLI e role dados.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "name": {"type": "string"},
      "cli": {"type": "string", "enum": ["claude", "codex", "hermes", "shell"]},
      "model": {"type": "string", "description": "modelo (null = default do CLI)"},
      "floor": {"type": "string", "description": "active | new:<branch> | <floor-id>", "default": "active"},
      "role": {"type": "string"},
      "systemPrompt": {"type": "string", "description": "persona (null pra shell)"},
      "startupCmd": {"type": "string"},
      "mcpTools": {"type": "array", "items": {"type": "string"}}
    },
    "required": ["name", "cli"]
  }
}
```

### 4. `orchestrator_handoff`
Passa trabalho adiante com contexto.
```json
{
  "name": "orchestrator_handoff",
  "description": "Passa o trabalho atual para outro agente com contexto. Use quando você terminou sua parte e o próximo agente precisa continuar.",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": {"type": "string"},
      "context": {"type": "string"},
      "artifacts": {"type": "array", "items": {"type": "string"}}
    },
    "required": ["target", "context"]
  }
}
```

### 5. `orchestrator_query`
Pergunta algo a outro agente sem despachar tarefa.
```json
{
  "name": "orchestrator_query",
  "description": "Pergunta algo a outro agente sem despachar tarefa. Use pra obter informação (ex: 'qual endpoint você usa?').",
  "inputSchema": {
    "type": "object",
    "properties": {
      "target": {"type": "string"},
      "question": {"type": "string"}
    },
    "required": ["target", "question"]
  }
}
```

## Engine do Conductor — plugável

```rust
enum ConductorEngine {
    /// Modo leve — uma chamada llm_chat, stateless, sem tools.
    Llm,
    /// Modo agente — spawn de um agente real como Conductor.
    Agent(AgentSpec),
}

struct ConductorConfig {
    engine: ConductorEngine,
    cli: CliFamily,         // default: Claude Code
    model: Option<String>,  // default: null (usa default do CLI)
    role: Option<String>,    // persona do maestro
}
```

### Auto-seleção
- Input com `@` explícito + tarefa clara → Parser resolve, Conductor LLM não entra (zero tokens)
- Input sem `@` ou ambíguo → Conductor LLM/Agent decide
- Pipe `@a X | @b Y` → Parser + sequenciador determinístico

### Configurável na barra
Seletor dropdown: Claude Code (default) | Codex | Hermes | Leve (LLM) | Shell (zero LLM)

## Conexão e retorno de resultados

### Blocking (síncrono)
```
Conductor chama orchestrator_dispatch({target: "@backend", task: "fix X", priority: "blocking"})
  → Rust resolve @backend → AgentNode
  → Despacha via ACP: acp_send_message(backend_session, "fix X")
  → Backend processa (Claude Code B), usa MCP tools, emite acp://update {status: "done", content: "..."}
  → Rust captura update, retorna como tool_result pro Conductor
  → Conductor recebe e continua raciocínio
```

### Async (não-bloqueante)
```
Conductor chama orchestrator_dispatch({target: "@frontend", task: "cria login", priority: "async"})
  → Retorna imediatamente: {task_id: "tk_007", status: "dispatched"}
  → Frontend processa em paralelo
  → Quando termina, Rust injeta notification no ACP do Conductor
  → Conductor vê: "[ASYNC DONE] frontend (tk_007): criou login.tsx"
```

## Floors e worktrees

- Agente que edita código → floor próprio (worktree isolado via `git worktree add`)
- Agente que só lê/executa (reviewer, deployer) → floor ativo
- Conductor decide qual floor ao chamar `orchestrator_spawn_agent`
- Conflito de mesmo arquivo em mesmo floor → Conductor cria floor novo automaticamente

## Stream de orquestração

Painel lateral (toggle) mostrando o histórico de comandos e respostas:
```
[09:32] você → @backend corrige o bug
[09:32] backend → recebido, iniciando...
[09:34] backend → done: fix aplicado
[09:34] você → @reviewer revisa
[09:35] reviewer → APPROVED
```

Persistido em SQLite:
```sql
CREATE TABLE IF NOT EXISTS orchestration_log (
  id TEXT PRIMARY KEY,
  timestamp INTEGER,
  source TEXT,
  target TEXT,
  payload TEXT,
  status TEXT,
  stage INTEGER,
  parent_id TEXT
);
```

## Componentes novos

| Arquivo | LOC est. | Descrição |
|---|---|---|
| `components/ConductorBar.tsx` | ~180 | Barra de input + seletor de engine |
| `components/OrchestratorStream.tsx` | ~250 | Painel lateral com histórico |
| `lib/orchestration/parser.ts` | ~120 | Parser determinístico (@, pipe, |) |
| `lib/orchestration/conductor.ts` | ~150 | Cliente do Conductor (LLM + Agent) |
| `lib/orchestration/stream-client.ts` | ~80 | SSE/polling da orchestration_log |
| `src-tauri/src/orchestrator/mod.rs` | ~300 | Router + executor + aggregator |
| `src-tauri/src/commands/orchestrator.rs` | ~120 | Commands Tauri pra frontend |
| `db.rs` | +15 | Tabela `orchestration_log` |

## Feature flag — zero impacto no fluxo atual

```typescript
// canvas-store.ts
conductorMode: boolean;  // default: false
// Quando false: barra não aparece, tudo funciona como antes
// Quando true: barra aparece, canvas vira painel de visualização
```

Toggle via botão na sidebar (ícone maestro) ou `Ctrl+Shift+C`.

## Como testar (build isolado)

1. Branch `feat/conductor-mode` — não afeta `main` nem `feat/omniswitch`
2. `npm run tauri:dev` — feature flag OFF, nada muda
3. Toggle Conductor Mode → barra aparece
4. Digitar `@backend olá` → despacha pro agente "backend"
5. Digitar `cria um agente deployer` → Conductor cria novo agente
6. Stream mostra histórico
7. Desabilitar Conductor Mode → tudo volta ao normal
