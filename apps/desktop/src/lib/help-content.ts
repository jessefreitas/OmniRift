// src/lib/help-content.ts
//
// Manual interno do OmniRift — conteúdo bundlado no app (não depende de docs/ no
// disco do cliente). Renderizado pelo HelpModal via renderMarkdown.

export interface HelpTopic {
  id: string;
  title: string;
  /** Markdown. */
  body: string;
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
  },
];
