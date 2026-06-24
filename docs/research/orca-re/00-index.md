# Engenharia reversa do ref — programa de estudo

**Objetivo:** entender o ref a fundo o suficiente pra *reimplementar* os subsistemas que o OmniRift quer, no nosso stack (Tauri 2 / Rust + React 19 + canvas). Não é "ler e admirar" — cada doc aqui termina num **design de port pro OmniRift**.

## Material disponível (tudo gitignorado sob `ref/`)

| O quê | Caminho | Pra quê |
|-------|---------|---------|
| **Fonte legível (MIT)** | `ref/ref-src/` | verdade de leitura — TS comentado, ~5.700 arquivos. **É a fonte primária de estudo.** |
| **CLI compilado que SHIPA** | `ref/_appimage/resources/app.asar.unpacked/out/cli/` | verdade de runtime — confirma o conjunto real de comandos/handlers |
| **AppImage Linux (release)** | `ref/ref-linux.AppImage` | artefato baixado (v1.4.x). Contém `agent-browser-linux-x64` (browser nativo do Linux), `app.asar` (109MB, bundle) |
| **Teardown de alto nível** | `docs/research/2026-06-24-ref-teardown-learnings.md` | mapa estratégico + lista priorizada P0/P1/P2 |

**Como ler a fonte:** comece sempre pelos comentários `// Why:` — o ref documenta a *razão* não-óbvia de cada decisão (é regra do `AGENTS.md` deles). Tipos compartilhados vivem em `src/shared/`. Lógica de processo principal em `src/main/<subsistema>/`. UI em `src/renderer/src/`.

## Os docs de RE (um por subsistema, profundidade de reimplementação)

| # | Doc | Subsistema ref | Mapeia p/ OmniRift | Prioridade | Status |
|---|-----|-----------------|--------------------|------------|--------|
| 01 | [`01-agent-hooks.md`](01-agent-hooks.md) | status de agente via push (hooks) | `src-tauri/src/agents/` | **P0** | ✅ feito |
| 02 | `02-terminal.md` | terminal headless dono no backend | `src-tauri/src/pty/`, `terminal-node` | **P0** | ⏳ |
| 03 | `03-orchestration.md` | fan-out por grupo + worktrees + SSH | Floors / Fase 6 Routines | P1 | ⏳ |
| 04 | `04-mobile-relay.md` | companion mobile = WS LAN no backend | novo | P1 | ⏳ |
| 05 | `05-cli-rpc.md` | CLI specs→handlers→runtime + registro RPC | novo (substrato p/ CLI + mobile) | P1 | ⏳ |
| 06 | `06-browser-design-mode.md` | browser pane + grab do Design Mode | Portais / Fase 5 | P1 | ⏳ |

## Template de cada doc de RE

1. **O que é + por que importa pro OmniRift** (1 parágrafo)
2. **Mapa de componentes** (arquivos-chave em `ref-src`, com responsabilidade de cada um)
3. **Modelo de dados** (os tipos de `src/shared/`, transcritos)
4. **Protocolo / contrato de fio** (HTTP/IPC/RPC/arquivos — o suficiente pra reimplementar byte-a-byte)
5. **Ciclo de vida / fluxo de dados** (sequência: quem chama quem, em que ordem)
6. **As partes difíceis** (os `// Why:` — casos de borda, race conditions, decisões não-óbvias que vão te morder se ignorar)
7. **Design de port pro OmniRift (Rust/Tauri)** — estrutura de arquivos, as decisões adaptadas, o que entregar primeiro (MVP), o que pular
8. **Apêndice:** caminhos `ref-src` citados

## Sequência de execução (do teardown)

1. **P0 agora:** `01-agent-hooks` → `02-terminal` (hooks de status + terminal headless dono-no-backend com snapshots guardados por seq).
2. **P1 Fase 6:** `03-orchestration` (campo `executionHostId` → fan-out no canvas → SSH).
3. **Substrato:** `05-cli-rpc` (registro RPC é base da CLI *e* do mobile).
4. **Aposta:** `04-mobile-relay` (MVP monitorar+push).
5. **Fase 5:** `06-browser-design-mode` (grab é JS puro → portável; aba real cross-origin não é).

Cada doc de RE aprovado vira um **design doc** em `docs/superpowers/specs/` + um **plano** em `docs/superpowers/plans/`, aí implementa.
