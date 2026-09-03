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

- ✅ **DONE: 33** · 🔶 **PARCIAL: 3** · ⏳ **DESIGN-ONLY: 2** &nbsp;(total: 38 specs ativas)

## Tabela spec × status × evidência

| Spec | Status | Evidência (código) |
|---|---|---|
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
| omnipartner-aprender (06-28) | ✅ DONE | Núcleo socrático e anti-vazamento em `learn/mod.rs` + `learn/tracks.rs` (trilhas embutidas sh/py/js/html) + `learn/profile.rs` (progresso durável via `MemoryProvider`) + grounding Context7 (`learn_ask_grounded`) + Kanban integration em `CompanionModal.tsx`. |
| controle-remoto-4g-relay (06-29) | 🔶 PARTIAL | Fase 1 túnel DONE (`relay-worker` DO + `relay_client.rs`). **Fase 2 Push/FCM ausente.** |
| acp-agent-layer (06-30) | ✅ DONE | `acp/mod.rs` (1526 linhas, AcpManager) + `commands/acp.rs` + `acp-client.ts` + `AgentNode.tsx` |
| acp-hermes-integration (06-30) | ✅ DONE | `acp/mod.rs` adapter hermes (uvx) + `hermes_provider_env` (Nível 1) |
| conexoes-semanticas-fase2 (06-30) | ✅ DONE | `ReviewNode.tsx`/`FilterNode.tsx` + `useConnectionRouting.ts` (payload tipado) |
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
| grok-patterns-acp-sandbox-secrets (07-16) | ✅ DONE | ACP id-correlation (`next_rpc_id`+`pending` map); path-scrub `$HOME`→`~`/`<user>` no `redactor`; flag `sandbox-workspace` no painel + `sandbox_set_enabled` (UI∨env). Incrementos futuros da spec (reconexão ACP, seccomp) = roadmap. |
| canvas-fluency-gate (07-25) | ✅ DONE | Detector+wiring (`canvas-fluency.ts`, watchdog/`trackNodeMount`, `FluencyChip`). Harness determinístico `scripts/canvas-jank-bench.sh` + telemetria de store-writes por fase e desempate empírico de `DragBuffer` (97% de redução de escritas de posição com 500 nós). |

## Pendências reais (o que está em aberto)

### 🔶 PARCIAIS acionáveis
1. **controle-remoto-4g-relay** — Fase 1 (túnel) DONE; **Fase 2 Push/FCM não-iniciada** (sem FCM no relay-worker, sem sinal `Blocked`). (= roadmap R3 Mobile.)

### ⏳ DESIGN-ONLY não-iniciados (backlog real)
1. **jornada-onboarding-produto** — feature inteira não construída (7 missões, sandbox, spotlight overlay, watcher, testes).
2. **hook-library** — catálogo de hooks por role/nó + `CustomHook` no Rust. Nada implementado.

### 🗑️ Arquivadas / superseded (fora da contagem ativa)
- **spec-lifecycle-e-orquestracao** (06-16) — `superseded_by` 2026-07-09-orquestracao. Blocos A/B/E DONE; teto de agentes (Bloco D) migrou pra orquestração. Arquivo: `specs/archive/2026-06-16-spec-lifecycle-e-orquestracao-design.md`.
- **times-grupo-subagentes** (06-30) — `superseded_by` 2026-07-09-orquestracao. Só Fase 0 stopgap (`SubagentNode`); núcleo descartado. Arquivo: `specs/archive/2026-06-30-times-grupo-subagentes-design.md`.

### Polish pós-DONE (não conta como PARCIAL)
- **backend-owned-sessions** — contrato central DONE; polish menor: `acp_sleep`/wake ainda não são comando de 1ª classe (kill reusa `acp_cancel`).

## Fora do escopo das specs (roadmap, não backlog-dívida)
- Fases futuras **por design**: Constructor Fase 2/3, orquestracao camadas 5/6/7, omniswitch Fase 2, hermes-wizard keychain Fase 3. Não são "em aberto pendente" — são incrementos planejados.
- **VOICE MODE / paridade Claude Code embutido**: ✅ DONE (strip de envs SSH/remote em sessões locais PTY, garantia de `XDG_RUNTIME_DIR` + bind no sandbox `bwrap` para PipeWire/PulseAudio/ALSA `arecord`, e sincronização de `oauthAccount` + ativação automática de `voice` tap mode PT no `settings.json` isolado).
- **Acentos/cedilha (dead-key/CompositionEvent no WebKitGTK)**: tratado — terminal (`ime-dedup` no forwarder PTY) + `SafeInput`/`SafeTextarea` (gate de composição + paste). Chat ACP/Goal/Loop do AgentNode migrados. Residual: inputs crus pontuais (números/checkbox/JSON schema) fora do caminho de prosa PT. RC manual: digitar `começar`/`ção` no terminal e no input do AgentNode (WebKitGTK+IBus). Sem spec.
