# Mission Orchestration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** transformar o Orquestrador OmniRift em maestro com capabilities tipadas, missão em DAG com wait real, verify de entregável e cadeia de eventos validável.

**Architecture:** módulo Rust `mission/` (dag/events/verify/capabilities puros + runner) sobre `orchestrator::dispatch_task` com blocking real; tools MCP `capability_*` / `mission_*`; front via `mission-client.ts`. Spec: `docs/superpowers/specs/2026-07-25-mission-orchestration-design.md`.

**Tech Stack:** Rust (Tauri 2, rusqlite, tokio), MCP embutido (`mcp/`), PTY detector settle, React/TS.

---

## File Structure

| Path | Ação | Responsabilidade |
|---|---|---|
| `apps/desktop/src-tauri/src/mission/*.rs` | Create | dag, events, verify, capabilities, runner |
| `apps/desktop/src-tauri/src/orchestrator/mod.rs` | Modify | Wait real em blocking |
| `apps/desktop/src-tauri/src/mcp/tools.rs` | Modify | Schemas + handlers + blocking wait no dispatch |
| `apps/desktop/src-tauri/src/mcp/server.rs` | Modify | Roteamento `capability_*` / `mission_*` |
| `apps/desktop/src/lib/agent-contract.ts` | Modify | Preâmbulo missões / AMBIGUOUS |
| `apps/desktop/src/lib/mission-client.ts` | Create | IPC tipado |
| `apps/desktop/src/lib/pipeline-templates.ts` | Modify | deps nos planos |
| `apps/desktop/src/lib/pipeline-client.ts` | Modify | `deps?` em PipelineAgent |

---

## Fases

- [x] Spec limpa (sem referências externas)
- [ ] **C0** Wait real + contrato
- [ ] **C1** Capabilities
- [ ] **C2** mission_events + validate_chain
- [ ] **C3** DAG + mission_run
- [ ] **C4** Verify

Ver spec §5 para critérios de done por fase.
