# OmniRift — Status de implementação das specs

> **Auditado em 2026-07-20** (v0.1.143) cruzando cada spec de `docs/superpowers/specs/`
> contra o **código real** (módulo existe + está *wired* em `lib.rs`/MCP router/frontend +
> idealmente teste), não contra os checkboxes dos planos. Auditoria paralela de 4 agentes.
>
> **Validação por execução real (2026-07-20):**
> - `cargo test --lib` (src-tauri, Rust) → ✅ **715 passed · 0 failed · 1 ignored**
> - `apps/relay-worker` (vitest) → ✅ **4 passed**
> - `services/license-worker` (vitest) → ⚠️ **erro de infra do vitest-pool-workers (miniflare)** — o pool nem subiu; **não-conclusivo**, não é regressão de asserção.

## ⚠️ Os checkboxes dos planos NÃO são fonte de verdade

O contador `X/N` do painel SPECS conta `- [x]` nos planos — e **ninguém marca** ao implementar.
Exemplos reais desta auditoria:
- **turbo-mode-loop-engineering** e **omniswitch** estão marcadas "draft" no design mas **100% implementadas e wired**.
- **conductor-mode** foi renomeada para **Constructor** no código (`conductorMode`→`constructorMode`, `ConductorBar`→`ConstructorBar`) — o design antigo não reflete isso.

**Para saber se algo está implementado:** olhe (1) este arquivo, (2) o módulo de código, (3) `git log` — nunca o `X/N`.

## Resumo

- ✅ **DONE: 32** · 🔶 **PARCIAL: 4** · ⏳ **DESIGN-ONLY: 3** &nbsp;(total: 39 specs)

## Tabela spec × status × evidência

| Spec | Status | Evidência (código) |
|---|---|---|
| spec-lifecycle-e-orquestracao (06-16) | 🔶 PARTIAL | Blocos A/B/E DONE (`spec.rs`, `commands/spec.rs`, `mcp/claims.rs`). **Superseded_by 07-09.** |
| compressores-token-plugaveis (06-17) | ✅ DONE | `compress/` (trait+rtk+headroom+omnicompress) + `compressor_list/savings` + `CompressorsModal.tsx` |
| acoes-com-backup (06-24) | ✅ DONE | `health/backup.rs` (`health_backup*`, reflink) + `AiReportView.tsx`/`health-tracker.ts` |
| agent-status-push-hooks (06-24) | ✅ DONE | rota `POST /agent-hook/{label}` + injeção de hooks em `review_cfg.rs` (teste) |
| import-agente-como-role (06-24) | ✅ DONE | `commands/role_import.rs` (codex-toml/claude-md) + `RolesSection.tsx` |
| r2-release-mirror (06-24) | ✅ DONE | worker `RELEASES: R2Bucket` + `/download` R2-first + job `mirror` no release.yml |
| turbo-mode-loop-engineering (06-24) | ✅ DONE | `turbo/` (commands+driver+mod) + `TurboPanel.tsx` (design diz "draft", código real) |
| visualizadores-pdf-html (06-24) | ✅ DONE | `PdfNode.tsx`/`HtmlNode.tsx` registrados em `FloorCanvas.tsx` nodeTypes |
| cli-rpc-substrate (06-25) | ✅ DONE | `rpc/` (core+methods+socket) + `rpc::start` no setup + CLI `omnirift-cli` |
| design-mode-grab (06-25) | ✅ DONE | `lib/grab/` + `useGrabMode.ts` + integrado em `PortalNode.tsx` |
| fanout-ssh (06-25) | ✅ DONE | `pty/host.rs` (ssh://) + `commands/hosts.rs` + `mcp/groups.rs::resolve_group` |
| mobile-devices-panel (06-25) | ✅ DONE | `MobileDevicesModal.tsx` + `mobile-client.ts` (pairing/list/steering/revoke) |
| mobile-relay (06-25) | ✅ DONE | `rpc/{keypair,e2ee,ws,devices,pairing,allowlist}.rs` + `start_mobile_relay` no setup |
| mobile-steering (06-25) | ✅ DONE | `rpc/devices.rs` (`steer`) + `allowlist.rs` (`MOBILE_STEER_ALLOWLIST`, teste) |
| painel-complexidade-projeto (06-25) | ✅ DONE | Backend `code_metrics_project` + `CodeMetricsPanel.tsx` (tabela/sort/filtro/drill-down/Analisar IA) + Sidebar/CommandPalette |
| routines-mvp (06-25) | ✅ DONE | `commands/routines.rs` (tabelas `routines`/`routine_runs`, 5 comandos) |
| rpc-mutations (06-25) | ✅ DONE | `rpc/methods.rs` (`agent.spawn/send/kill`) + CLI + `orchestration-client.ts` (attach) |
| terminal-backend-owned (06-25) | ✅ DONE | `pty/emulator.rs` (`TermEmulator` s/ alacritty_terminal) + `pty_snapshot` + `useTerminalSession.ts` |
| windows-named-pipe (06-25) | ✅ DONE | `rpc/socket.rs` (`#[cfg(windows)]` named-pipe) — não buildável no Linux (por design) |
| omnipartner-aprender (06-28) | 🔶 PARTIAL | Núcleo socrático (`learn/mod.rs` + `CompanionModal`) OK. **Faltam módulos MVP** (draft). |
| controle-remoto-4g-relay (06-29) | 🔶 PARTIAL | Fase 1 túnel DONE (`relay-worker` DO + `relay_client.rs`). **Fase 2 Push/FCM ausente.** |
| acp-agent-layer (06-30) | ✅ DONE | `acp/mod.rs` (1526 linhas, AcpManager) + `commands/acp.rs` + `acp-client.ts` + `AgentNode.tsx` |
| acp-hermes-integration (06-30) | ✅ DONE | `acp/mod.rs` adapter hermes (uvx) + `hermes_provider_env` (Nível 1) |
| conexoes-semanticas-fase2 (06-30) | ✅ DONE | `ReviewNode.tsx`/`FilterNode.tsx` + `useConnectionRouting.ts` (payload tipado) |
| times-grupo-subagentes (06-30) | ⏳ DESIGN-ONLY | Só Fase 0 stopgap (`SubagentNode.tsx`). **Superseded_by 07-09.** |
| hermes-wizard-provider-model (07-01) | ✅ DONE | `HermesWizard.tsx` (3 passos) + `hermes_list_models` + `provider_config` no spawn |
| backend-owned-sessions (07-02) | ✅ DONE | `acp/mod.rs` (state Running/Sleeping/Dead, event_log, `acp_attach`/`acp_gc`) + virtualização |
| jornada-onboarding-produto (07-04) | ⏳ DESIGN-ONLY | **Nada implementado** (sem tour-store/TourOverlay/missões). |
| failproof (07-05) | ✅ DONE | `tools/failproof/` (CLI+CI) + hooks instalados + watchdog (3 camadas) |
| orchestration-watchdog (07-05) | ✅ DONE | `lib/orchestration/watchdog.ts` (teste) + `useOrchestrationWatchdog.ts` (frontend, não Rust) |
| smoke-boot-gate (07-05) | ✅ DONE | `scripts/smoke-boot.sh` + jobs `smoke`/`smoke-gate` no CI/release |
| code-ast-chunker (07-06) | ✅ DONE | `code/chunk.rs` (`BoundaryChunker`) + tool MCP `code_chunks` (testes) |
| omnigraph-symbol-body (07-06) | ✅ DONE | `commands/omnigraph.rs` (`graph_node_body`) + `SymbolBodyModal.tsx` (testes) |
| omniswitch-llm-key-router (07-07) | ✅ DONE | `llm_router/` (7 arquivos) + boot no setup + comandos `omniswitch_*` (Fase 1) |
| conductor-mode (07-08) | ✅ DONE | `orchestrator/` + 5 MCP tools + `OrchestratorStream.tsx` (renomeado → Constructor) |
| constructor-copilot (07-09) | ✅ DONE | `ConstructorBar.tsx`/`ConstructorPanel.tsx` + flag `constructorMode` (Fase 1; 2/3 futuras) |
| orquestracao (07-09) | ✅ DONE | tools `agent_status/ask/tell` + `mcp/marker.rs` (núcleo camada 4; 5/6/7 futuras) |
| hook-library (07-10) | ⏳ DESIGN-ONLY | **Nada implementado** (sem catálogo frontend nem `CustomHook` no Rust). |
| grok-patterns-acp-sandbox-secrets (07-16) | 🔶 PARTIAL | Redação + sandbox + ACP `fs/*` parciais. Faltam id-correlation ACP, path-scrub, flag UI. |

## Pendências reais (o que está em aberto)

### 🔶 PARCIAIS acionáveis
1. **grok-patterns-acp-sandbox-secrets** — segurança/robustez ACP: (a) id-correlation do ACP não feito (usa stopgap `AtomicBool` = 1 request in-flight por tipo); (b) path-scrubbing `$HOME`→`~`/username ausente no `redactor.rs`; (c) flag de sandbox não está no painel de flags (só via env).
2. **omnipartner-aprender** — núcleo socrático wired, mas faltam `learn/tracks.rs`/`session.rs`/`profile.rs` + persistência do perfil via `MemoryProvider`. Spec ainda é "draft". (= roadmap R2 Aprender A2–A4.)
3. **controle-remoto-4g-relay** — Fase 1 (túnel) DONE; **Fase 2 Push/FCM não-iniciada** (sem FCM no relay-worker, sem sinal `Blocked`). (= roadmap R3 Mobile.)
4. **spec-lifecycle-e-orquestracao** — blocos A/B/E DONE; superseded pela orquestração 07-09 (ver candidatos a arquivar). Conta no total PARCIAL da tabela até o archive fechar.

### ⏳ DESIGN-ONLY não-iniciados (backlog real)
5. **jornada-onboarding-produto** — feature inteira não construída (7 missões, sandbox, spotlight overlay, watcher, testes).
6. **hook-library** — catálogo de hooks por role/nó + `CustomHook` no Rust. Nada implementado.

### 🗑️ Candidatos a ARQUIVAR (não são trabalho — são limpeza anti-regressão)
- **spec-lifecycle-e-orquestracao** (06-16) — `superseded_by` 2026-07-09-orquestracao. O "teto de agentes" (Bloco D) passou pra responsabilidade da spec de orquestração. *(arquivado em `specs/archive/` neste working tree)*
- **times-grupo-subagentes** (06-30) — `superseded_by` 2026-07-09-orquestracao. Só a Fase 0 stopgap landou; o núcleo foi descartado a favor da orquestração nova. *(arquivado em `specs/archive/` neste working tree)*

### Polish pós-DONE (não conta como PARCIAL)
- **backend-owned-sessions** — contrato central DONE; polish menor: `acp_sleep`/wake ainda não são comando de 1ª classe (kill reusa `acp_cancel`).

## Fora do escopo das specs (roadmap, não backlog-dívida)
- Fases futuras **por design**: Constructor Fase 2/3, orquestracao camadas 5/6/7, omniswitch Fase 2, hermes-wizard keychain Fase 3. Não são "em aberto pendente" — são incrementos planejados.
- **VOICE MODE / paridade Claude Code embutido** (backlog feature #4, memórias blackboard #119/#121/#122): não tem spec formal ainda. Diagnóstico pronto; fix de 3 frentes (Tauri capabilities de mic + PATH `arecord`/SoX no spawn + auth Claude.ai no config-dir isolado).
- **Acentos/cedilha (dead-key/CompositionEvent no WebKitGTK)**: bug de input confirmado, sem tratamento no código. Sem spec.
