<div align="center">

# OmniRift

**Um canvas infinito para orquestrar seus agentes de IA.**

[![License: MIT](https://img.shields.io/badge/license-MIT-6EE7A8.svg)](LICENSE)
![Linux](https://img.shields.io/badge/Linux-supported-6EE7A8)
![Windows](https://img.shields.io/badge/Windows-supported-6EE7A8)
![Tauri](https://img.shields.io/badge/Tauri-2-24C8DB)
![Rust](https://img.shields.io/badge/Rust-1.77+-orange)

[Site](https://omnirift.omniforge.com.br) · [Baixar](https://omnirift.omniforge.com.br/#baixar) · [Releases](https://github.com/jessefreitas/OmniRift/releases)

</div>

## O que é

OmniRift é um app desktop **open-source** (Tauri 2 + Rust + React) que reúne num **canvas infinito**: agentes de IA (Claude Code, Codex, shell), terminais PTY reais, paralelos que são **worktrees git de verdade**, notas, sketches e navegadores embutidos. **100% local, sem conta.** É o equivalente open-source do Maestri para Linux e Windows.

> Você orquestra; os agentes trabalham.

## Recursos ✨
- **Canvas infinito:** mapeie e conecte visualmente suas ideias e tarefas (React Flow + Pixi).
- **Agentes IA conectáveis:** orquestre Claude Code, Codex e agentes de shell num mesmo fluxo.
- **Terminais PTY reais:** interaja com seu sistema operacional direto do canvas (`portable-pty`).
- **Paralelos:** cada nó paralelo é um worktree git independente — múltiplas versões do projeto lado a lado.
- **Canvas rico:** notas, sketches (tldraw), navegadores embutidos (portais) e file trees.
- **OmniPartner (BYO LLM):** traga seu próprio LLM — configure as chaves e use os provedores que preferir.
- **Memória plugável:** integre com OmniMemory ou Obsidian para dar contexto persistente aos agentes.
- **Privacidade total:** 100% local, sem telemetria.

## Instalação ⬇️
Baixe a versão mais recente no [site](https://omnirift.omniforge.com.br) ou na [página de Releases](https://github.com/jessefreitas/OmniRift/releases):
- **Linux:** `.AppImage` (portátil, sem instalação) ou `.deb` (Debian/Ubuntu).
- **Windows:** `.exe` (instalador padrão) ou `.msi` (implantação corporativa/silenciosa).

## Desenvolvimento 🛠️
Quer rodar do fonte, implementar uma feature ou corrigir um bug?

### Pré-requisitos
- **Node.js** 20+
- **Rust** 1.77+

### Comandos
```bash
npm install            # instala as dependências do monorepo
npm run tauri:dev      # ambiente de dev com hot-reload
npm run tauri:build    # build de produção nativo da sua plataforma
npm run typecheck      # checagem de tipos em todo o workspace
```

## Estrutura do monorepo 📁
- `apps/desktop` — a aplicação principal (Tauri 2 + frontend + `src-tauri/`).
- `apps/landing` — site institucional e inscrição do beta.
- `packages/canvas-engine` — canvas infinito (React Flow + Pixi).
- `packages/terminal-node` — nó de terminal PTY (xterm.js).
- `packages/ui` — componentes React compartilhados.
- `packages/shared-types` — tipos Rust ↔ TypeScript.
- `services/license-worker` — Cloudflare Worker (licenças / beta).

## Stack 🧱
- **Frontend:** React 19 + TypeScript + Vite
- **Desktop/Core:** Tauri 2 (WebKitGTK no Linux, WebView2 no Windows)
- **Backend nativo:** Rust (PTY, agentes, scheduler)
- **Renderização/UI:** `@xyflow/react` (React Flow), Pixi.js, `@xterm/xterm`

## Beta de lançamento 🚀
60 dias com **tudo liberado, grátis**. Acesso antecipado, teste os limites e ajude a moldar o roadmap — garanta sua vaga:

🔗 https://omnirift.omniforge.com.br

## Contribuindo 🤝
Contribuições são muito bem-vindas! PRs e issues movem o projeto. Achou um bug ou tem uma ideia? Abra uma issue com o contexto e o comportamento esperado. Pra contribuir com código: faça um fork, crie uma branch para sua feature/fix e abra um Pull Request.

## Apoie o projeto ❤️
O OmniRift é gratuito e open-source. Se ele te ajuda, considere [apoiar o desenvolvimento](https://omnirift.omniforge.com.br) — isso mantém o projeto vivo e independente.

## Licença 📜
MIT © 2026 OmniForge — Automações e Inteligência Artificial.

## Links 🔗
- **Site:** https://omnirift.omniforge.com.br
- **Releases:** https://github.com/jessefreitas/OmniRift/releases
