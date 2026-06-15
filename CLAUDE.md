# Maestri Linux — CLAUDE.md

## O que é este projeto

Canvas infinito para orquestrar agentes de IA (Claude Code, Codex, shell), terminais PTY, sketches e notas.
Equivalente open-source do [Maestri](https://www.themaestri.app/pt-br) para Linux/Windows.

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
- **Status:** Fase 1a (backend) ✅ na branch `feat/memory-provider-fase1` (43/43 testes, zero regressão). Pendente: 1b (Área de Conexões UI React), 1c (provider Obsidian). "Maestri" é codename — produto será renomeado.
