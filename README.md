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

OmniRift é um app desktop **open-source** (Tauri 2 + Rust + React) que reúne num **canvas infinito**: agentes de IA (Claude Code, Codex, Hermes, shell), terminais PTY reais, paralelos que são **worktrees git de verdade**, notas, sketches e navegadores embutidos. **100% local, sem conta** — um canvas de orquestração de agentes para Linux e Windows.

> Você orquestra; os agentes trabalham.

## Recursos ✨

### 🎨 Canvas & organização
- **Canvas infinito** (React Flow + Pixi.js) — mapeie e conecte visualmente ideias e tarefas.
- **Multi-projeto** isolado por abas.
- **Grupos, notas e sketches** (tldraw), árvore de arquivos e **portais de navegador** embutidos.

### 🤖 Agentes & terminais
- **Terminais PTY reais** (backend-owned, via `portable-pty`, Windows e Linux).
- **Agentes** Claude Code, Codex e shell nativo num mesmo fluxo.
- **Conexões agente → agente** (a saída de A alimenta B).
- **Roles** (personas reutilizáveis) + **Skills** por CLI.
- **Fan-out paralelo** e **execução remota via SSH**.

### 🧠 OmniAgent — agentes estruturados (ACP)
Além dos terminais, o OmniRift trata agentes como **objetos estruturados** via **ACP (Agent Client Protocol)** — o app *entende* o que o agente faz, não só repassa texto.
- **Providers plugáveis:** Claude Code, Codex e **Hermes** (open-source, roda modelo **local/grátis** via Ollama/OpenRouter). ACP = qualquer agente do ecossistema.
- **Seletor de modelo** por agente — rode tarefas caras num modelo forte e as baratas num leve.
- **Tool-calls ao vivo**, badges reais de **modelo · contexto · custo**, e **permissões** aprovadas no próprio card.
- **Orquestração:** o OmniAgent recebe as tools MCP do OmniRift e **coordena** os outros agentes; e pode ser comandado pelo Orquestrador-terminal.
- **Subagentes nativos** (`.claude/agents`) plugados por agente, com **recarga (↻) mantendo a conversa**.

### 🔗 Conexões semânticas
A linha entre agentes carrega **estrutura**, não só texto:
- **Diff na linha** — quando um agente edita, a saída vira um payload tipado (📄 diff) legível na conexão.
- **Review (gate)** — um nó que **segura** o diff, mostra renderizado, e você **Aprova / Rejeita** (com motivo que volta pro autor corrigir) antes de fluir pro próximo nó.
- **Validador IA** — ligue um agente revisor na Review e ele **valida sozinho** (APPROVE/REJECT) — a IA revisa a IA.
- **Filtro** — roteamento por conteúdo (por tipo, regex ou caminho).

### 🌿 Floors (paralelos = worktrees git)
- Cada floor é um **worktree git real** — várias versões do projeto lado a lado.
- Dispatch paralelo de agentes entre floors + **"Land"** com gate de code review.

### ⏰ Routines (automação)
- Tarefas **agendadas** (intervalo ou diário) e por **gatilho de ciclo-de-vida de floor** (ao criar/deletar).
- Scheduler embutido + a nível de SO (systemd / schtasks), com persistência SQLite e histórico.

### 💬 OmniPartner — LLM (BYOK)
- Companion de chat trazendo **seu próprio LLM**: OpenAI, Anthropic ou **Ollama (local)**. Com medidor de tokens.

### 🧩 Memória plugável
- Conecte um "cérebro": **Local** (SQLite, zero-config), **OmniMemory** (HTTP + MCP) ou **Obsidian**.
- Área de Conexões pra parear; os agentes nascem *memory-aware*.

### 🛠️ Qualidade de código
- **Editor Monaco** no canvas + **Painel de Complexidade** nível-projeto (ciclomática/cognitiva/MI, pior-primeiro, drill-down por função) com **"Analisar com IA"**.
- **Code Review por IA** (BYOK) com decisão **GO/NO-GO** como gate antes de integrar.

### 🖥️ CLI, Mobile & monitoramento
- **`omnirift-cli`** — controle os agentes pelo terminal (status / listar / spawnar / enviar / matar).
- **Mobile:** pareie o celular por **QR**, monitore os agentes e habilite *steering* opt-in (relay E2EE na LAN).
- **Monitor de recursos** (CPU/GPU/memória) + painel de **Saúde do Projeto** com relatório por IA.

### 🔌 Extensibilidade & dados
- Servidores **MCP** customizados injetados nos agentes, **hooks**, **compressores de token** plugáveis.
- **Snapshots** e backup de ações, histórico de sessões, persistência SQLite com auto-save/restore.

- **Privacidade total:** 100% local, sem conta, sem telemetria.

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
