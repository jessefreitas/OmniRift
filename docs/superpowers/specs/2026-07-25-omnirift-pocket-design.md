# OmniRift Pocket — Design (SKU / superfície reduzida)

> Status: **approved (architect + Jessé)** · 2026-07-25  
> Pedido: “abrir um projeto paralelo — sistema menor, menos funcionalidades, mais fácil de operar.”

## Decisão de produto (não negociável nesta fase)

| Decisão | Motivo |
|---|---|
| **NÃO** criar 3º canal compile-time (`feature=pocket`, bundle `.pocket`, `tauri.pocket.conf.json`) | Lab já é o canal de experimento de engenharia. Pocket é **SKU/UX**, não fork de build. |
| **SIM** profile runtime `pocket \| full` no Stable | Um binário; superfície muda por preferência. |
| Desenvolvimento em **worktree/branch paralela** (`feat/omnirift-pocket`) | Não bagunça main; merge só sob pedido. |
| Lab continua só pra experimento de engenharia | Pocket ≠ Lab. |

## Goal

Entregar um **modo simples** (Pocket) do OmniRift Stable: mesma app, mesma persistência, mesmas engines — mas sidebar, toolbar e palette mostram só o mínimo pra operar agentes + terminal + notas. Upgrade explícito pra “Modo completo” sem reinstalar.

## First-run

- Chave: `localStorage["omnirift-product-profile"]` ∈ `"pocket" | "full"`.
- **Sem preferência → default `pocket`** (first-run = superfície simples).
- Usuário que já gravou `full` permanece em full.

## Upgrade / downgrade

- Settings → Geral: toggle **“Modo simples (Pocket)”** ↔ **“Modo completo”**.
- Troca é imediata (subscribe no profile); não apaga nodes/tools já criados no canvas — só esconde entradas da UI. Nodes “avançados” já no floor continuam renderizando (não orphanar).

## MVP allowlist

### Tools ON (sidebar / open-tool / atalhos Settings)

`settings`, `help`, `appearance`, `clis`, `llm-providers`, `companion`, `git`, `skills`, `memory`, `mcpservers`, `releases`

- **Conexões** (`connections`): **OFF** no Pocket — Local é implícito (zero-config). Quem precisa OmniMemory/Obsidian sobe pra full.
- Ajuste fino da lista é ok; fonte de verdade = `POCKET_TOOL_IDS` em `product-profile.ts`.

### Tools OFF (exemplos — tudo que não está na allowlist)

`pipeline`, `turbo`, `conductor`, `omniswitch`, `bench`, `routines`, `mobile`, `feature-flags`, `compressors`, `hooks`, `code-metrics`, `omnifs`, `review-ai`, `snapshots`, `history`, `reminders`, `usage`, `kanban`, `snippets`, …

### Nodes ON (toolbar / command palette “Criar”)

`agent`, `terminal`, `note`, `filetree`, `group`

### Nodes OFF

`portal`, `api`, `db`, `subagent`, `review`, `filter`, `community`, `sketch`, `pdf`, `html`, `devtools`, `json`, `explain`, `preview`, `code`, …

## O que some da UI (fase 1)

1. **Sidebar → Ferramentas**: filtra `TOOL_DEFS` pela allowlist.
2. **CanvasToolbar**: só botões de kinds allowlisted; esconde templates de workflow / turbo / health no pocket.
3. **CommandPalette**: filtra “Criar” por kind e “Abrir” por tool id.
4. **Settings → atalhos laterais**: esconde `feature-flags` / `connections` no pocket.

## Fora de escopo (fase 1)

- Tour / jornada-onboarding completa.
- Canal Tauri pocket / feature flag compile-time.
- Esconder nodes já existentes no canvas.
- Backend gates (comandos Rust continuam disponíveis; gating é UX).

## Arquivos-chave

| Peça | Caminho |
|---|---|
| Profile + allowlists | `apps/desktop/src/lib/product-profile.ts` |
| Teste puro | `apps/desktop/src/lib/product-profile.test.ts` + `npm run test:product-profile` |
| Wiring | `Sidebar.tsx`, `CanvasToolbar.tsx`, `CommandPalette.tsx`, `SettingsModal.tsx` |

## Critério de pronto (MVP fase 1)

- [x] Spec + branch/worktree
- [x] `product-profile` + first-run default pocket
- [x] Filtro sidebar tools
- [x] Gate toolbar + palette
- [x] Toggle Settings
- [x] Teste allowlist (tool X ausente em pocket, presente em full)
- [ ] Polish: i18n keys dedicadas, esconder seções sidebar extras (MCP/Specs) se fizer sentido
- [ ] Gate em outros entry-points (context menus, workflow templates menu) se ainda vazarem
