// src/lib/help-content.ts
//
// Manual interno do OmniRift — conteúdo bundlado no app (não depende de docs/ no
// disco do cliente). Renderizado pelo HelpModal via renderMarkdown.

/** Grupo de dúvidas/suporte no WhatsApp (mesmo link da landing — BETA_WA). */
export const WHATSAPP_GROUP = "https://chat.whatsapp.com/D8jBZtQd70k2VponOHvETX";

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

**O que é?** Um **canvas infinito** (uma mesa de trabalho sem bordas) onde você coloca, lado a lado, **agentes de IA** (Claude Code, Codex, OpenCode, Antigravity), **terminais**, **notas**, **desenhos** e mais — tudo aberto ao mesmo tempo.

**Pra que serve?** Em vez de ficar trocando de janela, você vê todos os seus assistentes e ferramentas na mesma tela e os faz trabalhar juntos num projeto.

## Comece em 4 passos
1. **Abra um projeto.** Sidebar (barra da esquerda) → seção *Projeto* → escolha a pasta do seu código. Essa pasta vira a "pasta atual" (\`cwd\`) de todos os terminais e agentes que você criar.
2. **Crie um agente.** Sidebar → *Novo agente* → escolha um **papel** (Orquestrador, Backend, DevOps…). Ele aparece como um terminal no canvas.
3. **Converse com ele** digitando direto no terminal dele, como se fosse um chat.
4. **Salve.** Sidebar → *Workspace* → Salvar. (Os *Snapshots* automáticos também guardam seu canvas sozinhos.)

## Exemplo rápido
Quer corrigir um bug? Abra a pasta do projeto → crie um agente *Backend* → digite "encontre e corrija o erro em X" → veja ele trabalhar no terminal.

## Mexendo no canvas
- **Mover a tela:** arraste o fundo vazio.
- **Zoom:** scroll (rodinha) do mouse.
- **Mover um node (caixa):** arraste pelo cabeçalho dele.
- **Selecionar vários:** segure *Shift* e arraste em volta deles.

> Dica: todo node tem um **?** no cabeçalho que explica como usá-lo, e um **⤢** pra abrir em tela cheia (ESC volta ao normal).`,
    titleEn: "Getting started",
    bodyEn: `# Welcome to OmniRift

**What is it?** An **infinite canvas** (a borderless workbench) where you place, side by side, **AI agents** (Claude Code, Codex, OpenCode, Antigravity), **terminals**, **notes**, **sketches** and more — all open at once.

**What is it for?** Instead of switching windows all the time, you see every assistant and tool on the same screen and make them work together on a project.

## Start in 4 steps
1. **Open a project.** Sidebar (left bar) → *Project* section → pick your code folder. That folder becomes the "current folder" (\`cwd\`) of every terminal and agent you create.
2. **Create an agent.** Sidebar → *New agent* → choose a **role** (Orchestrator, Backend, DevOps…). It shows up as a terminal on the canvas.
3. **Talk to it** by typing straight into its terminal, like a chat.
4. **Save.** Sidebar → *Workspace* → Save. (The automatic *Snapshots* also keep your canvas for you.)

## Quick example
Want to fix a bug? Open the project folder → create a *Backend* agent → type "find and fix the error in X" → watch it work in the terminal.

## Moving around the canvas
- **Pan the view:** drag the empty background.
- **Zoom:** mouse scroll wheel.
- **Move a node (box):** drag it by its header.
- **Select several:** hold *Shift* and drag around them.

> Tip: every node has a **?** in its header explaining how to use it, and a **⤢** to open it fullscreen (ESC restores).`,
  },
  {
    id: "canvas",
    title: "Canvas e nodes",
    body: `# Canvas e nodes

Um **node** é cada "caixinha" no canvas (um terminal, uma nota, um desenho…). A **barra de ferramentas no topo** cria os tipos de node — clique num ícone pra adicionar.

## Comandos que todo node tem
- **? (ajuda)** — passe o mouse pra ver como usar aquele node.
- **⤢ Maximizar** — abre o node em tela cheia. **ESC** restaura.
- **Comentário** — vários nodes têm um rodapé "Comentário" pra você anotar contexto.
- **Redimensionar** — selecione o node e arraste a alça do canto.

## Tipos de node (o que cada um faz)
- **Terminal / Agente** — um shell ou uma CLI de IA (veja o tópico *Agentes*).
- **Nota** — texto livre. O alfinete transforma a nota num *Lembrete* com prazo.
- **Grupo** — solte outros nodes em cima pra agrupá-los; arraste o grupo pelo título.
- **Sketch** — desenho à mão livre (tldraw), bom pra rascunhar ideias.
- **Preview** — mostra como fica um arquivo \`.md\` ou \`.html\` já renderizado.
- **JSON** — abre dados como Texto, Árvore ou **Mapa mental** navegável (JSON, XML, HTML).
- **API** — cliente HTTP simples: escolha método + URL + corpo e dispare a requisição.
- **DB** — navega bancos SQLite: lista tabelas e roda SQL.
- **DevTools** — conversores úteis (Base64, hash, JWT…).
- **FileTree** — árvore de arquivos do projeto. Arraste um arquivo pra dentro de um terminal e o caminho é colado.
- **Portal** — embute uma página web (localhost) dentro de um node.

> Não sabe por onde começar? Comece com um **Terminal/Agente** e um **FileTree** lado a lado.`,
    titleEn: "Canvas and nodes",
    bodyEn: `# Canvas and nodes

A **node** is each "box" on the canvas (a terminal, a note, a sketch…). The **toolbar at the top** creates the node types — click an icon to add one.

## Controls every node has
- **? (help)** — hover to see how to use that node.
- **⤢ Maximize** — opens the node fullscreen. **ESC** restores.
- **Comment** — several nodes have a "Comment" footer to jot down context.
- **Resize** — select the node and drag the corner handle.

## Node types (what each one does)
- **Terminal / Agent** — a shell or an AI CLI (see the *Agents* topic).
- **Note** — free text. The pin turns the note into a *Reminder* with a due date.
- **Group** — drop other nodes on top to group them; drag the group by its title.
- **Sketch** — freehand drawing (tldraw), great for sketching ideas.
- **Preview** — shows a \`.md\` or \`.html\` file already rendered.
- **JSON** — opens data as Text, Tree or a navigable **Mind map** (JSON, XML, HTML).
- **API** — a simple HTTP client: pick method + URL + body and fire the request.
- **DB** — browse SQLite databases: list tables and run SQL.
- **DevTools** — handy converters (Base64, hash, JWT…).
- **FileTree** — the project's file tree. Drag a file into a terminal and its path is pasted.
- **Portal** — embeds a web page (localhost) inside a node.

> Not sure where to start? Begin with a **Terminal/Agent** and a **FileTree** side by side.`,
  },
  {
    id: "agentes",
    title: "Agentes e Orquestrador",
    body: `# Agentes e o Orquestrador

Um **agente** é um terminal rodando uma CLI de IA. Na hora de criar, você escolhe duas coisas:

1. **O papel (persona)** — o "chapéu" do agente: Orquestrador, Backend, DevOps, etc. Ele define como o agente pensa e o que prioriza.
2. **A CLI/LLM** — qual ferramenta de IA roda por baixo:
   - **Claude Code** — recebe a persona via \`--append-system-prompt\`, ganha um perfil de ferramentas de dev (Serena, Context7, Playwright) e uma lista de comandos destrutivos bloqueados.
   - **Codex / OpenCode / Antigravity** — a persona entra como a 1ª mensagem da conversa.
   - **Shell (terminal puro)** — só um terminal normal, sem IA.

## O Orquestrador 👑
É o agente **chefe**, que coordena os outros. Em vez de você mandar tarefa pra cada um, você fala com o Orquestrador e ele **delega** (reparte e acompanha) — usando as ferramentas \`omnirift-agents\` por baixo.

- **No paralelo onde o Orquestrador vive:** o terminal dele fica no próprio node — digite direto.
- **Em qualquer outro paralelo:** aparece um **dock flutuante** no canto inferior-direito, um controle remoto pra você falar com ele sem precisar voltar.

## Editar / criar papéis
Sidebar → *Roles*: ajuste as personas que já vêm, crie as suas, ou deixe ele descobrir os papéis em \`.claude/agents/\` do seu projeto.

> Comece com **1 Orquestrador + 1 ou 2 agentes** especialistas. Mais que isso só quando você pegar o jeito.`,
    titleEn: "Agents and Orchestrator",
    bodyEn: `# Agents and the Orchestrator

An **agent** is a terminal running an AI CLI. When you create one you pick two things:

1. **The role (persona)** — the agent's "hat": Orchestrator, Backend, DevOps, etc. It defines how the agent thinks and what it prioritizes.
2. **The CLI/LLM** — which AI tool runs underneath:
   - **Claude Code** — gets the persona via \`--append-system-prompt\`, a dev tools profile (Serena, Context7, Playwright) and a deny-list of destructive commands.
   - **Codex / OpenCode / Antigravity** — the persona goes in as the conversation's 1st message.
   - **Shell (plain terminal)** — just a normal terminal, no AI.

## The Orchestrator 👑
It is the **boss** agent that coordinates the others. Instead of handing a task to each one, you talk to the Orchestrator and it **delegates** (splits and tracks the work) — using the \`omnirift-agents\` tools underneath.

- **In the parallel where the Orchestrator lives:** its terminal sits in the node itself — type straight in.
- **In any other parallel:** a **floating dock** appears in the bottom-right corner, a remote control to talk to it without going back.

## Edit / create roles
Sidebar → *Roles*: tweak the built-in personas, create your own, or let it discover the roles in your project's \`.claude/agents/\`.

> Start with **1 Orchestrator + 1 or 2** specialist agents. Add more only once you get the hang of it.`,
  },
  {
    id: "pipeline",
    title: "Arquiteto de Pipeline",
    body: `# Arquiteto de Pipeline

Não sabe **quantos agentes** criar nem **quem faz o quê**? Descreva o projeto em uma frase e deixe o **Arquiteto** montar o time pra você.

## Como funciona
1. Sidebar → *Arquiteto de Pipeline*.
2. Escreva o que você quer (ex.: "uma API de tarefas com login e testes").
3. Escolha **quem planeja**: o **agente local** (o mesmo Claude Code que você já usa, sem chave extra) ou um provider da *Central de API*.
4. Clique **Gerar**. Ele desenha um **mini-mapa** do time: agentes, **subagentes**, conexões, **paralelos** e as **ondas** de execução (o que roda antes, o que roda depois).

## Montar no canvas
Gostou do plano? Clique em **Montar** e o Arquiteto cria tudo de verdade no canvas:
- os **agentes** já com o papel certo e o modelo escolhido;
- os **subagentes** (\`.claude/agents/\`) de cada especialista;
- as **conexões** entre eles;
- os cards no **Kanban** (ele semeia o backlog).

## Ancorar na arquitetura real
Se o **OmniGraph** estiver disponível, ligue *ancorar na arquitetura real*: o Arquiteto lê o **grafo do seu código** antes de planejar, então o time nasce sabendo como o projeto já é feito — não um plano genérico.

## Bom saber
- O plano fica **gravado por projeto** — você pode revisitar e montar de novo depois.
- Um selo **X/Y** mostra quantos agentes do plano já estão montados no canvas.

> Comece pequeno: descreva um objetivo enxuto, gere e monte. Você sempre pode pedir mais agentes depois.`,
    titleEn: "Pipeline Architect",
    bodyEn: `# Pipeline Architect

Not sure **how many agents** to create or **who does what**? Describe the project in one sentence and let the **Architect** assemble the team for you.

## How it works
1. Sidebar → *Pipeline Architect*.
2. Write what you want (e.g. "a task API with login and tests").
3. Pick **who plans**: the **local agent** (the same Claude Code you already use, no extra key) or a provider from the *API Central*.
4. Click **Generate**. It draws a **mini-map** of the team: agents, **subagents**, connections, **parallels** and the **waves** of execution (what runs first, what runs later).

## Build it on the canvas
Like the plan? Click **Build** and the Architect creates it all for real on the canvas:
- the **agents** already with the right role and chosen model;
- each specialist's **subagents** (\`.claude/agents/\`);
- the **connections** between them;
- the cards on the **Kanban** (it seeds the backlog).

## Anchor on the real architecture
If **OmniGraph** is available, turn on *anchor on the real architecture*: the Architect reads your **code graph** before planning, so the team is born knowing how the project is actually built — not a generic plan.

## Good to know
- The plan is **saved per project** — you can revisit and build again later.
- An **X/Y** badge shows how many of the plan's agents are already on the canvas.

> Start small: describe a lean goal, generate, and build. You can always ask for more agents later.`,
  },
  {
    id: "providers",
    title: "Central de API (chaves de LLM)",
    body: `# Central de API

Quer usar **outros modelos** além do Claude Code — Ollama, OpenAI, Groq, Gemini, OpenRouter? Cadastre a chave **uma vez** aqui e depois é só **escolher** onde usar.

## Onde fica
Sidebar → *Central de API*.

## Cadastrar um provider
1. Escolha o **tipo** (Ollama Cloud, OpenRouter, OpenAI, Anthropic, Groq, Google Gemini ou Local/LM Studio). O endereço já vem preenchido.
2. Dê um **nome** (ex.: "meu OpenRouter").
3. Cole a **chave de API** (os tipos *Local* não pedem chave).
4. **Salve**. A chave vai pro **cofre do sistema operacional** (keychain) — não fica solta no app nem no canvas.

## Testar e usar
- **Testar** lista os modelos que a chave enxerga — prova que conectou.
- Depois, o provider aparece pra escolher no **Arquiteto de Pipeline**, no **OmniPartner**, no **Code Review** e no wizard do **Hermes**.

## É BYOK
*Bring Your Own Key* — "traga a sua chave": você usa **sua** conta. O OmniRift nunca embute segredo de LLM, e você pode **remover** um provider quando quiser.

> Não precisa cadastrar nada pra começar: o agente local (Claude Code) já funciona sem chave extra. A Central é pra quando você quer **variar de modelo**.`,
    titleEn: "API Central (LLM keys)",
    bodyEn: `# API Central

Want to use **other models** besides Claude Code — Ollama, OpenAI, Groq, Gemini, OpenRouter? Register the key **once** here and then just **pick** where to use it.

## Where it is
Sidebar → *API Central*.

## Register a provider
1. Choose the **type** (Ollama Cloud, OpenRouter, OpenAI, Anthropic, Groq, Google Gemini or Local/LM Studio). The address is pre-filled.
2. Give it a **name** (e.g. "my OpenRouter").
3. Paste the **API key** (the *Local* types need no key).
4. **Save**. The key goes into the **operating-system vault** (keychain) — it never sits loose in the app or on the canvas.

## Test and use
- **Test** lists the models the key can see — proof it connected.
- After that, the provider shows up to pick in the **Pipeline Architect**, **OmniPartner**, **Code Review** and the **Hermes** wizard.

## It's BYOK
*Bring Your Own Key*: you use **your** account. OmniRift never bakes in an LLM secret, and you can **remove** a provider whenever you want.

> You don't need to register anything to start: the local agent (Claude Code) already works with no extra key. The Central is for when you want to **switch models**.`,
  },
  {
    id: "companion",
    title: "OmniPartner (IA)",
    body: `# OmniPartner — o parceiro de IA

O **OmniPartner** é um assistente lateral que **enxerga o seu canvas** (os agentes, o estado deles, a memória) e te ajuda a operar. Abra em Sidebar → *OmniPartner (IA)*.

## Dois modos

### Analisar
Uma leitura **na hora**: o OmniPartner olha tudo que está aberto e devolve um **resumo** + **próximos passos** sugeridos. Ótimo quando você voltou de um tempo longe e quer saber "onde é que eu estava?".

### Aprender (tutor)
Um **tutor Socrático**: ele te ensina a programar com **perguntas** e um **exercício verificável** dentro da pasta do projeto.
- Escolha a **trilha** (linguagem).
- Ele propõe um exercício; você tenta.
- Precisa de ajuda? Peça uma **dica** — elas vêm **graduadas** (primeiro leve, depois mais direta).
- Ao terminar, ele **checa automaticamente** se passou (o mesmo verificador do 🎯 Goal).

## BYOK
O OmniPartner usa o **provider de LLM** que você escolher (veja *Central de API*).

> Use o *Analisar* como um "resumo executivo" do canvas; o *Aprender* quando quiser evoluir de verdade, não só terminar a tarefa.`,
    titleEn: "OmniPartner (AI)",
    bodyEn: `# OmniPartner — your AI sidekick

**OmniPartner** is a side assistant that **sees your canvas** (the agents, their state, the memory) and helps you operate. Open it under Sidebar → *OmniPartner (AI)*.

## Two modes

### Analyze
A **right-now** read: OmniPartner looks at everything open and returns a **summary** + suggested **next steps**. Great when you've been away and want to know "where was I?".

### Learn (tutor)
A **Socratic tutor**: it teaches you to code with **questions** and a **checkable exercise** inside the project folder.
- Pick the **track** (language).
- It proposes an exercise; you try.
- Need help? Ask for a **hint** — they come **graded** (gentle first, more direct later).
- When you finish, it **checks automatically** whether you passed (the same checker as 🎯 Goal).

## BYOK
OmniPartner uses the **LLM provider** you choose (see *API Central*).

> Use *Analyze* as an "executive summary" of the canvas; *Learn* when you actually want to level up, not just finish the task.`,
  },
  {
    id: "floors",
    title: "Paralelos (= branches git)",
    body: `# Paralelos

Um **paralelo** é uma "tela" separada do canvas. Pense nele como uma **aba de trabalho**: cada paralelo tem seus próprios nodes e sua própria pasta atual (\`cwd\`).

## O pulo do gato: paralelo = branch git
Quando você cria um paralelo **a partir de um repositório**, ele vira uma **branch git** isolada (um *worktree*). Na prática:

- Você trabalha em duas frentes **sem misturar** as mudanças de uma na outra.
- O agente de cada paralelo **commita na branch daquele paralelo**.
- Exemplo: paralelo "feature-login" mexe na branch \`feature-login\`; o paralelo "hotfix" mexe noutra branch — ao mesmo tempo.

## Como usar
- Sidebar → *Paralelos*: crie um **paralelo vazio**, ou um **paralelo como branch git** (worktree).
- **Quick Jump:** \`Alt+1\`, \`Alt+2\`, … pulam entre paralelos na hora.
- Na própria lista você vê o **diff** da branch e pode rodar um **code review de IA**.

> Todos os paralelos ficam vivos ao mesmo tempo: os agentes/terminais continuam rodando mesmo quando você está olhando outro paralelo.`,
    titleEn: "Parallels (= git branches)",
    bodyEn: `# Parallels

A **parallel** is a separate canvas "screen". Think of it as a **work tab**: each parallel has its own nodes and its own current folder (\`cwd\`).

## The key trick: parallel = git branch
When you create a parallel **from a repository**, it becomes an isolated **git branch** (a *worktree*). In practice:

- You work on two fronts **without mixing** one's changes into the other.
- Each parallel's agent **commits to that parallel's branch**.
- Example: the "feature-login" parallel works on branch \`feature-login\`; the "hotfix" parallel works on another branch — at the same time.

## How to use it
- Sidebar → *Parallels*: create an **empty parallel**, or a **parallel as a git branch** (worktree).
- **Quick Jump:** \`Alt+1\`, \`Alt+2\`, … jump between parallels instantly.
- Right in the list you can see the branch **diff** and run an **AI code review**.

> All parallels stay alive at once: the agents/terminals keep running even when you're looking at another parallel.`,
  },
  {
    id: "conexoes",
    title: "Conexões entre agentes",
    body: `# Conexões e dispatch

Tem três formas de fazer um agente "falar" com outro:

## 1. Pipe visual (saída de A → entrada de B)
Arraste a partir das **alças laterais** de um terminal até outro terminal. A **saída** do agente A passa a entrar como **entrada** no agente B. Ótimo pra **encadear etapas** (ex.: A gera o plano, B executa).

## 2. Dispatch pelo Orquestrador (MCP)
O Orquestrador usa as ferramentas \`omnirift-agents\` pra **mandar uma tarefa** a um agente e **esperar o resultado**. Pra um agente ficar visível pro Orquestrador, registre-o em *MCP Agents* na sidebar.

## Passo-a-passo do dispatch
1. Registre os agentes "trabalhadores" em *MCP Agents*.
2. Peça ao Orquestrador algo como "delegue X pro agente Backend".
3. Ele escreve a tarefa no terminal do agente e **dá Enter** automaticamente.

## 3. Conexão com contrato (schema)
Uma conexão pode **exigir um formato** da saída de A. Na *Área de Conexões* (Sidebar → *Conexões de memória*), cole um **schema** (ou um exemplo de JSON) na conexão A→B. Quando A produz a saída, o app **valida**: **✓** se bate com o formato, **✗** se não bate. Assim você garante que B só recebe dados no jeito que ele espera — bom pra encadear etapas com segurança.

> Se um agente receber a tarefa mas não começar, confira se ele não está **parado num prompt de permissão** (esperando você confirmar algo). Resolva o prompt e ele segue.`,
    titleEn: "Connections between agents",
    bodyEn: `# Connections and dispatch

There are three ways to make one agent "talk" to another:

## 1. Visual pipe (A's output → B's input)
Drag from a terminal's **side handles** to another terminal. Agent A's **output** becomes agent B's **input**. Great for **chaining steps** (e.g. A writes the plan, B runs it).

## 2. Dispatch via the Orchestrator (MCP)
The Orchestrator uses the \`omnirift-agents\` tools to **send a task** to an agent and **wait for the result**. For an agent to be visible to the Orchestrator, register it under *MCP Agents* in the sidebar.

## Dispatch step by step
1. Register the "worker" agents under *MCP Agents*.
2. Ask the Orchestrator something like "delegate X to the Backend agent".
3. It writes the task into the agent's terminal and **presses Enter** automatically.

## 3. Connection with a contract (schema)
A connection can **require a format** for A's output. In the *Connections area* (Sidebar → *Memory connections*), paste a **schema** (or a JSON example) on the A→B connection. When A produces output, the app **validates** it: **✓** if it matches the format, **✗** if it doesn't. That way B only ever receives data in the shape it expects — great for chaining steps safely.

> If an agent receives the task but doesn't start, check it isn't **stuck on a permission prompt** (waiting for you to confirm something). Clear the prompt and it carries on.`,
  },
  {
    id: "kanban",
    title: "Kanban do projeto",
    body: `# Kanban do projeto

Um quadro visual pra acompanhar o trabalho: **Backlog → Em andamento → Review → Concluído** (as colunas padrão). Abra em Sidebar → *Kanban do projeto*.

## O pulo do gato: os agentes movem os cards sozinhos
Diferente de um quadro comum, aqui **os próprios agentes** criam e movem os cards enquanto trabalham (via as ferramentas \`kanban_*\`). Você **acompanha** e ajusta quando quiser — é o painel de controle do time.

## O que você pode fazer
- **Criar** um card (digite o título + Enter).
- **Mover** um card entre colunas com as setas.
- **Focar**: clicar num card **leva você até o agente** ligado a ele no canvas.
- **Personalizar as colunas** (⚙ no topo) — troque o fluxo de 6 colunas pelo do seu projeto.

## De onde vem o backlog
O **Arquiteto de Pipeline** já **semeia** o backlog quando monta um time — você abre o Kanban e o trabalho inicial já está listado.

> O quadro atualiza **ao vivo**: conforme os agentes progridem, os cards andam sozinhos.`,
    titleEn: "Project Kanban",
    bodyEn: `# Project Kanban

A visual board to track the work: **Backlog → In progress → Review → Done** (the default columns). Open it under Sidebar → *Project Kanban*.

## The key trick: the agents move the cards themselves
Unlike a plain board, here **the agents themselves** create and move cards as they work (via the \`kanban_*\` tools). You **watch** and adjust when you want — it's the team's control panel.

## What you can do
- **Create** a card (type the title + Enter).
- **Move** a card between columns with the arrows.
- **Focus**: clicking a card **takes you to the agent** linked to it on the canvas.
- **Customize the columns** (⚙ at the top) — swap the 6-column flow for your project's.

## Where the backlog comes from
The **Pipeline Architect** already **seeds** the backlog when it builds a team — you open the Kanban and the initial work is already listed.

> The board updates **live**: as the agents progress, the cards move on their own.`,
  },
  {
    id: "routines",
    title: "Routines (automação)",
    body: `# Routines

Uma **Routine** é uma **ação automática** (um comando de terminal) que dispara sozinha. Você escolhe **quando** ela roda:

- **Manual** — só quando você clicar.
- **Por intervalo** — a cada X minutos.
- **Por horário fixo** — às HH:MM, 1×/dia.

## Como criar
1. Sidebar → *Routines* → **Modelos**: abra os presets prontos (auto-commit, commit no fim do dia, push, fetch, pull rebase, code review, testes, backup…).
2. Todo modelo entra **desativado** — revise o comando primeiro.
3. Marque como **ativa** quando estiver confiante.

## Bom saber
- Routines ativas rodam **em background enquanto o app está aberto**, num terminal do paralelo ativo.
- Pra rodar **mesmo com o app fechado** (cron do sistema operacional), use o *Agendador OS-level*, quando disponível.

> Comece pelo modelo **auto-commit**: ele salva seu progresso de tempos em tempos sem você lembrar.`,
    titleEn: "Routines (automation)",
    bodyEn: `# Routines

A **Routine** is an **automatic action** (a terminal command) that fires on its own. You choose **when** it runs:

- **Manual** — only when you click.
- **Interval-based** — every X minutes.
- **Fixed-time** — at HH:MM, once/day.

## How to create one
1. Sidebar → *Routines* → **Templates**: open the ready-made presets (auto-commit, end-of-day commit, push, fetch, pull rebase, code review, tests, backup…).
2. Every template comes in **disabled** — review the command first.
3. Mark it **active** once you're confident.

## Good to know
- Active routines run **in the background while the app is open**, in a terminal of the active parallel.
- To run **even with the app closed** (OS cron), use the *OS-level Scheduler* when available.

> Start with the **auto-commit** template: it saves your progress every so often so you don't have to remember.`,
  },
  {
    id: "turbo",
    title: "TURBO e Goal (loop autônomo)",
    body: `# TURBO e Goal — deixar o agente insistir sozinho

Às vezes você quer que o agente **não pare** até algo dar certo — os testes passarem, o build compilar, um comando retornar OK. É pra isso o **🎯 Goal** (num agente) e o **TURBO** (no projeto inteiro).

## 🎯 Goal (no próprio agente)
No cabeçalho de um agente, defina um **objetivo** com uma **condição verificável** — um comando que "passa" quando retorna 0 (tipo \`npm test\`). O agente **repete** o ciclo — tenta, checa a condição — até ela passar. O **🔁 Loop** é a versão por tempo (repete a cada intervalo).

## TURBO mode (no projeto)
Sidebar → *TURBO mode*. É o loop autônomo do projeto inteiro:
1. Você dá um **goal** + a **condição de verificação**.
2. Um agente **implementer** trabalha; a condição é checada a cada rodada.
3. Um **verifier** dá o **GO/NO-GO** no fim.

Ele **não faz commit sozinho** — o resultado é seu pra revisar.

> Use com uma condição **clara e barata de checar** (um teste, um lint). Sem condição objetiva, o loop não sabe quando parar.`,
    titleEn: "TURBO and Goal (autonomous loop)",
    bodyEn: `# TURBO and Goal — let the agent keep at it

Sometimes you want the agent to **not stop** until something works — the tests pass, the build compiles, a command returns OK. That's what **🎯 Goal** (per agent) and **TURBO** (project-wide) are for.

## 🎯 Goal (on the agent itself)
In an agent's header, set a **goal** with a **checkable condition** — a command that "passes" when it returns 0 (like \`npm test\`). The agent **repeats** the cycle — try, check the condition — until it passes. **🔁 Loop** is the time-based version (repeats every interval).

## TURBO mode (project-wide)
Sidebar → *TURBO mode*. It's the autonomous loop for the whole project:
1. You give a **goal** + the **verification condition**.
2. An **implementer** agent works; the condition is checked each round.
3. A **verifier** gives the **GO/NO-GO** at the end.

It **won't commit on its own** — the result is yours to review.

> Use it with a **clear, cheap-to-check** condition (a test, a lint). Without an objective condition the loop can't tell when to stop.`,
  },
  {
    id: "memoria",
    title: "Memória e Conexões",
    body: `# Memória plugável

Os agentes têm um "cérebro" de memória — eles **lembram** decisões e fatos entre sessões. Você escolhe **qual cérebro** usar em Sidebar → *Conexões de memória*:

- **Local (SQLite)** — um caderninho offline no seu computador, sem configurar nada. É o **padrão** e está **sempre disponível**.
- **OmniMemory** — um cérebro **remoto** (entidades + relações). Informe o endpoint + um token escopado.
- **Obsidian** — usa o **seu vault local** via plugin *Local REST API*. Endpoint \`https://127.0.0.1:27124\` + a API key.

## Como conectar
1. Abra *Conexões de memória*.
2. Escolha o provider, preencha endpoint/token.
3. Clique **Testar** pra confirmar que conecta.
4. Clique **Usar** pra deixá-lo ativo.

O provider **ativo** é injetado automaticamente nos agentes Claude (Brain Connect) e é consultado pelas ferramentas de memória.

> Veja também *Memória dos agentes* (ver/editar o que eles lembram) e *Histórico de sessões* (retomar de onde parou).`,
    titleEn: "Memory and Connections",
    bodyEn: `# Pluggable memory

The agents have a memory "brain" — they **remember** decisions and facts across sessions. You pick **which brain** to use under Sidebar → *Memory connections*:

- **Local (SQLite)** — an offline notebook on your computer, zero setup. It's the **default** and is **always available**.
- **OmniMemory** — a **remote** brain (entities + relations). Provide the endpoint + a scoped token.
- **Obsidian** — uses **your local vault** via the *Local REST API* plugin. Endpoint \`https://127.0.0.1:27124\` + the API key.

## How to connect
1. Open *Memory connections*.
2. Pick the provider, fill in endpoint/token.
3. Click **Test** to confirm it connects.
4. Click **Use** to make it active.

The **active** provider is automatically injected into the Claude agents (Brain Connect) and queried by the memory tools.

> See also *Agents' memory* (view/edit what they remember) and *Session history* (pick up where you left off).`,
  },
  {
    id: "omnifs",
    title: "OmniFS — Pasta de agentes",
    body: `# OmniFS — o "desfazer" dos agentes

O **OmniFS** é um **drive versionado** que roda por baixo dos agentes: cada vez que um agente mexe nos arquivos, o OmniFS guarda um **ponto de retorno**. É uma máquina do tempo invisível — se algo der errado, você **volta atrás**.

## Voltar um agente no tempo (checkpoints)
No cabeçalho de um **agente**, o menu de **checkpoints** (ícone de relógio/histórico) lista os pontos que ele criou — **um por turno** que editou arquivos. Escolha um e **volte o drive** pro estado daquele momento.
- É **destrutivo** e restaura a **árvore inteira** do projeto → o app pede **confirmação dupla**.
- Sem OmniFS ou sem edições, o menu **nem aparece** (não atrapalha).

## O painel completo
Sidebar → *OmniFS — Pasta de agentes*:
- **Status** — se o daemon está vivo, o espaço em disco, gerenciado × externo.
- **Snapshots** — a linha do tempo. Tire um **Snapshot agora** ou **Restaure** um ponto anterior (aqui também com confirmação em 2 passos).
- **Busca semântica** — procure nos arquivos **por significado** ("onde valido o e-mail?"), não só por palavra exata. Se precisar, **reindexe**.

## Se travar: Reconectar
Se o disco encher, o drive pode **congelar**. O painel detecta isso e mostra um botão **Reconectar** — ele remonta o drive sem você reiniciar o app. (O OmniRift também **recusa** tirar snapshot quando o disco está quase cheio, pra não travar.)

> O melhor do OmniFS é que você **nem percebe** ele — até o dia em que precisa desfazer meia hora de trabalho de um agente num clique.`,
    titleEn: "OmniFS — Agents' folder",
    bodyEn: `# OmniFS — the agents' "undo"

**OmniFS** is a **versioned drive** running under the agents: every time an agent touches the files, OmniFS keeps a **restore point**. It's an invisible time machine — if something goes wrong, you **roll it back**.

## Rewind an agent in time (checkpoints)
In an **agent's** header, the **checkpoints** menu (clock/history icon) lists the points it created — **one per turn** that edited files. Pick one and **roll the drive back** to that moment.
- It's **destructive** and restores the **whole tree** of the project → the app asks for **double confirmation**.
- With no OmniFS or no edits, the menu **doesn't even show** (it won't get in the way).

## The full panel
Sidebar → *OmniFS — Agents' folder*:
- **Status** — whether the daemon is alive, disk space, managed × external.
- **Snapshots** — the timeline. Take a **Snapshot now** or **Restore** an earlier point (also with a 2-step confirmation).
- **Semantic search** — search the files **by meaning** ("where do I validate the email?"), not just by exact word. **Reindex** if needed.

## If it freezes: Reconnect
If the disk fills up, the drive can **freeze**. The panel detects it and shows a **Reconnect** button — it remounts the drive without you restarting the app. (OmniRift also **refuses** to take a snapshot when the disk is nearly full, to avoid a freeze.)

> The best thing about OmniFS is you **barely notice** it — until the day you need to undo half an hour of an agent's work in one click.`,
  },
  {
    id: "omnigraph",
    title: "OmniGraph — mapa do código",
    body: `# OmniGraph — o mapa do seu código

O **OmniGraph** lê o seu projeto e monta um **grafo de conhecimento**: quais partes existem, como elas se chamam e onde mora o risco. É o "raio-X estrutural" que dá aos agentes (e a você) uma visão de **como o código realmente é**.

## Trazer o mapa pro canvas
No **canto superior direito** do canvas, o botão **🕸️ Mapa do código ▾** traz o grafo como nodes — **sob demanda**: no primeiro clique ele **gera** o grafo (leva ~1-2 min em segundo plano; o abrir do projeto não faz mais isso pra não travar repos grandes) e nos próximos só mostra. São **4 visões** do mesmo mapa:
- **Comunidades** — os "bairros" do código (grupos que andam juntos).
- **Chamadas** — quem chama quem.
- **Dependências** — o que depende de quê.
- **Risco** — onde o perigo se concentra (os pontos quentes).

Pode **empilhar** várias visões no mesmo canvas.

## Comparar no tempo
**Comparar** mostra o **diff** entre dois retratos do grafo — ótimo pra ver *o que a arquitetura ganhou ou perdeu* entre duas fases.

## Limpar o grafo
Toda análise tem **relações incertas**. O botão **limpar grafo** junta as mais duvidosas e cria **um subagente** encarregado de **confirmar ou negar** cada uma no código — o mapa se auto-corrige.

## Onde mais ele ajuda
- **Arquiteto de Pipeline** — ligue *ancorar na arquitetura real* e o time nasce sabendo como o projeto é feito.
- **Code review** — pode usar o grafo como **portão estrutural**: mudanças que bagunçam a arquitetura são sinalizadas.

> Rode o OmniGraph antes de crescer o projeto: é mais fácil arrumar a estrutura enquanto ela é pequena.`,
    titleEn: "OmniGraph — code map",
    bodyEn: `# OmniGraph — the map of your code

**OmniGraph** reads your project and builds a **knowledge graph**: which parts exist, how they call each other, and where the risk lives. It's the "structural X-ray" that gives the agents (and you) a view of **how the code really is**.

## Bring the map onto the canvas
In the **top-right corner** of the canvas, the **import view ▾** button brings the graph in as nodes. There are **4 views** of the same map:
- **Communities** — the code's "neighborhoods" (groups that move together).
- **Calls** — who calls whom.
- **Dependencies** — what depends on what.
- **Risk** — where the danger concentrates (the hot spots).

You can **stack** several views on the same canvas.

## Compare over time
**Compare** shows the **diff** between two snapshots of the graph — great to see *what the architecture gained or lost* between two phases.

## Clean the graph
Every analysis has **uncertain relations**. The **clean graph** button gathers the most doubtful ones and creates **one subagent** tasked with **confirming or denying** each in the code — the map self-corrects.

## Where else it helps
- **Pipeline Architect** — turn on *anchor on the real architecture* and the team is born knowing how the project is built.
- **Code review** — it can use the graph as a **structural gate**: changes that mess up the architecture get flagged.

> Run OmniGraph before the project grows: it's easier to fix the structure while it's still small.`,
  },
  {
    id: "review",
    title: "Code review",
    body: `# Code review

OmniRift traz um **revisor de código por IA** — ele lê suas mudanças e aponta problemas antes de você juntar tudo. É **BYOK** (*bring your own key*): você usa **sua própria chave** de LLM, nada de segredo embutido no app.

## Como configurar
- **LLM do review** — escolha o modelo e **cole sua chave** de API.
- **Política de review** — define o GO/NO-GO: por padrão, **1+ CRITICAL** ou **2+ WARNING** bloqueiam.

## Como rodar
- Na lista de *Paralelos*, rode o review de um paralelo. Ele compara o **diff da branch contra a base**.
- Agentes Claude podem ganhar um **Stop hook**: enquanto o review estiver reprovado, o agente **não encerra** — ele tenta corrigir.

## O que ele avalia
Segurança, Qualidade, Performance, Testes, Arquitetura e Estilo. **Estilo nunca bloqueia** (só sugere).

> Rode o review antes de mesclar uma branch — é a sua rede de segurança.`,
    titleEn: "Code review",
    bodyEn: `# Code review

OmniRift ships an **AI code reviewer** — it reads your changes and flags issues before you merge. It's **BYOK** (*bring your own key*): you use **your own** LLM key, no secrets baked into the app.

## How to set it up
- **Review LLM** — pick the model and **paste your API key**.
- **Review policy** — sets the GO/NO-GO: by default, **1+ CRITICAL** or **2+ WARNING** block.

## How to run it
- From the *Parallels* list, run a parallel's review. It compares the **branch diff against the base**.
- Claude agents can get a **Stop hook**: while the review is failing, the agent **won't finish** — it tries to fix it.

## What it checks
Security, Quality, Performance, Testing, Architecture and Style. **Style never blocks** (it only suggests).

> Run the review before merging a branch — it's your safety net.`,
  },
  {
    id: "saude",
    title: "Saúde do Projeto",
    body: `# Saúde do Projeto

Um painel que faz um **raio-X do seu projeto**: o quanto ele está complexo, onde mora a "dívida técnica" e o que vale a pena melhorar primeiro. Útil pra decidir **onde mexer** antes de crescer mais.

## Como abrir
Botão na **barra do canvas** (ou pela Paleta de Comandos → "Saúde do Projeto"). Ele usa o **projeto aberto** (a pasta atual), então abra um projeto antes.

## O que ele mostra
- **Código** — varre os arquivos e mede **complexidade**; destaca os mais pesados/arriscados. O resultado vai aparecendo **progressivamente** conforme ele analisa.
- **Banco de dados** — visão da estrutura dos seus bancos (dimensão em evolução).
- **Dívida / Aprendizado** — pontos a melhorar e o que dá pra aprender com o histórico do projeto.

## Analisar com IA
Em arquivos individuais (ou em lote), peça uma **análise de IA** pra receber um diagnóstico em linguagem clara: o que está ruim e como melhorar.

## Re-escanear e backup
- Use **↻** pra rodar o scan de novo depois de mudanças.
- Faça **backup** do projeto antes de uma faxina grande — assim você volta atrás sem medo.

> Comece olhando os arquivos mais complexos: costumam ser os que mais quebram.`,
    titleEn: "Project Health",
    bodyEn: `# Project Health

A panel that gives your project an **X-ray**: how complex it is, where the "technical debt" lives, and what's worth improving first. Handy to decide **where to act** before it grows further.

## How to open it
Button on the **canvas toolbar** (or via the Command Palette → "Project Health"). It uses the **open project** (the current folder), so open a project first.

## What it shows
- **Code** — scans the files and measures **complexity**; highlights the heaviest/riskiest ones. Results show up **progressively** as it analyzes.
- **Database** — a view of your databases' structure (an evolving dimension).
- **Debt / Learn** — points to improve and what you can learn from the project's history.

## Analyze with AI
On individual files (or in batch), request an **AI analysis** to get a plain-language diagnosis: what's wrong and how to fix it.

## Re-scan and backup
- Use **↻** to run the scan again after changes.
- Back up the project before a big cleanup — so you can roll back without worry.

> Start with the most complex files: they're usually the ones that break the most.`,
  },
  {
    id: "insights",
    title: "Uso de Tokens (Insights)",
    body: `# Uso de Tokens

Agentes de IA gastam **tokens** — e token custa. Este painel mostra **quanto** você está gastando, **onde** e **com qual modelo**, sem mandar nada pra fora: é tudo lido **localmente** da sua máquina. Abra em Sidebar → *Uso de Tokens*.

## O que ele mostra
- **Total geral** de tokens e **custo estimado** — filtre por período (tudo / hoje / 7 dias / 30 dias).
- **Por modelo/LLM** e **por projeto** — veja quem come mais.
- **Tendência** — uma linha do tempo (estilo painel de métricas) do gasto por dia.
- **Por agente** — dos agentes vivos no canvas: tokens, custo, tempo de sessão, **latência** (p95) e **taxa de erro** por turno.

## Orçamento mensal (com alerta)
Defina um **teto de gasto por projeto**. Ao se aproximar, o painel **avisa**; passou do limite, ele **sinaliza** — sua rédea pra não estourar a conta.

## Re-escanear
Use **↻** pra recalcular depois de uma rodada pesada de trabalho.

> Combine com os *Compressores de token*: primeiro veja **onde** gasta, depois **corte**.`,
    titleEn: "Token usage (Insights)",
    bodyEn: `# Token usage

AI agents burn **tokens** — and tokens cost money. This panel shows **how much** you're spending, **where** and **with which model**, without sending anything out: it's all read **locally** from your machine. Open it under Sidebar → *Token usage*.

## What it shows
- **Grand total** of tokens and **estimated cost** — filter by period (all / today / 7 days / 30 days).
- **By model/LLM** and **by project** — see who eats the most.
- **Trend** — a timeline (metrics-dashboard style) of daily spend.
- **By agent** — for the live agents on the canvas: tokens, cost, session time, **latency** (p95) and per-turn **error rate**.

## Monthly budget (with alert)
Set a **spending cap per project**. As you approach it, the panel **warns** you; past the limit, it **flags** it — your rein so the bill doesn't blow up.

## Re-scan
Use **↻** to recompute after a heavy round of work.

> Pair it with the *Token compressors*: first see **where** it spends, then **cut**.`,
  },
  {
    id: "snippets",
    title: "Central de copia-cola",
    body: `# Central de copia-cola

Um lugar só pra guardar os **trechos que você cola toda hora** — um prompt, um bloco de código, um print. Fica salvo entre sessões e é **seu** (separado da memória dos agentes). Abra em Sidebar → *Central de copia-cola*.

## O que dá pra guardar
- **Texto** e **código** (com a linguagem marcada).
- **Imagem** — cole um print direto da área de transferência; ele vira um arquivo e guarda o caminho.

## Como usar
- **Colar** — 1 clique traz o que está na área de transferência pra dentro da central.
- **Copiar (📋)** — devolve o trecho pra área de transferência.
- **Arrastar** — pegue um snippet e **solte dentro de qualquer nó** (num terminal, por exemplo). Imagem cai como **caminho do arquivo**.
- **Buscar** — filtra por título ou conteúdo na hora.

> Ótimo pra reaproveitar aquele prompt caprichado ou um comando chato de digitar, em qualquer agente.`,
    titleEn: "Copy-paste Central",
    bodyEn: `# Copy-paste Central

One place to keep the **snippets you paste all the time** — a prompt, a code block, a screenshot. Saved across sessions and **yours** (separate from the agents' memory). Open it under Sidebar → *Copy-paste Central*.

## What you can keep
- **Text** and **code** (with the language tagged).
- **Image** — paste a screenshot straight from the clipboard; it becomes a file and stores the path.

## How to use it
- **Paste** — one click brings what's on the clipboard into the central.
- **Copy (📋)** — puts the snippet back on the clipboard.
- **Drag** — grab a snippet and **drop it into any node** (a terminal, say). An image drops as its **file path**.
- **Search** — filters by title or content instantly.

> Great for reusing that well-crafted prompt or an annoying-to-type command, in any agent.`,
  },
  {
    id: "mobile",
    title: "Controle pelo celular",
    body: `# Controle pelo celular

Dá pra acompanhar e **comandar** o OmniRift do **celular** — aprovar uma permissão que um agente pediu, mover cards do Kanban — pela rede local (Wi-Fi) ou pela internet (4G). Abra em Sidebar → *Dispositivos móveis*.

## Instalar o app
O painel mostra um **QR de download** do app Android. Aponte a câmera do celular pra baixar o APK.

## Parear o celular
1. Clique em **parear** — aparece um **QR de pareamento**.
2. No app, escaneie o QR. Pronto: o celular entra na lista de **dispositivos**.
3. O código de pareamento é **secreto** e válido por pouco tempo — pareou, expirou.

## Conceder controle (steering)
Por padrão o celular só **acompanha**. Pra deixá-lo **agir** (aprovar permissões, mover Kanban), ligue o **controle** naquele dispositivo. Você pode **revogar** um aparelho quando quiser.

## O que dá pra fazer do celular
- **Aprovar/negar** um pedido de permissão de um agente.
- **Mover** cards no Kanban.
- Ver a **lista de agentes** e o que está rolando.

> Bom pra quando você sai da frente do PC e um agente para esperando um "pode?".`,
    titleEn: "Control from your phone",
    bodyEn: `# Control from your phone

You can watch and **command** OmniRift from your **phone** — approve a permission an agent asked for, move Kanban cards — over the local network (Wi-Fi) or the internet (4G). Open it under Sidebar → *Mobile devices*.

## Install the app
The panel shows a **download QR** for the Android app. Point the phone camera at it to get the APK.

## Pair the phone
1. Click **pair** — a **pairing QR** appears.
2. In the app, scan the QR. Done: the phone joins the **devices** list.
3. The pairing code is **secret** and short-lived — once paired, it expires.

## Grant control (steering)
By default the phone just **watches**. To let it **act** (approve permissions, move Kanban), turn on **control** for that device. You can **revoke** a device whenever you want.

## What you can do from the phone
- **Approve/deny** an agent's permission request.
- **Move** Kanban cards.
- See the **agent list** and what's going on.

> Handy for when you step away from the PC and an agent stops waiting for a "may I?".`,
  },
  {
    id: "snapshots",
    title: "Salvar e retomar",
    body: `# Salvar e retomar

O OmniRift guarda seu trabalho de **três** formas — e você quase não precisa pensar nisso.

## Snapshots do canvas (automático)
Sidebar → *Snapshots do canvas*. O app **salva o canvas sozinho** de tempos em tempos, e você também pode salvar **na mão**. Cada snapshot é uma **versão** — deu ruim numa reorganização? **Restaure** uma anterior.

## Workspace (salvar o projeto)
Sidebar → *Workspace* → **Salvar** grava o estado do projeto (nodes, paralelos, posições). Ao reabrir, tudo volta como estava — inclusive os agentes reconectados aos seus paralelos.

## Histórico de sessões
Sidebar → *Histórico de sessões* lista as **conversas anteriores** dos agentes. Serve pra **retomar** de onde parou ou consultar o que um agente já tinha feito.

> Regra de ouro: confie no auto-save, mas dê um **Salvar** manual antes de fechar o dia ou mexer em algo grande.`,
    titleEn: "Save and resume",
    bodyEn: `# Save and resume

OmniRift keeps your work in **three** ways — and you barely have to think about it.

## Canvas snapshots (automatic)
Sidebar → *Canvas snapshots*. The app **saves the canvas on its own** every so often, and you can also save **by hand**. Each snapshot is a **version** — a reorganization went wrong? **Restore** an earlier one.

## Workspace (save the project)
Sidebar → *Workspace* → **Save** stores the project state (nodes, parallels, positions). On reopening, everything comes back as it was — including the agents reconnected to their parallels.

## Session history
Sidebar → *Session history* lists the agents' **past conversations**. Use it to **resume** where you left off or review what an agent had already done.

> Golden rule: trust the auto-save, but do a manual **Save** before ending the day or touching something big.`,
  },
  {
    id: "flags",
    title: "Feature flags",
    body: `# Feature flags

Alguns recursos do OmniRift são **novos** ou **experimentais**. As **feature flags** deixam você **ligar e desligar** cada um, só **na sua máquina**. Abra em Sidebar → *Feature flags*.

## Como usar
- Cada recurso tem um **interruptor** e um selo de maturidade: **estável**, **beta** ou **experimental**.
- Ligou/desligou algo que não era o padrão? O painel **mostra** que ali há um ajuste seu (um "override").
- **Resetar** volta uma flag (ou **todas**) pro comportamento padrão.

## Pra que serve
- **Experimentar** um recurso novo antes de virar padrão.
- **Desligar** algo que está atrapalhando (um "kill-switch" pessoal) sem esperar atualização.

## Bom saber
Tudo é **local e reversível** — nada aqui afeta outros usuários, e o padrão sempre volta com um clique.

> Mexa aqui com curiosidade: no pior caso, **Resetar todas** e você está de volta ao padrão.`,
    titleEn: "Feature flags",
    bodyEn: `# Feature flags

Some OmniRift features are **new** or **experimental**. **Feature flags** let you **turn each one on and off**, only **on your machine**. Open it under Sidebar → *Feature flags*.

## How to use it
- Each feature has a **switch** and a maturity badge: **stable**, **beta** or **experimental**.
- Flipped something away from the default? The panel **shows** there's a tweak of yours there (an "override").
- **Reset** returns a flag (or **all** of them) to the default behavior.

## What it's for
- **Try** a new feature before it becomes the default.
- **Turn off** something that's getting in the way (a personal "kill-switch") without waiting for an update.

## Good to know
Everything is **local and reversible** — nothing here affects other users, and the default always comes back with one click.

> Poke around here with curiosity: worst case, **Reset all** and you're back to default.`,
  },
  {
    id: "licenca",
    title: "Beta / Licença",
    body: `# Beta e Licença

O OmniRift **sempre funciona**. O que muda é a edição:

- **Community** (grátis) — roda direto, com alguns limites (ex.: **1 workspace**). Agentes e paralelos são liberados.
- **Full / Pro** — sem limites.

## Período beta (60 dias)
Beta testers ganham **60 dias de acesso completo**. No primeiro uso, o app abre **uma vez** o convite de beta — é só seguir. A verificação é toda **offline** (assinatura no seu dispositivo), então funciona sem internet.

## Ativar uma licença
Você pode ter dois tipos de chave:
- **License key** (\`lic_…\`) — o app troca por um acesso **amarrado a esta máquina** automaticamente.
- **Entitlement** (já no formato \`payload.sig\`) — cole direto pra ativar offline.

Cole a chave na tela de licença → ela é verificada e gravada. Pronto.

## Comprar / continuar Pro
Quando o beta acaba (ou pra liberar tudo), clique em **Ver planos**. Beta testers têm **desconto** — o app já abre a página de planos com o desconto aplicado.

> Dúvida sobre licença? Use o grupo do WhatsApp (tópico *Suporte / Dúvidas*).`,
    titleEn: "Beta / License",
    bodyEn: `# Beta and License

OmniRift **always works**. What changes is the edition:

- **Community** (free) — runs right away, with a few limits (e.g. **1 workspace**). Agents and parallels are unlocked.
- **Full / Pro** — no limits.

## Beta period (60 days)
Beta testers get **60 days of full access**. On first run, the app opens the beta invite **once** — just follow it. Verification is fully **offline** (signature on your device), so it works without internet.

## Activate a license
You may have two kinds of key:
- **License key** (\`lic_…\`) — the app swaps it for access **bound to this machine** automatically.
- **Entitlement** (already in \`payload.sig\` form) — paste it directly to activate offline.

Paste the key on the license screen → it's verified and stored. Done.

## Buy / continue Pro
When the beta ends (or to unlock everything), click **See plans**. Beta testers get a **discount** — the app opens the plans page with the discount already applied.

> Questions about licensing? Use the WhatsApp group (see *Support / Help*).`,
  },
  {
    id: "compressores",
    title: "Compressores de token",
    body: `# Compressores de token

Conversas longas com IA gastam muitos **tokens** (o "combustível" do modelo) e ficam caras/lentas. Um **compressor de token** encolhe o contexto sem perder o essencial — você economiza e o agente fica mais rápido.

## Onde fica
Abra o gerenciador de **Compressores** (ícone do medidor / *Gauge*). Ele lista os compressores conhecidos (ex.: **RTK** e **Headroom**) e mostra se já estão **instalados** na sua máquina.

## Instalar pelo app
- Clique em **instalar** num compressor → o app abre um **terminal no canvas** e roda o comando de instalação pra você.
- Ao terminar, **feche aquele terminal** e clique em **↻** pra o app reconhecer que agora está instalado.
- Marque o compressor como **ativo** pra ele entrar em uso.

## Compressor personalizado (BYO)
Não está na lista? Adicione o seu: dê um **nome** + o **comando de instalação**, salve, e ele passa a aparecer junto dos outros.

> Compressor que não foi detectado fica **desabilitado** até a instalação ser confirmada (o ↻ revalida).`,
    titleEn: "Token compressors",
    bodyEn: `# Token compressors

Long AI conversations burn a lot of **tokens** (the model's "fuel") and get costly/slow. A **token compressor** shrinks the context without losing the essentials — you save money and the agent gets faster.

## Where it is
Open the **Compressors** manager (the gauge icon). It lists the known compressors (e.g. **RTK** and **Headroom**) and shows whether they're already **installed** on your machine.

## Install from the app
- Click **install** on a compressor → the app opens a **terminal on the canvas** and runs the install command for you.
- When it finishes, **close that terminal** and click **↻** so the app sees it's now installed.
- Mark the compressor as **active** to put it to use.

## Custom compressor (BYO)
Not on the list? Add your own: give it a **name** + the **install command**, save, and it shows up alongside the others.

> A compressor that isn't detected stays **disabled** until the install is confirmed (the ↻ revalidates).`,
  },
  {
    id: "atualizacao",
    title: "Atualização automática",
    body: `# Atualização automática

O OmniRift se **atualiza sozinho** — você não precisa baixar instalador de novo. O botão fica no **rodapé da sidebar**.

## Como usar
1. Clique em **buscar atualização** → ele checa se há uma versão nova.
2. Se houver, aparece **"Atualizar para vX.Y"** (passe o mouse pra ler as novidades).
3. Clique e ele **baixa, instala (mostra %) e reinicia o app** sozinho ao terminar.
4. Se você já estiver na última versão, ele só diz **"na última versão"**.

## Bom saber
- Em **build de desenvolvimento** a checagem pode falhar de propósito (build sem assinatura/release) — é normal, sem barulho.
- A atualização é **assinada**, então só instala pacotes oficiais.

> Vale checar de tempos em tempos pra pegar correções e recursos novos.`,
    titleEn: "Automatic updates",
    bodyEn: `# Automatic updates

OmniRift **updates itself** — no need to download an installer again. The button lives in the **sidebar footer**.

## How to use it
1. Click **check for update** → it looks for a new version.
2. If there is one, **"Update to vX.Y"** appears (hover to read what's new).
3. Click it and the app **downloads, installs (shows %) and restarts** itself when done.
4. If you're already on the latest, it simply says **"up to date"**.

## Good to know
- In a **development build** the check may fail on purpose (unsigned build / no release) — that's normal, no noise.
- Updates are **signed**, so only official packages install.

> Worth checking now and then to grab fixes and new features.`,
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
- Notas viram **Lembretes** com prazo (clique no alfinete da nota).
- Arraste um arquivo do *FileTree* pra dentro de um terminal pra **colar o caminho** dele.
- Travou? Mande um **diagnóstico** (tópico *Suporte / Dúvidas*) e cole o código no grupo do WhatsApp.`,
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
- Notes become **Reminders** with a due date (click the pin on the note).
- Drag a file from the *FileTree* into a terminal to **paste its path**.
- Stuck? Send a **diagnostic** (see *Support / Help*) and paste the code in the WhatsApp group.`,
  },
  {
    id: "suporte",
    title: "Suporte / Dúvidas",
    body: `# Suporte / Dúvidas

Travou, achou um bug ou tem uma dúvida? Tem dois caminhos — e eles funcionam **melhor juntos**.

## 1. Grupo do WhatsApp 💬
Tire dúvidas, mande sugestões e fale com outros usuários no nosso grupo.

**Use o botão "Entrar no grupo do WhatsApp" no rodapé desta janela** — ele abre o link no seu navegador (o app não abre links direto na tela por uma limitação técnica do WebKitGTK no Linux).

## 2. Enviar diagnóstico 🐞
Quando algo dá errado, o melhor é mandar um **diagnóstico**: você descreve o problema e o app anexa os **logs técnicos** automaticamente. No fim você recebe um **código** — **cole esse código no grupo** do WhatsApp pra gente achar o seu caso na hora.

### Passo-a-passo
1. Abra **Enviar diagnóstico**.
2. Descreva o que aconteceu (e, se quiser, deixe um contato).
3. Envie → copie o **código** que aparece.
4. Mande sua dúvida no grupo do WhatsApp **com o código**.

> Quanto mais detalhe (o que você fez, o que esperava, o que aconteceu), mais rápido a ajuda chega.`,
    titleEn: "Support / Help",
    bodyEn: `# Support / Help

Stuck, found a bug, or have a question? There are two paths — and they work **best together**.

## 1. WhatsApp group 💬
Ask questions, send suggestions and talk to other users in our group.

**Use the "Join the WhatsApp group" button at the bottom of this window** — it opens the link in your browser (the app can't open links straight from the screen due to a WebKitGTK limitation on Linux).

## 2. Send a diagnostic 🐞
When something breaks, the best move is to send a **diagnostic**: you describe the problem and the app attaches the **technical logs** automatically. At the end you get a **code** — **paste that code in the WhatsApp group** so we can find your case right away.

### Step by step
1. Open **Send diagnostic**.
2. Describe what happened (and, if you like, leave a contact).
3. Send → copy the **code** that appears.
4. Post your question in the WhatsApp group **with the code**.

> The more detail (what you did, what you expected, what happened), the faster help arrives.`,
  },
];
