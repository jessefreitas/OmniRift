# Changelog

Formato baseado em [Keep a Changelog](https://keepachangelog.com/pt-BR/1.1.0/);
versionamento [SemVer](https://semver.org/lang/pt-BR/). Versão única sincronizada
por `npm run version:set <X.Y.Z>`.

## [Não lançado]

## [0.1.40] — 2026-06-27

### Adicionado
- **Imagem macOS (Apple Silicon)** — o pipeline de release agora gera `.dmg` arm64 (job `macos-14`). Não-assinado (uso pessoal): abrir com botão-direito → Abrir, ou `xattr -cr OmniRift.app`. Os sidecars OmniCompress compilam nativamente no runner macOS.

## [0.1.39] — 2026-06-27

### Adicionado
- **Renomear inline** de abas de projeto e de paralelos — duplo-clique vira input (Enter/Esc/blur), no lugar do `prompt()` nativo que não abre no WebKitGTK.
- **Links clicáveis no terminal** — `file://` (pastas/arquivos) e `http(s)` abrem no app/gerenciador padrão do SO; scope `file://` liberado e restrito a paths absolutos (sem metacaracteres de shell).

### Corrigido
- **Boot não restaura mais o projeto anterior** — o app abre limpo (projeto "Principal" vazio) em vez de reabrir a última sessão. Quando a sessão anterior tem conteúdo, ela é preservada como snapshot recuperável (não é apagada pelo auto-save).

## [0.1.0] — 2026-06-17

Primeiro beta do OmniRift — o **cockpit visual de agentes de IA**: um canvas
infinito onde cada agente (Claude Code, Codex, Gemini, …) é equipado com um
*loadout* de superpoderes.

### Adicionado
- **Canvas infinito** com terminais PTY, notas, sketches, FileTree, portais, JSON/mapa mental, API, DB e DevTools.
- **Paralelos** (= branches git / worktrees) — trabalhe em paralelo sem misturar mudanças; diff + code review + Land por paralelo.
- **Orquestrador** + dispatch multi-agente via MCP (`omnirift-agents`), com contrato e teto de agentes.
- **Roles de agente** com persona, CLI/LLM, **skills**, **compressor de token** e **subagents** por loadout.
- **Skills por agente** — curadas de `.claude/skills` (projeto + globais) e **importáveis de `.md` avulso ou de repositório GitHub**.
- **Compressores de token por agente** (RTK, Headroom) — instaláveis pelo app; decoração só-env no spawn.
- **Code Review IA** (BYOK) — LLM + política de GO/NO-GO num painel com abas; gate opcional no Land.
- **Repositórios Git** — login (PAT ou OAuth Device Flow no GitHub), GitHub/GitLab/Forgejo, clonar e abrir como projeto.
- **Monitor de Recursos** — CPU/RAM/swap/disco/rede + GPU (NVIDIA), com **consumo por agente** em abas.
- **Memória plugável** — Local (SQLite, zero-config), OmniMemory e Obsidian.
- **CLIs de IA** instaláveis em 1 clique; lista de agentes dinâmica + CLI personalizado.
- **Snapshots do canvas** (auto-backup), **Routines** (agendamento), **Hooks do paralelo**, **Lembretes**, **Manual** embutido.
- **Code Workspace** — editor Monaco (offline) no canvas.
- Gate de licença beta (Ed25519 offline).

[Não lançado]: https://git.omnimemory.com.br/jesse_freitas/maestri_linux/compare/v0.1.0...HEAD
[0.1.0]: https://git.omnimemory.com.br/jesse_freitas/maestri_linux/releases/tag/v0.1.0
