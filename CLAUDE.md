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
| 5 | Portais browser (Tauri child webview, não chromiumoxide) | 🔶 build ok, pendente smoke GUI |
| 6 | Floors (= worktrees git) ✅ + Routines ⏳ | 🔶 |
| 7 | Ombro (LLM local) + OmniForge bridges | ⏳ |

## Repositório Forgejo

`https://git.omnimemory.com.br/jesse_freitas/maestri_linux`

## Notas de arquitetura

- PTY manager usa `portable-pty` (mesmo que WezTerm) — suporte Win/Linux/Mac
- `DashMap` para acesso concorrente ao mapa de sessões PTY
- Módulos Rust separados: `pty/`, `agents/`, `portals/` (phase 5), `floors/` (phase 6)
- Frontend usa Tauri IPC tipado via `@tauri-apps/api/core`
