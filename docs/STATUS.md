# OmniRift — Status de implementação das specs

> **Auditado em 2026-06-23** cruzando cada spec de `docs/superpowers/specs/` contra o
> **código real** (módulos existem + estão *wired* + testes), não contra os checkboxes
> dos planos. Rodado por 4 auditores paralelos. `cargo test --lib` = **91 testes passando**.

## ⚠️ Os checkboxes dos planos NÃO são fonte de verdade

O contador `X/N` que aparece no painel SPECS conta `- [x]` nos planos — e **ninguém
marca** os checkboxes ao implementar. Exemplos reais desta auditoria:

| Plano | Checkbox | Realidade |
|---|---|---|
| `herdr-detection-engine` | 0/53 | ✅ **DONE** (9 testes Rust) |
| `herdr-floors` | 0/24 | ✅ **DONE** |
| `beta-tester-program` | 0/54 | ✅ **DONE** (testes vitest) |
| `memory-provider-backend` | 6/48 | ✅ **DONE** (Fase 1) |

**Para saber se algo está implementado:** olhe (1) este arquivo, (2) o módulo de código,
(3) `git log` — nunca o `X/N`.

## Resumo

- ✅ **DONE: 14** &nbsp;·&nbsp; 🔶 **PARCIAL: 3** &nbsp;·&nbsp; ⏳ **só-design: 0**

| Spec | Status | Evidência (código) |
|---|---|---|
| herdr-detection-engine | ✅ DONE | `pty/detector.rs` (máquina de estados, evento `agent://status`, 9 testes) + `StatusDot.tsx` |
| herdr-orchestration-api | ✅ DONE | `mcp/tools.rs` — 8 tools `terminal_*` (spawn com ack `pty://ready`) |
| herdr-floors | ✅ DONE | `canvas-store` floors[] + `FloorCanvas.tsx` + MCP `workspace_*` |
| spec-driven-parallel-floors | ✅ DONE | `git/mod.rs` (worktrees) + `floor_git_*` + painel Dispatch paralelo + Land c/ review gate |
| maestri-brain-interface (memória plugável) | ✅ DONE | `memory/` (trait + Local/OmniMemory/Obsidian + Registry) + wiring no spawn (`mcp.rs`) + `ConnectionsModal.tsx` |
| multi-projeto-canvas-isolado | ✅ DONE | `canvas-store` projects[] + persistência V3 + migração + `ProjectTabs.tsx` |
| agent-skill-layer | ✅ DONE | `skill_wiring.rs` (por CLI) + seção Skills no role + `SkillLaunchPicker` (11 testes) |
| resource-monitor | ✅ DONE | `metrics/` (sysinfo + GPU nvidia-smi + ring buffer) + `ResourcePanel.tsx` |
| review-policy-improvements | ✅ DONE | presets + contexto/supressões editáveis + histórico SQLite + pathRules + auto-fix + diff inline |
| code-review-ia-byok | ✅ DONE | `commands/llm.rs` (BYOK OpenAI/Anthropic/Ollama) + `lib/review.ts` (GO/NO-GO) + gate no Land |
| fase3-sqlite-persistence | ✅ DONE | `db.rs` (rusqlite, auto-save/restore) + `persistence-client.ts` (teste roundtrip) |
| license-worker | ✅ DONE¹ | worker: `/signup` `/activate` `/refresh` `/revoke` `/webhooks/asaas` `/download` `/donate` + D1 |
| licensing-strong-entitlement | ✅ DONE | `commands/license.rs` (verify Ed25519 offline, gates community/full nos 3 pontos) + worker server-side |
| beta-tester-program | ✅ DONE² | `beta.ts` (`/signup/beta` `/admin/beta/{renew,list,mint}`) + `BetaInviteModal` + testes vitest |
| spec-lifecycle-e-orquestracao | 🔶 PARCIAL | A/B/D feitos (`spec.rs` status, teto de agentes); **falta Bloco E** |
| compressores-token-plugaveis | 🔶 PARCIAL | backend trait + proxy nativo OK; **decoração/métricas não wired no Rust** (roda via JS) |
| fase9-code-workspace-debug-ia | 🔶 PARCIAL | só **9a** (CodeNode/Monaco); faltam métricas/debugger/serena |

¹ Desvio deliberado: usa **checkout hospedado** (não assinatura inline) + **SMTP** (não Resend).
² Desvio: beta signup roda no frontend (`license-client.ts`), não no command Rust `license_signup_beta`.

## Pendências reais (o que falta nos 3 parciais)

### 🔶 compressores-token-plugaveis
- Decoração de env no Rust **não está ligada no spawn** — composição é feita em JS (`compress-client.ts`); falta `CompressorRegistry`/`effective_for`/`decorate()` em `commands/pty.rs`.
- **Métricas/SavingsReport ausentes** — sem tokens economizados, badge no node, total agregado, evento `compress://savings` (RTK_STATS_DIR é setado mas nada lê).
- RTK PATH-shim não gerado; `agent_wiring()` do Headroom não é merged no MCP config.

### 🔶 fase9-code-workspace-debug-ia
- Só a sub-fase **9a** (editor Monaco) existe.
- Faltam: **9c** métricas nativas (tree-sitter/cyclomatic/cognitive/halstead — tree-sitter está no Cargo mas nunca é invocado), **9d** DebuggerAgent, **9b** MCP client stdio + Serena pool, **9e** painel de boas práticas.

### 🔶 spec-lifecycle-e-orquestracao
- **Bloco E (coordenação)**: claims/blackboard e detecção pró-ativa de `paths:` cruzados são **contrato textual** no orquestrador, não código wired (o `paths` é parseado em `parse_frontmatter`, mas não há checagem de sobreposição ligada na UI).
- Aprovação do usuário antes do fan-out depende do contrato, sem gate de código além do teto de agentes.

## Notas

- Os planos `herdr-*` (`0/N` checkboxes) estão **implementados** — os checkboxes nunca foram marcados. Vale re-sincronizar ou parar de exibir o `X/N`.
- "Desvios deliberados" (checkout hospedado, SMTP, signup no frontend, OmniCompress nativo via JS) são evoluções conscientes vs. o design original — atendem os critérios de aceitação por caminho diferente, não são pendências.
