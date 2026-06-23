# OmniRift — Status de implementação das specs

> **Auditado em 2026-06-23** cruzando cada spec de `docs/superpowers/specs/` contra o
> **código real** (módulos existem + estão *wired* + testes), não contra os checkboxes
> dos planos. `cargo test --lib` = **101 testes passando**. Gerado/atualizável pelo
> comando **`/audit`**.

## ⚠️ Os checkboxes dos planos NÃO são fonte de verdade

O contador `X/N` do painel SPECS conta `- [x]` nos planos — e **ninguém marca** os
checkboxes ao implementar. Exemplos reais:

| Plano | Checkbox | Realidade |
|---|---|---|
| `herdr-detection-engine` | 0/53 | ✅ **DONE** (9 testes Rust) |
| `beta-tester-program` | 0/54 | ✅ **DONE** (testes vitest) |
| `memory-provider-backend` | 6/48 | ✅ **DONE** (Fase 1) |

**Para saber se algo está implementado:** olhe (1) este arquivo, (2) o módulo de código,
(3) `git log` — nunca o `X/N`.

## Resumo

- ✅ **DONE: 14** &nbsp;·&nbsp; 🔶 **PARCIAL: 3** &nbsp;·&nbsp; ⏳ **design-only: 0**

| Spec | Status | Plano | Evidência (código) |
|---|---|---|---|
| herdr-detection-engine | ✅ DONE | concluído | `pty/detector.rs` (estados + `agent://status`, 9 testes) |
| herdr-orchestration-api | ✅ DONE | concluído | `mcp/tools.rs` — 8 tools `terminal_*` (ack `pty://ready`) |
| herdr-floors | ✅ DONE | concluído | `canvas-store` floors[] + `FloorCanvas.tsx` + MCP `workspace_*` |
| spec-driven-parallel-floors | ✅ DONE | concluído | `git/mod.rs` (worktrees) + `floor_git_*` + dispatch paralelo + Land c/ review gate |
| maestri-brain-interface (memória plugável) | ✅ DONE | concluído | `memory/` (trait + Local/OmniMemory/Obsidian + Registry) + wiring no spawn + `ConnectionsModal` |
| multi-projeto-canvas-isolado | ✅ DONE | concluído | `canvas-store` projects[] + persistência V3 + migração + `ProjectTabs` |
| agent-skill-layer | ✅ DONE | concluído | `skill_wiring.rs` (por CLI) + Skills no role + `SkillLaunchPicker` (11 testes) |
| resource-monitor | ✅ DONE | concluído | `metrics/` (sysinfo + GPU nvidia-smi + ring) + `ResourcePanel` |
| review-policy-improvements | ✅ DONE | concluído | presets + contexto/supressões + histórico SQLite + pathRules + auto-fix + diff inline |
| code-review-ia-byok | ✅ DONE | concluído | `commands/llm.rs` (BYOK) + `lib/review.ts` (GO/NO-GO) + gate no Land |
| fase3-sqlite-persistence | ✅ DONE | concluído | `db.rs` (rusqlite, auto-save/restore) + `persistence-client` (teste roundtrip) |
| license-worker | ✅ DONE¹ | concluído | worker: `/signup` `/activate` `/refresh` `/webhooks/asaas` `/download` `/donate` `/diag` + D1 |
| licensing-strong-entitlement | ✅ DONE | concluído | `commands/license.rs` (verify Ed25519 offline, gates) + worker server-side |
| beta-tester-program | ✅ DONE² | concluído | `beta.ts` (`/signup/beta` `/admin/beta/{renew,list,mint}`) + `BetaInviteModal` + vitest |
| compressores-token-plugaveis | 🔶 PARCIAL | parcial | backend trait + proxy nativo OK; **decoração/métricas não wired no Rust** (roda via JS) |
| **fase9-code-workspace-debug-ia** | 🔶 PARCIAL | parcial | **9a editor ✅ + 9c métricas ✅** (`code/metrics.rs`, `code_metrics`, badge cx, 10 testes); **9b/9d/9e faltam** |
| spec-lifecycle-e-orquestracao | 🔶 PARCIAL | parcial | A/B/D feitos (`spec.rs` status, teto de agentes); **falta Bloco E (coordenação)** |

¹ Desvio deliberado: checkout hospedado (não assinatura inline) + SMTP (não Resend).
² Desvio: beta signup roda no frontend (`license-client.ts`), não no command Rust.

## Pendências reais (o que falta nos 3 parciais)

### 🔶 fase9-code-workspace-debug-ia (2 de 5 sub-fases)
- ✅ **9a** editor Monaco (CodeNode) · ✅ **9c** complexidade ciclomática/cognitiva/MI + badge "cx N" (tree-sitter; Halstead reduzido a Volume — consciente).
- ❌ **9b** MCP client stdio (JSON-RPC outbound) + **Serena pool** (`tokio::process`, reuso por projeto, teto 3) — nada feito.
- ❌ **9d** **DebuggerAgent** (depende do 9b): spawn de agente "debugger" com Serena+Memory, monta prompt (arquivo+diff+métricas+refs), aplica fix via `replace_symbol_body`.
- ❌ **9e** painel de boas práticas: thresholds **configuráveis por linguagem** (hoje hardcoded em `metrics.rs`), painel completo (4 métricas, não só o badge), highlighting inline no editor.

### 🔶 compressores-token-plugaveis
- Decoração de env no Rust **não wired no spawn** (composição feita em JS `compress-client.ts`).
- **Métricas/SavingsReport ausentes** (tokens economizados, badge, evento `compress://savings`).
- RTK PATH-shim + merge do `agent_wiring()` do Headroom no MCP.

### 🔶 spec-lifecycle-e-orquestracao
- **Bloco E (coordenação)**: claims/blackboard + detecção pró-ativa de `paths:` cruzados são contrato textual, não código (`paths` é parseado, mas sem checagem de sobreposição na UI).
- Gate de aprovação antes do fan-out (além do teto de agentes).

## Arquivamento proposto (anti-regressão)

As **14 specs DONE** deveriam ser **arquivadas** (`docs/superpowers/specs/archive/` + os
planos pra `plans/archive/`) — o painel SPECS desabilita dispatch em spec arquivada, então
nenhum agente re-implementa algo já pronto (= regressão). **Continuam ativos** os 3 parciais.

## Fora do escopo das specs (roadmap, não iniciado)
- **Fase 7** — "Ombro" (LLM local) + bridges OmniForge.
- **Fase 8.2** — multi-DB via `sqlx` (Postgres compartilhado). Keychain (8.2 secret_store) já feito.
- **Dialogs** `window.prompt` (nome de branch, URL github, motivo de ignore) — no-op no WebKitGTK, precisa de modal de input próprio (os `alert/confirm` já foram migrados pros dialogs nativos).
