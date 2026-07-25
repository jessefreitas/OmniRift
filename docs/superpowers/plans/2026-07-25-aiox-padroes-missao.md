# AIOX → Missão: padrões M1–M4 (implementation plan)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans. Steps use checkbox (`- [ ]`) syntax.
>
> Spec: `docs/superpowers/specs/2026-07-25-aiox-aprendizados-design.md`
> Missão: `docs/superpowers/specs/2026-07-25-mission-orchestration-design.md`
>
> **Não** integrar `@aiox-squads/core` / vendorar `.aiox-core`. Clean-room only.

**Goal:** absorver first-value, handoff tipado, suggested-next e doctor no host
OmniRift (Missão + spawn + dock), sem segundo control plane.

**Architecture:** funções puras TS/Rust + pontos de injeção já existentes
(AgentNode priming, `buildRoleSpawn`/`firstMessage`, `pty_write` pós-ready,
blackboard `memory_*`, `mission_events`, OrchestratorDock).

**Tech Stack:** React/TS (desktop), Rust Tauri (`mission/`, `mcp/`, `memory/`),
MCP `mission_*` / `orchestrator_*`, testes puros via `scripts/run-*-tests.mjs`.

---

## Achados da inspeção (branch `feat/mission-orchestration`)

| Área | Estado atual |
|---|---|
| `mission/` | `capabilities`, `dag`, `events`, `runner`, `verify` — MCP `mission_*` / `capability_*` |
| Spawn PTY | `Sidebar.spawnRole` / `spawnOrchestrator`, `buildRoleSpawn`, `TerminalNode.switch*` |
| Spawn ACP | `AgentNode` priming persona + AGENTS.md quando `status === "ready"` |
| Contrato | `ORCHESTRATOR_CONTRACT` / `DEV_CONTRACT` em `agent-contract.ts` (longo, silencioso) |
| Dock | `OrchestratorDock.tsx` — host do xterm; sem suggested-next |
| Handoff | `orchestrator_handoff` + ask/tell prosa; sem schema tipado no blackboard |
| Doctor | `health/scan` = saúde de código; sem checks de orquestração (PATH/MCP/memory/worktree) |

Gap M1 concreto: spawns claude-code com system-prompt nos args **não** mandam
1ª mensagem → nó mudo até input humano.

---

## File structure (previsto)

| Path | M | Ação |
|---|---|---|
| `apps/desktop/src/lib/first-value.ts` | M1 | Create — builder puro |
| `apps/desktop/src/lib/first-value.test.ts` | M1 | Create |
| `apps/desktop/scripts/run-first-value-tests.mjs` | M1 | Create |
| `apps/desktop/src/lib/agent-spawn.ts` | M1 | Modify — `firstMessage` sempre com greeting |
| `apps/desktop/src/components/nodes/AgentNode.tsx` | M1 | Modify — priming |
| `apps/desktop/src/components/Sidebar.tsx` | M1 | Modify — orch + shell wrap |
| `apps/desktop/src/lib/orchestration-client.ts` | M1 | Modify — spawn MCP |
| `apps/desktop/src-tauri/src/mission/handoff.rs` (ou memory key) | M2 | Create |
| `apps/desktop/src-tauri/src/mcp/tools.rs` | M2/M4 | Modify |
| `apps/desktop/src/components/OrchestratorDock.tsx` | M3 | Modify |
| `apps/desktop/src/lib/mission-suggested-next.ts` | M3 | Create |
| `apps/desktop/src-tauri/src/orchestration/doctor.rs` | M4 | Create |
| `apps/desktop/src/components/OrchestrationDoctorPanel.tsx` | M4 | Create (UI) |

---

## M1 — First-value no spawn

### Objetivo

Após spawn (PTY idle/done ou ACP ready), sessão recebe bloco **5–8 linhas**:
persona/label, status, comandos chave, próximo passo; opcional floor /
missão / capability. Sem emoji excessivo, sem teatro.

### API

```ts
// apps/desktop/src/lib/first-value.ts
type FirstValueKind = "orchestrator" | "worker" | "agent";

type FirstValueCtx = {
  label: string;
  role?: string;
  kind?: FirstValueKind;
  floor?: string;
  status?: string;       // default "pronto"
  missionId?: string;
  capability?: string;
  keyCommands?: string[];
  nextStep?: string;
};

function defaultKeyCommands(kind: FirstValueKind): string[];
function buildFirstValueGreeting(ctx: FirstValueCtx): string; // 5–8 linhas
function withFirstValueGreeting(body: string | undefined, ctx: FirstValueCtx): string;
```

### Arquivos a tocar

1. `first-value.ts` + teste + runner script + `package.json` script
2. `agent-spawn.ts` — todo `RoleSpawn` devolve `firstMessage` com greeting
   (prepend se já houver persona; só greeting se system-prompt nos args)
3. `AgentNode.tsx` — prepend no priming persona
4. `Sidebar.tsx` — `spawnOrchestrator` injeta greeting pós-ready; shell wrap
5. `orchestration-client.ts` — após `orchestrator://spawn-agent`, inject greeting

### Testes (TDD)

- [x] greeting tem 5–8 linhas não-vazias
- [x] inclui label + Status
- [x] comandos default por kind (orch vs worker)
- [x] missionId/capability aparecem só se passados
- [x] `withFirstValueGreeting` prepend + body; body vazio → só greeting
- [x] sem emoji de teatro (sem 🎭/🚀 no builder)

### Critério de done

- [x] Função pura + testes (`npm run test:first-value` no desktop)
- [x] Spawn role claude-code: `buildRoleSpawn` sempre devolve `firstMessage` com greeting
- [x] ACP AgentNode priming começa com o bloco
- [x] Orquestrador spawn injeta greeting pós-ready
- [x] `orchestrator://spawn-agent` injeta greeting pós-ready
- [x] Zero dependência AIOX

---

## M2 — Handoff tipado

### Objetivo

Artefato consumível no blackboard; greeting do próximo cita o handoff
não-consumido.

### Schema

```ts
type MissionHandoff = {
  from: string;
  to: string;
  last_command: string;
  decisions: string[];
  files_modified: string[];
  blockers: string[];
  next_action: string;
  consumed: boolean;
  timestamp: string; // ISO
};
// key: handoff:<missionId>:<from>:<to>
```

### API

| Camada | Superfície |
|---|---|
| Rust | `mission::handoff::{save, load_pending, mark_consumed}` sobre `Db` / MemoryProvider |
| MCP | `mission_handoff_write`, `mission_handoff_read`, `mission_handoff_consume` |
| TS | `mission-client.ts` + `first-value` lê pending pro `nextStep` |

### Arquivos

- `apps/desktop/src-tauri/src/mission/handoff.rs` (+ `mod.rs`)
- `mcp/tools.rs` + `mcp/server.rs` schemas/handlers
- `mission-client.ts`
- `first-value` / AgentNode: se pending handoff → `nextStep` aponta chave
- Testes Rust unitários no módulo + TS puro do parser

### Testes

- [ ] round-trip JSON no key `handoff:…`
- [ ] `consumed=true` some da lista pending
- [ ] greeting do alvo inclui `next_action` do handoff
- [ ] validate: campos obrigatórios rejeitam vazio `from`/`to`

### Critério de done

- Handoff gravado sem prosa solta; próximo agente consome uma vez; evento
  opcional `handoff_written` / `handoff_consumed` na cadeia (se couber sem
  quebrar `validate_chain` atual).

---

## M3 — Suggested-next no dock

### Objetivo

Após `layer_finished` / `gate_passed` / `gate_failed`, UI sugere próximo
passo acionável.

### API

```ts
// mission-suggested-next.ts (puro)
type SuggestedNext = {
  label: string;          // "QA · mission_verify"
  reason: string;         // "layer 1 finished"
  missionId: string;
  action?: "verify" | "dispatch" | "approve" | "retry";
};

function suggestNext(events: MissionEvent[], pkg: MissionPackage): SuggestedNext | null;
```

### Arquivos

- `mission-suggested-next.ts` + teste
- `OrchestratorDock.tsx` — faixa acima do xterm com sugestão + botão
- Listener `mission://event` ou poll via `mission_events_list` no dock
- Opcional: toast OmniPartner espelhando a mesma sugestão

### Testes

- [ ] após layer N finished com N+1 no DAG → sugere dispatch do próximo nó
- [ ] após acceptance pending → sugere `mission_verify`
- [ ] `gate_failed` → sugere retry/humano
- [ ] `delivered` → null (sem sugestão)

### Critério de done

- Dock mostra sugestão visível (assert DOM quando houver testing-library;
  até lá: teste puro do selector + wiring manual).

---

## M4 — Doctor orquestração

### Objetivo

Diagnóstico “por que a frota não ativa?” — paralelo, fail-soft.

### Checks

| Check | Passa se |
|---|---|
| CLI PATH | `claude` / `codex` / engines usados resolvem |
| MCP | server `omnirift-agents` up + token ok |
| Memory | provider ativo responde `test` |
| Worktree | floor cwd é git worktree válido (se floor ativo) |
| Hooks | settings Stop/review presentes pro role claude |

### API

```rust
// orchestration/doctor.rs ou mission/doctor.rs
struct DoctorReport { checks: Vec<DoctorCheck>, ok: bool }
// Tauri: orchestration_doctor() -> DoctorReport
// MCP: orchestration_doctor (read-only)
```

### Arquivos

- Rust doctor + comando Tauri + MCP tool
- UI painel simples (Connections area ou modal no dock)
- Testes: checks com PATH mock / fail-soft

### Critério de done

- Um comando devolve relatório estruturado; UI lista ❌/✅; sem healers
  destrutivos no dia 1 (só diagnóstico).

---

## Ordem de execução

```
M1 (esta sessão se barato) → M2 → M3 → M4
```

Não misturar M2–M4 na mesma PR sem necessidade. Cada M = commit focado +
testes do módulo.

---

## Fora de escopo

- Integrar / vendorar AIOX
- Context brackets / AgentPack / `human_approved` (M5+)
- Pocket slim
- Merge em `main` sem pedido explícito
