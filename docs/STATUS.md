# OmniRift — Status de implementação das specs

> **Auditado em 2026-07-06** cruzando cada spec de `docs/superpowers/specs/` contra o
> **código real** (módulos existem + estão *wired* + testes), não contra os checkboxes
> dos planos. `cargo test --lib` = **541 testes passando** (out-of-the-box: o `build.rs`
> stuba os sidecars ausentes em debug — ver B1 abaixo). Gerado/atualizável pelo `/audit`.
>
> ⚠️ **Atualização 07-06:** a auditoria de 06-23 estava defasada — **Fase 9 = 5/5** e
> **Bloco E implementado** (o código shippou depois de 06-23 e ninguém atualizou o doc).

## ⚠️ Os checkboxes dos planos NÃO são fonte de verdade

O contador `X/N` do painel SPECS conta `- [x]` nos planos — e **ninguém marca** os
checkboxes ao implementar. **Para saber se algo está implementado:** olhe (1) este arquivo,
(2) o módulo de código, (3) `git log`/`releases.ts` — nunca o `X/N`.

## Resumo

- ✅ **DONE: 16** &nbsp;·&nbsp; 🔶 **PARCIAL: 1** &nbsp;·&nbsp; ⏳ **design-only: 0**

| Spec | Status | Evidência (código) |
|---|---|---|
| herdr-detection-engine | ✅ DONE | `pty/detector.rs` (estados + `agent://status`, 9 testes) |
| herdr-orchestration-api | ✅ DONE | `mcp/tools.rs` — 8 tools `terminal_*` (ack `pty://ready`) |
| herdr-floors | ✅ DONE | `canvas-store` floors[] + `FloorCanvas.tsx` + MCP `workspace_*` |
| spec-driven-parallel-floors | ✅ DONE | `git/mod.rs` (worktrees) + `floor_git_*` + dispatch paralelo + Land c/ review gate |
| maestri-brain-interface (memória plugável) | ✅ DONE¹ | `memory/` (trait + Local/OmniMemory/Obsidian + Registry) + wiring no spawn + `ConnectionsModal` |
| multi-projeto-canvas-isolado | ✅ DONE | `canvas-store` projects[] + persistência V3 + migração + `ProjectTabs` |
| agent-skill-layer | ✅ DONE | `skill_wiring.rs` (por CLI) + Skills no role + `SkillLaunchPicker` (11 testes) |
| resource-monitor | ✅ DONE | `metrics/` (sysinfo + GPU nvidia-smi + ring) + `ResourcePanel` |
| review-policy-improvements | ✅ DONE | presets + contexto/supressões + histórico SQLite + pathRules + auto-fix + diff inline |
| code-review-ia-byok | ✅ DONE | `commands/llm.rs` (BYOK) + `lib/review.ts` (GO/NO-GO) + gate no Land + Stop hook |
| fase3-sqlite-persistence | ✅ DONE | `db.rs` (rusqlite, auto-save/restore) + `persistence-client` (teste roundtrip) |
| license-worker | ✅ DONE² | worker: `/signup` `/activate` `/refresh` `/webhooks/asaas` `/download` `/donate` `/diag` + D1 |
| licensing-strong-entitlement | ✅ DONE | `commands/license.rs` (verify Ed25519 offline, gates) + worker server-side |
| beta-tester-program | ✅ DONE³ | `beta.ts` (`/signup/beta` `/admin/beta/{renew,list,mint}`) + `BetaInviteModal` + vitest |
| **fase9-code-workspace-debug-ia** | ✅ **DONE** | **5/5**: 9a Monaco (`CodeNode`), 9b Serena pool (`mcp/serena_pool.rs`, 28 fns/testes) + MCP stdio, 9c métricas (`code/metrics.rs`, badge cx), 9d **DebuggerAgent** (`commands/debug.rs` + `agent-debug.ts`, role "debugger"), 9e painel (`CodeComplexityPanel` + thresholds via `ReviewPolicyModal`) |
| **spec-lifecycle-e-orquestracao** | ✅ **DONE** | A/B/D (`spec.rs`) + **Bloco E** (`mcp/claims.rs` — claims/blackboard + overlap de `paths`) |
| compressores-token-plugaveis | 🔶 PARCIAL | backend trait + proxy nativo + **SavingsReport** (`compress-client.ts` + badge no `TerminalNode`) OK; **falta só o wiring 100%-Rust** (ver abaixo — funcional via JS) |

¹ get-by-id/forget do OmniMemory provider são stubs `// TODO Fase 2` (`memory/omnimemory.rs:161`) — deliberado: agentes usam as tools nativas via `agent_wiring`. Fase 1 completa.
² Desvio deliberado: checkout hospedado (não assinatura inline) + SMTP (não Resend).
³ Desvio: beta signup roda no frontend (`license-client.ts`), não no command Rust.

## Pendências reais (o único parcial)

### 🔶 compressores-token-plugaveis — só polish de arquitetura, tudo funciona
- **`decorate()` do compress não wired no spawn Rust** (`compress/provider.rs`): a composição de env é feita em JS (`compress-client.ts`). Funciona; a invariante "só env" mora no frontend, não no backend (P2 da auditoria).
- **RTK PATH-shim** (`compress/rtk.rs:68`) + **merge do `agent_wiring()` do Headroom no MCP** (`compress/headroom.rs`) — features avançadas do compress, núcleo (proxy + SavingsReport) já entrega.

## Deferrals conscientes (NÃO são bugs — documentados no código)
- **`.env` acessível pelo FileTree/Preview** (`commands/fs.rs:39`): deliberado + testado — `.env` é arquivo de projeto que o usuário quer ver. O gate "diretório de projeto aberto" entra quando o backend tiver esse conceito.
- **OmniMemory `get()`/`forget()`** = stubs Fase 2 (ver nota ¹).

## B1 — RESOLVIDO (2026-07-06)
Num clone fresco os `externalBin` `omnicompress-*` faltam em `binaries/` (gitignored, só
populados no release) e o build-script do tauri validava a existência → `cargo test`/`--debug`
quebravam. **Fix:** `build.rs` cria stubs vazios quando ausentes, **só em `PROFILE=debug`**
(release exige os binários reais). `cargo test --lib` agora roda out-of-the-box.

## Fora do escopo das specs (roadmap, não iniciado)
- **Fase 7** — OmniPartner (companion BYOK + LLM local) **✅ feito**; faltam as bridges OmniForge.
- **Fase 8.2** — multi-DB via `sqlx` (Postgres compartilhado). Keychain (8.2 secret_store) já feito.
- **R1** OmniFS GC/prune · **R2** Aprender A2–A4 · **R3** Mobile 4G relay Tasks 5–8 · **R5** diff rico plano×andamento · **R6** OmniFS proveniência por agente.
- **Dialogs** `window.prompt` (nome de branch, URL github, motivo de ignore) — no-op no WebKitGTK, precisa de modal de input próprio.

## Entregue recentemente (pós-0.1.124)
- **v0.1.125** — **failproof embutido no binário**: todo agente spawnado nasce com os hooks de aprendizado (captura erro→fix + injeta fix conhecido), flag-gated (`failproof-agents`, kill-switch). `commands/review_cfg.rs` (`ensure_failproof_scripts` + `inject_failproof_hooks`, 2 testes).
- **failproof (tool `tools/failproof/`)**: modelo de confiança observado/validado + WAL + `0o700` + sync OmniMemory opt-in (72 testes).
- **Landing** reestruturada em 4 seções (20 features) — live em `omnirift.omniforge.com.br`.
