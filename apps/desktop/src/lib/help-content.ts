// src/lib/help-content.ts
//
// Manual interno do OmniRift — conteúdo bundlado no app (não depende de docs/ no
// disco do cliente). Renderizado pelo HelpModal via renderMarkdown.

export interface HelpTopic {
  id: string;
  title: string;
  /** Markdown. */
  body: string;
  /** Título em inglês. */
  titleEn: string;
  /** Markdown em inglês. */
  bodyEn: string;
}

export const HELP_TOPICS: HelpTopic[] = [
  {
    id: "inicio",
    title: "Primeiros passos",
    body: `# Bem-vindo ao OmniRift

OmniRift é um **canvas infinito** para orquestrar agentes de IA (Claude Code, Codex, OpenCode, Antigravity), terminais, notas, sketches e mais.

## O básico
1. **Abra um projeto** — sidebar → seção *Projeto* → escolha a pasta. Ela vira o \`cwd\` dos terminais e agentes.
2. **Crie um agente** — sidebar → *Novo agente* → escolha um papel (Orquestrador, Backend, DevOps…). Ele abre como um terminal no canvas.
3. **Converse com o agente** digitando direto no terminal dele.
4. **Salve seu trabalho** — sidebar → *Workspace* → Salvar (ou deixe os *Snapshots* automáticos cuidarem disso).

## Navegação do canvas
- **Mover a tela**: arraste o fundo vazio.
- **Zoom**: scroll do mouse.
- **Mover um node**: arraste pelo cabeçalho dele.
- **Selecionar vários**: segure *Shift* e arraste.

> Dica: cada node tem um ícone **?** no cabeçalho explicando como usá-lo, e um **⤢** pra maximizar (ESC restaura).`,
    titleEn: "Getting started",
    bodyEn: `# Welcome to OmniRift

OmniRift is an **infinite canvas** for orchestrating AI agents (Claude Code, Codex, OpenCode, Antigravity), terminals, notes, sketches and more.

## The basics
1. **Open a project** — sidebar → *Project* section → pick the folder. It becomes the \`cwd\` of the terminals and agents.
2. **Create an agent** — sidebar → *New agent* → choose a role (Orchestrator, Backend, DevOps…). It opens as a terminal on the canvas.
3. **Talk to the agent** by typing straight into its terminal.
4. **Save your work** — sidebar → *Workspace* → Save (or let the automatic *Snapshots* take care of it).

## Canvas navigation
- **Pan the view**: drag the empty background.
- **Zoom**: mouse scroll.
- **Move a node**: drag it by its header.
- **Select several**: hold *Shift* and drag.

> Tip: every node has a **?** icon in its header explaining how to use it, and a **⤢** to maximize (ESC restores).`,
  },
  {
    id: "canvas",
    title: "Canvas e nodes",
    body: `# Canvas e nodes

A barra de ferramentas no topo cria os tipos de node. Todos compartilham as mesmas convenções:

- **? (ajuda)** — passa o mouse e mostra como usar aquele node.
- **⤢ Maximizar** — abre o node em tela cheia. **ESC** restaura.
- **Comentário** — vários nodes têm um rodapé "Comentário" pra anotar contexto.
- **Redimensionar** — arraste a alça do canto quando o node está selecionado.

## Tipos de node
- **Terminal / Agente** — shell ou CLI de IA (ver *Agentes*).
- **Nota** — texto livre; o alfinete salva como *Lembrete* com prazo.
- **Grupo** — solte outros nodes por cima pra agrupar; arraste o grupo pelo título.
- **Sketch** — desenho à mão livre (tldraw).
- **Preview** — renderiza \`.md\` / \`.html\`.
- **JSON** — Texto / Árvore / **Mapa mental** navegável (JSON, XML, HTML).
- **API** — cliente HTTP (método + URL + corpo).
- **DB** — navega bancos SQLite (tabelas + SQL).
- **DevTools** — conversores (Base64, hash, JWT…).
- **FileTree** — árvore de arquivos; arraste um arquivo pra dentro de um terminal.
- **Portal** — embute uma página web (localhost) num node.`,
    titleEn: "Canvas and nodes",
    bodyEn: `# Canvas and nodes

The toolbar at the top creates the node types. They all share the same conventions:

- **? (help)** — hover to see how to use that node.
- **⤢ Maximize** — opens the node fullscreen. **ESC** restores.
- **Comment** — several nodes have a "Comment" footer to jot down context.
- **Resize** — drag the corner handle when the node is selected.

## Node types
- **Terminal / Agent** — shell or AI CLI (see *Agents*).
- **Note** — free text; the pin saves it as a *Reminder* with a due date.
- **Group** — drop other nodes on top to group them; drag the group by its title.
- **Sketch** — freehand drawing (tldraw).
- **Preview** — renders \`.md\` / \`.html\`.
- **JSON** — Text / Tree / navigable **Mind map** (JSON, XML, HTML).
- **API** — HTTP client (method + URL + body).
- **DB** — browse SQLite databases (tables + SQL).
- **DevTools** — converters (Base64, hash, JWT…).
- **FileTree** — file tree; drag a file into a terminal.
- **Portal** — embeds a web page (localhost) in a node.`,
  },
  {
    id: "agentes",
    title: "Agentes e Orquestrador",
    body: `# Agentes e o Orquestrador

Cada agente é um terminal rodando um CLI de IA. Na criação você escolhe um **papel** (persona) e o **CLI/LLM**:

- **Claude Code** — recebe a persona via \`--append-system-prompt\` + perfil MCP de dev (Serena, Context7, Playwright) + deny-list de comandos destrutivos.
- **Codex / OpenCode / Antigravity** — a persona entra como 1ª mensagem.
- **Shell (terminal puro)** — só um terminal, sem LLM.

## O Orquestrador 👑
É o agente *master* que coordena os outros. Ele usa as tools \`omnirift-agents\` (via MCP) pra **delegar tarefas** aos demais agentes — inclusive em outros *paralelos*.

- **No paralelo do Orquestrador**, o terminal dele vive no próprio node — você digita direto.
- **Em outro paralelo**, aparece um **dock flutuante** (canto inferior-direito) como controle remoto, pra você falar com ele de qualquer lugar.

## Roles
Sidebar → *Roles*: edite as personas, crie as suas, ou descubra os \`.claude/agents/\` do projeto.`,
    titleEn: "Agents and Orchestrator",
    bodyEn: `# Agents and the Orchestrator

Each agent is a terminal running an AI CLI. When you create it you choose a **role** (persona) and the **CLI/LLM**:

- **Claude Code** — gets the persona via \`--append-system-prompt\` + a dev MCP profile (Serena, Context7, Playwright) + a deny-list of destructive commands.
- **Codex / OpenCode / Antigravity** — the persona goes in as the 1st message.
- **Shell (plain terminal)** — just a terminal, no LLM.

## The Orchestrator 👑
It is the *master* agent that coordinates the others. It uses the \`omnirift-agents\` tools (via MCP) to **delegate tasks** to the other agents — including across other *parallels*.

- **In the Orchestrator's parallel**, its terminal lives in the node itself — you type straight into it.
- **In another parallel**, a **floating dock** appears (bottom-right corner) as a remote control, so you can talk to it from anywhere.

## Roles
Sidebar → *Roles*: edit the personas, create your own, or discover the project's \`.claude/agents/\`.`,
  },
  {
    id: "floors",
    title: "Paralelos (= branches git)",
    body: `# Paralelos

Um **paralelo** é uma "tela" separada do canvas — e, quando criado a partir de um repositório, **equivale a uma branch git** (um *worktree* isolado).

- Cada paralelo tem seus próprios nodes e seu próprio \`cwd\`.
- **Paralelo = branch**: trabalhe em paralelo sem misturar mudanças. O agente de um paralelo commita na branch daquele paralelo.
- Sidebar → *Paralelos*: crie um paralelo vazio, ou um paralelo como **branch git** (worktree).
- **Quick Jump**: \`Alt+1\`, \`Alt+2\`… pulam entre paralelos.
- Veja o **diff** e rode **code review IA** de um paralelo direto na lista.

Todos os paralelos ficam vivos ao mesmo tempo (os PTYs/agentes continuam rodando mesmo quando você está olhando outro paralelo).`,
    titleEn: "Parallels (= git branches)",
    bodyEn: `# Parallels

A **parallel** is a separate canvas "screen" — and, when created from a repository, it **maps to a git branch** (an isolated *worktree*).

- Each parallel has its own nodes and its own \`cwd\`.
- **Parallel = branch**: work in parallel without mixing changes. A parallel's agent commits to that parallel's branch.
- Sidebar → *Parallels*: create an empty parallel, or a parallel as a **git branch** (worktree).
- **Quick Jump**: \`Alt+1\`, \`Alt+2\`… jump between parallels.
- See the **diff** and run **AI code review** of a parallel straight from the list.

All parallels stay alive at the same time (the PTYs/agents keep running even when you are looking at another parallel).`,
  },
  {
    id: "conexoes",
    title: "Conexões entre agentes",
    body: `# Conexões e dispatch

Há duas formas de um agente falar com outro:

## 1. Pipe visual (saída A → entrada B)
Arraste das alças laterais de um terminal pra outro. A saída de A vira a entrada de B — bom pra encadear etapas.

## 2. Dispatch via Orquestrador (MCP)
O Orquestrador usa as tools \`omnirift-agents\` pra mandar uma tarefa a um agente e aguardar o resultado. Pra um agente ficar disponível ao Orquestrador, registre-o em *MCP Agents* na sidebar.

> O dispatch escreve a tarefa no terminal do agente e **submete** (Enter) automaticamente. Se um agente receber a tarefa mas não começar, verifique se ele está no modo certo (não em um prompt de permissão).`,
    titleEn: "Connections between agents",
    bodyEn: `# Connections and dispatch

There are two ways for one agent to talk to another:

## 1. Visual pipe (output A → input B)
Drag from a terminal's side handles to another. A's output becomes B's input — good for chaining steps.

## 2. Dispatch via the Orchestrator (MCP)
The Orchestrator uses the \`omnirift-agents\` tools to send a task to an agent and wait for the result. For an agent to be available to the Orchestrator, register it under *MCP Agents* in the sidebar.

> The dispatch writes the task into the agent's terminal and **submits** it (Enter) automatically. If an agent receives the task but doesn't start, check that it is in the right mode (not on a permission prompt).`,
  },
  {
    id: "routines",
    title: "Routines (automação)",
    body: `# Routines

Ações automatizadas (um comando shell) com gatilho **manual**, **por intervalo** (a cada X min) ou **por horário fixo** (às HH:MM, 1×/dia).

- Sidebar → *Routines* → **Modelos** abre presets prontos: auto-commit, commit no fim do dia, push, fetch, pull rebase, code review, testes, backup…
- Um modelo entra **desativado** — revise o comando e marque *ativa*.
- Routines ativas rodam em background **enquanto o app está aberto**, num terminal do floor ativo.

> Para rodar mesmo com o app fechado (cron de SO), use o *Agendador OS-level* (quando disponível).`,
    titleEn: "Routines (automation)",
    bodyEn: `# Routines

Automated actions (a shell command) with a **manual**, **interval-based** (every X min) or **fixed-time** (at HH:MM, once/day) trigger.

- Sidebar → *Routines* → **Templates** opens ready-made presets: auto-commit, end-of-day commit, push, fetch, pull rebase, code review, tests, backup…
- A template comes in **disabled** — review the command and mark it *active*.
- Active routines run in the background **while the app is open**, in a terminal of the active floor.

> To run even with the app closed (OS cron), use the *OS-level Scheduler* (when available).`,
  },
  {
    id: "memoria",
    title: "Memória e Conexões",
    body: `# Memória plugável

Os agentes têm um "cérebro" de memória. Sidebar → *Conexões de memória*:

- **Local (SQLite)** — blackboard offline, zero-config. É o **default**, sempre disponível.
- **OmniMemory** — cérebro remoto (entidades + relações). Endpoint + token escopado.
- **Obsidian** — seu vault local via plugin *Local REST API*. Endpoint \`https://127.0.0.1:27124\` + API key.

O provider **ativo** é injetado nos agentes Claude (Brain Connect) e consultado pelas tools de memória. Use **Testar** antes de **Usar**.

Veja também *Memória dos agentes* (ver/editar o que eles lembram) e *Histórico de sessões*.`,
    titleEn: "Memory and Connections",
    bodyEn: `# Pluggable memory

The agents have a memory "brain". Sidebar → *Memory connections*:

- **Local (SQLite)** — offline blackboard, zero-config. It is the **default**, always available.
- **OmniMemory** — remote brain (entities + relations). Endpoint + scoped token.
- **Obsidian** — your local vault via the *Local REST API* plugin. Endpoint \`https://127.0.0.1:27124\` + API key.

The **active** provider is injected into the Claude agents (Brain Connect) and queried by the memory tools. Use **Test** before **Use**.

See also *Agents' memory* (view/edit what they remember) and *Session history*.`,
  },
  {
    id: "review",
    title: "Code review",
    body: `# Code review

OmniRift integra um review de IA (BYOK — *bring your own key*):

- **LLM do review** — escolha o modelo e cole **sua chave**. Nada de segredo no binário.
- **Política de review** — regras de GO/NO-GO: 1+ CRITICAL ou 2+ WARNING bloqueiam.
- Rode o review de um paralelo pela lista de *Paralelos* (diff da branch vs base).
- Agentes Claude podem receber um **Stop hook** que os impede de encerrar enquanto o review reprovar.

Categorias avaliadas: Segurança, Qualidade, Performance, Testes, Arquitetura, Estilo (estilo nunca bloqueia).`,
    titleEn: "Code review",
    bodyEn: `# Code review

OmniRift ships with an AI review (BYOK — *bring your own key*):

- **Review LLM** — pick the model and paste **your key**. No secrets in the binary.
- **Review policy** — GO/NO-GO rules: 1+ CRITICAL or 2+ WARNING block.
- Run a parallel's review from the *Parallels* list (branch diff vs base).
- Claude agents can get a **Stop hook** that prevents them from finishing while the review fails.

Categories evaluated: Security, Quality, Performance, Testing, Architecture, Style (style never blocks).`,
  },
  {
    id: "atalhos",
    title: "Atalhos e dicas",
    body: `# Atalhos e dicas

| Ação | Como |
|---|---|
| Mover a tela | arraste o fundo |
| Zoom | scroll do mouse |
| Mover node | arraste o cabeçalho |
| Seleção múltipla | Shift + arraste |
| Maximizar node | botão ⤢ no cabeçalho |
| Restaurar | ESC |
| Pular entre paralelos | Alt+1, Alt+2, … |
| Renomear terminal | duplo-clique no nome |
| Ajuda do node | ícone ? no cabeçalho |

## Dicas
- A barra lateral é **reordenável** (arraste as seções e as ferramentas).
- *Snapshots* salvam o canvas automaticamente — dá pra restaurar versões.
- Notas viram *Lembretes* com prazo (alfinete na nota).
- Arraste um arquivo do *FileTree* pra dentro de um terminal pra colar o caminho.`,
    titleEn: "Shortcuts and tips",
    bodyEn: `# Shortcuts and tips

| Action | How |
|---|---|
| Pan the view | drag the background |
| Zoom | mouse scroll |
| Move a node | drag the header |
| Multi-selection | Shift + drag |
| Maximize node | ⤢ button in the header |
| Restore | ESC |
| Jump between parallels | Alt+1, Alt+2, … |
| Rename terminal | double-click the name |
| Node help | ? icon in the header |

## Tips
- The sidebar is **reorderable** (drag the sections and the tools).
- *Snapshots* save the canvas automatically — you can restore versions.
- Notes become *Reminders* with a due date (pin on the note).
- Drag a file from the *FileTree* into a terminal to paste its path.`,
  },
];
