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

Tem duas formas de fazer um agente "falar" com outro:

## 1. Pipe visual (saída de A → entrada de B)
Arraste a partir das **alças laterais** de um terminal até outro terminal. A **saída** do agente A passa a entrar como **entrada** no agente B. Ótimo pra **encadear etapas** (ex.: A gera o plano, B executa).

## 2. Dispatch pelo Orquestrador (MCP)
O Orquestrador usa as ferramentas \`omnirift-agents\` pra **mandar uma tarefa** a um agente e **esperar o resultado**. Pra um agente ficar visível pro Orquestrador, registre-o em *MCP Agents* na sidebar.

## Passo-a-passo do dispatch
1. Registre os agentes "trabalhadores" em *MCP Agents*.
2. Peça ao Orquestrador algo como "delegue X pro agente Backend".
3. Ele escreve a tarefa no terminal do agente e **dá Enter** automaticamente.

> Se um agente receber a tarefa mas não começar, confira se ele não está **parado num prompt de permissão** (esperando você confirmar algo). Resolva o prompt e ele segue.`,
    titleEn: "Connections between agents",
    bodyEn: `# Connections and dispatch

There are two ways to make one agent "talk" to another:

## 1. Visual pipe (A's output → B's input)
Drag from a terminal's **side handles** to another terminal. Agent A's **output** becomes agent B's **input**. Great for **chaining steps** (e.g. A writes the plan, B runs it).

## 2. Dispatch via the Orchestrator (MCP)
The Orchestrator uses the \`omnirift-agents\` tools to **send a task** to an agent and **wait for the result**. For an agent to be visible to the Orchestrator, register it under *MCP Agents* in the sidebar.

## Dispatch step by step
1. Register the "worker" agents under *MCP Agents*.
2. Ask the Orchestrator something like "delegate X to the Backend agent".
3. It writes the task into the agent's terminal and **presses Enter** automatically.

> If an agent receives the task but doesn't start, check it isn't **stuck on a permission prompt** (waiting for you to confirm something). Clear the prompt and it carries on.`,
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
