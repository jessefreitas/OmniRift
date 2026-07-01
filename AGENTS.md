# OmniRift — CLAUDE.md

## O que é este projeto

Canvas infinito para orquestrar agentes de IA (Claude Code, Codex, Hermes, shell), terminais PTY, sketches e notas.
Um canvas de orquestração de agentes, open-source, para Linux e Windows.

## Stack

- **Frontend**: React 19 + TypeScript + Vite 8
- **Desktop**: Tauri 2 (WebKitGTK no Linux, WebView2 no Windows)
- **Backend**: Rust 1.77+ — PTY manager, agent orchestrator, scheduler
- **Canvas**: `@xyflow/react` (React Flow) + Pixi.js para GPU compositing
- **Terminal**: `@xterm/xterm` com addon-fit
- **UI**: shadcn/ui (Tailwind) via `@maestri/ui`

## Estrutura

```
apps/desktop/          Tauri 2 app (frontend + src-tauri/)
packages/canvas-engine/ React Flow + Pixi canvas
packages/terminal-node/ xterm.js PTY node
packages/ui/           shadcn/ui components
packages/shared-types/ Tipos Rust ↔ TS
```

## Comandos

```bash
# Dev (abre app + hot-reload)
npm run tauri:dev

# Build production
npm run tauri:build

# Typecheck workspace completo
npm run typecheck

# Só frontend
npm run dev
```

## Fases de desenvolvimento

| Fase | Escopo | Status |
|------|--------|--------|
| 0 | Setup monorepo + Tauri scaffold | ✅ |
| 1 | Canvas infinito + N terminais PTY | ✅ |
| 2 | Conexões PTY (agente A → agente B) | ✅ |
| 3 | Roles + persistência SQLite | ✅ |
| 4 | Sketches + Notas (tldraw) + FileTree + Group | ✅ |
| 5 | Portais browser (iframe in-DOM; webview nativo falha no WebKitGTK) | ✅ (localhost) |
| 6 | Floors (= worktrees git) ✅ + Routines ⏳ | 🔶 |
| 7 | Ombro (LLM local) + OmniForge bridges | ⏳ |
| 8 | **Memória plugável** (interface do cérebro: OmniMemory/Obsidian) + Área de Conexões | 🔶 1a backend ✅ |

## Repositório Forgejo

`https://git.omnimemory.com.br/jesse_freitas/maestri_linux`

## Notas de arquitetura

- PTY manager usa `portable-pty` (mesmo que WezTerm) — suporte Win/Linux/Mac
- `DashMap` para acesso concorrente ao mapa de sessões PTY
- Módulos Rust separados: `pty/`, `agents/`, `portals/` (phase 5), `floors/` (phase 6), `memory/` (fase 8)
- Frontend usa Tauri IPC tipado via `@tauri-apps/api/core`

## Fase 8 — Memória plugável (interface do cérebro)

Maestri como **interface de conexão a um cérebro de memória plugável** (OmniMemory, Obsidian, …) — ver `docs/superpowers/specs/2026-06-15-maestri-brain-interface-design.md` + plano `docs/superpowers/plans/2026-06-15-fase1-memory-provider-backend.md`.

- **`src-tauri/src/memory/`**: trait `MemoryProvider` + `LocalProvider` (blackboard SQLite existente = **default zero-config**) + `OmniMemoryProvider` (gateway remoto). `MemoryRegistry` mantém o provider ativo + conexões (tabela `memory_connections`, token ofuscado em repouso — keychain é Fase 2).
- As tools MCP **`memory_*`** roteiam pelo provider ativo (Local = comportamento original, intocado). `agent_mcp_config` **injeta o MCP do provider ativo** em todo agente claude (merge, não `--strict`) → agentes nascem memory-aware.
- Comandos da **Área de Conexões** (UI Fase 1b): `memory_providers_list`, `memory_connect`, `memory_test`, `memory_set_active`, `memory_active`.
- **Status:** Fase 1 completa (1a backend ✅ + 1b Área de Conexões UI ✅ + 1c provider Obsidian ✅). **Fase 2:** tokens de conexão no **keychain do SO** (`memory/secret_store.rs`, crate `keyring`), com fallback ofuscado + migração dos tokens legados do SQLite; `OBF_KEY` mantido só como chave de migração. Pendente da Fase 2: multi-DB via `sqlx` (Postgres compartilhado). Nome do produto é **OmniRift** ("Maestri" era só codename, já aposentado).

## Convenções de qualidade (aprendizados do teardown do ref)

- **Teste afirma o que RENDERIZA, não o store.** Em teste de UI, asserte o DOM (`getByRole`, `toBeVisible`) — não o estado do Zustand. Um modal deletado pode passar num round-trip de store mas não renderizar nada (bug real #1186 do ref). Lógica pura → teste de unidade no slice; comportamento de tela → assert no DOM. *(Convenção; quando houver runner de frontend — vitest+testing-library — vale como gate.)*
- **Tipos próprios são `.ts`, não `.d.ts`.** Com `skipLibCheck` o TS alarga `.d.ts` não-resolvido pra `any` em silêncio. CI reprova `.d.ts` próprio (exceto `vite-env.d.ts`). — *enforced no `.forgejo/workflows/ci.yml`.*
- **Release só com versão estritamente > a última.** O `guard` do `release.yml` recusa tag não-maior que o latest (protege o auto-update de downgrade). — *enforced.*
- **Sem telemetria no app** (posição "no telemetry"); não há consentimento a coletar.
