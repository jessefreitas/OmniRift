---
status: active
title: Missão — orquestração com recibo
date: 2026-07-25
related:
  - docs/superpowers/specs/2026-07-09-orquestracao-design.md
  - docs/superpowers/plans/2026-07-25-mission-orchestration.md
---

# Missão — orquestração com recibo

**Goal:** elevar o Orquestrador do OmniRift de “despachador de PTY” para **maestro com
promessa tipada, execução em layers e prova no disco** — sem abandonar o princípio
“humano no fan-out”.

**Por que agora:** o substrato existe (PTY/ACP, floors/worktrees, `claim_*`,
`agent_ask`/`tell`, `orchestration_log`, Pipeline Architect, `gate:land`). Falta a
camada que transforma isso em missão verificável.

**Relação com a orquestração 07-09:** este design é a **camada acima** das 7 camadas
já especificadas. Camadas 1–4 continuam; Missão consome `orchestrator_dispatch` + wait
real + eventos. Camadas 5/7 passam a reagir a eventos de missão.

---

## 1. Contratos

1. **Orquestrador ≠ produtor.** Só despacha, gateia e emite recibo. Nunca escreve o entregável do usuário.
2. **Capability > role name.** Unidade de descoberta: `domain.subdomain.verb` com inputs/outputs, `examples`, `not_for`.
3. **Recibo ou não aconteceu.** Cadeia mínima de eventos. Sem evento no log, “done” é mentira (`validate_chain`).
4. **Dois eixos de gate, ortogonais.**
   - **Gate de merge** (`gate:land` / worktree) — “pode integrar o branch?”
   - **Gate de entregável** — “o brief pediu X e X existe no disco, não-stub, passa regra?”
5. **DAG com layers.** Deps explícitas + topo-sort + layer N bloqueada até N−1. Sem wait real no dispatch blocking, onda é teatro.
6. **Persona com fingerprint.** No spawn/dispatch, gravar hash da persona no audit.
7. **AMBIGUOUS é feature.** Match limpo → despacha. Ambíguo → top-N pro humano. Zero match → recusa + sugere criar capability.
8. **Handoff bounded** (fase posterior). Resumo + paths + acceptance como artefato, não scrollback cru.
9. **Core neutro + adapter por runtime.** Formalizar o que cada runtime aguenta.
10. **Humano no fan-out permanece.** Spawn de frota pede aprovação; teto rígido.

### Anti-padrões

- Org autônoma zero-human como default (conflita com Floor=Time e aprovação humana).
- Registry global no `$HOME` fora do projeto/floor.
- Keyword router como source of truth (só diagnostic).
- Segundo cockpit web paralelo ao canvas.
- Factories de conteúdo no dia 1 sem capability+gate+audit.

---

## 2. Vocabulário

| Conceito | Significado |
|---|---|
| **Mission brief** | Pedido do humano em prosa |
| **Capability** | Promessa tipada `domain.subdomain.verb` |
| **MissionPackage** | Plano versionado (nós + deps + acceptance) |
| **Mission Runner** | Executor de layers sobre o Orquestrador |
| **mission_events** | Cadeia SQLite validável |
| **verify** | Gate de entregável (≠ `gate:land`) |
| **Role revision** | Persona pack com hash no audit |

Floor continua sendo a unidade org. Não há entidade “company”.

---

## 3. Arquitetura

```
HUMANO / OmniPartner
        │
        ▼
Orquestrador (dispatch-only)
        │
brief → capability_match → plan_dag
        │
        ▼
Mission Runner (layers · wait · audit)
        │
   ┌────┼────┐
   ▼    ▼    ▼
dispatch  ask/tell  verify (+ gate:land ortogonal)
   │
   ▼
mission_events → validate_chain → Canvas / monitor
```

### Capability

Campos: `id`, `description`, `domains`, `inputs`/`outputs`, `examples`/`not_for`, `invoke`.

Routing: `HIGH` | `AMBIGUOUS` | `NO_MATCH`.

### MissionPackage

```ts
type MissionNode = {
  id: string;
  role: string;
  capability?: string;
  deps: string[];
  parallelSafe?: boolean;
  task: string;
};

type AcceptanceRule =
  | { kind: "path_exists"; path: string }
  | { kind: "path_not_stub"; path: string; minBytes?: number }
  | { kind: "command"; cmd: string; cwd?: string };
```

### Eventos

`brief_received` → `plan_committed` → `layer_started` → `dispatch` → `persona_injected?` → `layer_finished` → `gate_passed|gate_failed` → `delivered|failed`.

`validate_chain` falha se faltar dispatch de nó planejado, se `delivered` vier sem `gate_passed`, ou se persona declarada tiver sha vazio.

### Verify vs Land

| | Verify | Land |
|---|---|---|
| Pergunta | Brief cumprido? | Worktree pode integrar? |
| Input | `AcceptanceRule[]` | Rotina `gate:land` |

---

## 4. Superfície

MCP: `capability_list|search|upsert`, `mission_create|run|status|validate_chain|verify`.

Front: Pipeline Architect emite deps; dock pode mostrar timeline de `mission_events`.

---

## 5. Fases

| Fase | Entrega |
|---|---|
| **C0** | Preâmbulo dispatch-only + wait real em blocking |
| **C1** | Registry de capabilities + MCP |
| **C2** | `mission_events` + `validate_chain` + create/status |
| **C3** | DAG + `mission_run` |
| **C4** | Verify engine + fecha missão |

### Fora de escopo

Org charts autônomos, factories de conteúdo, FS hard-lock, rubrics LLM sofisticadas no MVP.

---

## 6. Critério de sucesso (MVP)

Humano descreve outcome → Orquestrador monta MissionPackage com capabilities → Runner executa layers com wait → verify confere disco → `validate_chain` prova a história — sem mentir “done”.
