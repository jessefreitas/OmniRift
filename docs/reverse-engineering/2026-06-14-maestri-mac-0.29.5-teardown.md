# Engenharia reversa — Maestri (Mac) v0.29.5

> Teardown clean-room do app original (`Maestri-latest.dmg`, 13 MB) para mapear features
> e UX e reimplementar no nosso port Linux/Tauri. **Referência de comportamento, não cópia
> de código** — o original é Swift nativo proprietário; o nosso é React/Tauri/Rust.
> Fonte das strings: `Contents/Resources/pt-BR.lproj/Localizable.strings` (926 strings de UI)
> + símbolos do binário Mach-O `Contents/MacOS/Maestri` (24 MB).

## 1. Identidade & distribuição

| Campo | Valor |
|---|---|
| Bundle ID | `com.evercraftlabs.Maestro` (fabricante: **Evercraft Labs**) |
| Versão | 0.29.5 (build 101) |
| Plataforma | **macOS 26.2+** (SwiftUI/AppKit nativo de última geração) |
| Terminal | **SwiftTerm** (`SwiftTerm_SwiftTerm.bundle`, `LocalProcessTerminalView`) |
| Distribuição | **Setapp** (`setappPublicKey.pem`) **+ licença standalone** (trial 7 dias) |
| Auto-update | **Sparkle** (`SUFeedURL` → appcast.xml em Cloudflare R2) |
| CLI helper | `Contents/Resources/maestri` (Mach-O universal) → instalado em `~/.local/bin/maestri` (local e em hosts SSH remotos) |
| i18n | de, en, es, fr, ja, **pt-BR**, zh-Hans |

**NÃO é Electron nem Tauri** — é Swift/AppKit puro (binário nativo + `Assets.car` + `.lproj`).
Isso significa: zero código de frontend reaproveitável; o valor está no **modelo de features e UX**.

## 2. Arquitetura (mapa de componentes via símbolos do binário)

```
Canvas            → CanvasViewportView, CanvasNodesView, CanvasNodeContainerView, CanvasNode
Nodes             → TerminalView/LocalProcessTerminalView, FileNodeView, FileTreeOutlineView,
                    (Portal browser), NoteView, GroupFrameView, CrossFloorConnectorNodeView
Conexões          → ConnectionOverlayView, ConnectionsPopoverView, ArrowEndpointSelectionView,
                    NoteConnectionsPopoverView
Floors            → FloorManager, FloorOverviewView, branchInUseByFloor (← floor = branch git!)
Git               → CommitGraphView, DiffView/DiffTextView/DiffScrollView, GitStatusProvider,
                    GitStatusTableCellView
Companion (Ombro) → CompanionPanelView, CompanionAIService, CompanionMessageView, CompanionTextView,
                    CompanionLoadingView, CompanionErrorView
Drawing/Sketch    → DrawingLayerView, DrawingOverlayView, DrawingSelectionView, DrawingBoundingBoxView
UI chrome         → CommandPaletteView, ContextualToolbarView, FullBleedHostingView
Agents            → ChatAgent, aiService, AgentRoles
Hooks             → HooksConfigurationView
Efeitos           → CharacterRippleView, EmojiReceiverView
Serviços          → AccessibilityService, DataControlsView, FileTreeStateStore, globalStore
```

## 3. Inventário de features

### 3.1 Canvas & tipos de node
Canvas infinito com zoom (segura modifier + scroll), **minimap**, "Focus this element".
Tipos de node:
- **Terminal** (SwiftTerm) — tema custom, tamanho default, **memory limit por terminal**, presets (até N presets aparecem ao criar terminal).
- **Note** (sticky) — cor default, tamanho default, inserir imagem, toolbar de formatação rica (negrito/itálico/strike/code/heading/listas/code-block/markdown).
- **Sketch/Drawing** — camada de desenho sobre o canvas ("Draw terminals. Drop notes. Sketch ideas.").
- **File** + **File Tree** — node de arquivo e árvore de arquivos (hide hidden files, icon grid, outline).
- **Portal** (browser embarcado) — `Portal Storage` (escopo global compartilha cookies/cache/local data, ou isolado por portal), Open in Browser/Portal, Reload, Copy URL.
- **Group/Frame** — agrupar nodes (Group Name, New Group, Delete Group).
- **Cross-Floor Connector** — node que conecta através de floors diferentes.

Toolbar principal (criação de node): seleção · terminal · arquivo · anexo · pasta · **portal (globe)** · nota (Aa) · sketch.
Toolbar contextual: formatação da nota selecionada.

### 3.2 ⭐ Floors = workspaces git (a feature matadora)
**Cada Floor é uma branch git com seu próprio worktree.** ("Floors help you organize your canvas
into separate workspaces", `branchInUseByFloor`.)

- **Ground** = floor base; floors novos clonam o layout do Ground ("Clone Ground layout").
- Ciclo de vida git completo por floor:
  - criar/escolher branch ("Create a new branch or use an existing one", `feature/my-branch`)
  - trabalhar isolado no worktree do floor
  - **Commit & Publish Branch** / Commit & Push / Commit (Amend)
  - **Land Branch** / Merge Branch ("Changes will be merged into %@", "Delete the branch after the merge", "Branch Landed")
  - Checkout, fetch ("%lld ahead of remote"), stash (Apply/Drop), resolução de conflito ("unmerged changes", "Force delete will lose those commits")
- **Floor Hooks** — scripts disparados no ciclo do floor (criar/deletar).
- Export/Import de workspace como arquivo (archive).
- **Quick Jump**: double-tap modifier + 1–9 → pula pra um floor; segura modifier + swipe 2 dedos → troca floor.

> 💡 **Validação de naming:** floor = branch = "realidade paralela de código" → confirma o nome
> **OmniRift** (Omni + Rift = portais pra realidades paralelas). Cada floor É um rift pra uma branch.

### 3.3 Git (UI embarcada)
Commit graph (`CommitGraphView`), Diff viewer (`DiffView`), status por arquivo (`GitStatusProvider`),
mensagem de commit inline ("Message — ⌘↩ to commit"), branches, merge, stash, push/pull, conflitos.

### 3.4 Agents & Roles
- CLIs suportados (detectados no binário): **claude, codex, gemini, cursor, continue, openCode**.
- **Roles**: "Assign a role to define what this agent should focus on" — Add/Edit/Delete Role, preview de instruções.
  - **Discover Roles**: escaneia o working dir do workspace por arquivos de role compartilhados.
  - **Sync CLAUDE.md and AGENTS.md** — usa esses arquivos como instruções de role.
  - Roles não disponíveis em terminais SSH.
- **Send selection to an agent** — manda um trecho selecionado pro agente.
- "Unlock the full orchestra." — orquestração é feature premium.
- Notificação "when an agent needs attention" (detecção de estado bloqueado — igual nosso detector VT100).

### 3.5 Conexões inter-agente + SSH remoto
- Conexões = pipes entre nodes ("Agents that talk to each other", `ConnectionOverlayView`).
- **SSH workspaces**: "Enable SSH workspaces", conectar a hosts remotos (Host, hostname/IP, host-key verification).
  - Instala um helper `~/.local/bin/maestri` **no servidor remoto**.
  - **Abre um túnel reverso** pra agentes remotos responderem de volta ("Opens a reverse tunnel so remote agents can communicate back").

### 3.6 Ombro (assistente AI contextual)
- Painel `CompanionPanelView` / `CompanionAIService` — "Meet Ombro", "Toggle Ombro", "Ask anything…", "Ask about this selection".
- **Roda em Apple Intelligence on-device** ("Turn on Apple Intelligence in System Settings to use Ombro", "The language model is still downloading").
- No nosso port: equivalente = **LLM local (Ollama)** ou OmniForge BYOK.

### 3.7 Routines (automação) + Hooks
- **Routine** = script automatizado com trigger ("Create a routine to automate tasks or set reminders").
  - Triggers: **floor criado**, **floor deletado**, **botão play**, **Schedule** (tempo).
  - "The script runs before each routine fire"; "If it exits with a non-zero code, the routine is skipped"; "Notify when run".
- **Hooks**: Enable Hooks, Configure Hooks, Floor Hooks (lifecycle).

### 3.8 Persistência / Backup / History
Autosave ("Last saved"), backup automático periódico ("Last automatic backup"), Export/Import Full Backup,
Manage Backups, **History** (undo history / snapshots — "Snapshots appear here automatically as you work"),
Clear History.

### 3.9 Navegação / chrome
Command Palette (`CommandPaletteView`), **Quick Jump** (terminal: modifier+1–9; floor: double-tap+1–9),
atalhos configuráveis, busca, Spotlight integration, gestão de processos (Stop process, Shutting down…).

## 4. Mapa Maestri → nosso port

| # | Feature Maestri | Nosso port | Status |
|---|---|---|---|
| 1 | Canvas infinito + zoom + minimap | React Flow canvas | ✅ (falta minimap) |
| 2 | Terminal node (SwiftTerm) | xterm.js + portable-pty | ✅ |
| 3 | Detecção de estado do agente ("needs attention") | detector VT100 (Working/Blocked/Done/Idle) | ✅ |
| 4 | Conexões inter-agente (pipes) | PTY pipe stdout→stdin | ✅ |
| 5 | Orquestração via MCP | MCP server embarcado (terminal_*/workspace_*/send_task) | ✅ |
| 6 | Roles + Sync CLAUDE.md/AGENTS.md | roles parciais | ⏳ (falta sync CLAUDE.md/AGENTS.md, Discover Roles) |
| 7 | **Floors = branches git** | floors (UI) sem git backing | ❌ **falta o git worktree por floor** |
| 8 | Git UI (commit graph, diff, stash, merge/land) | — | ❌ |
| 9 | Note node (sticky + formatação) | — | ❌ (Fase 4) |
| 10 | Sketch/Drawing | — | ❌ (Fase 4) |
| 11 | File / File Tree node | — | ❌ |
| 12 | Portal (browser embarcado) | — | ❌ (Fase 5 — chromiumoxide) |
| 13 | Group/Frame | — | ❌ |
| 14 | Ombro (AI on-device) | — | ❌ (Fase 7 — Ollama) |
| 15 | Routines (automação + triggers) | — | ❌ (Fase 6) |
| 16 | Hooks (floor lifecycle) | — | ❌ |
| 17 | SSH workspaces + helper remoto + túnel reverso | — | ❌ |
| 18 | Persistência (autosave) | SQLite embarcado (doc-in-SQLite) | ✅ |
| 19 | Backup/History/snapshots | — | ❌ |
| 20 | Command palette + Quick Jump | — | ❌ |
| 21 | Memory limit / process mgmt por terminal | — | ❌ |
| 22 | CLI helper (`maestri` no PATH) | — | ❌ |

## 5. Implicações pro roadmap

**Prioridade alta (define a identidade do produto):**
1. **Floors com git backing real** (#7/#8) — é A feature do Maestri. Cada floor = `git worktree` numa branch.
   Implementar: criar floor → `git worktree add` numa branch; "Land" → merge na main + remove worktree.
   Bate com a nossa Fase 3 e com o nome OmniRift.
2. **Sync CLAUDE.md/AGENTS.md em Roles** (#6) — barato e alto valor; já temos roles.
3. **Command Palette + Quick Jump** (#20) — UX essencial, barato.

**Médio:**
4. Note + Sketch + File Tree + Group (#9/#10/#11/#13) — Fase 4 do nosso roadmap.
5. Routines + Hooks (#15/#16) — Fase 6.
6. SSH workspaces (#17) — alto valor pra orquestração distribuída; o helper remoto + túnel reverso
   é exatamente o padrão OmniForge.

**Já estamos à frente em:** detecção de estado VT100, MCP embarcado com tools dinâmicas por agente,
deny-list de comandos destrutivos, perfil MCP universal (Serena + Context7) — coisas que o teardown
não mostra no Maestri (ele usa Apple Intelligence, não MCP por agente).

## 6. Artefatos
- Strings de UI extraídas: `/tmp/maestri_re/maestri_ui_strings_926.txt` (926 linhas)
- App extraído: `/tmp/maestri_re/Maestri/Maestri.app/`
