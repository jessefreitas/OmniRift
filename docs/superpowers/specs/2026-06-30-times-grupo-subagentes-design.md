# Times = Grupo + Subagentes isolados + Blackboard — Design

> **Absorvido pelo Conductor** (2026-07-09, `superseded_by: docs/superpowers/specs/2026-07-09-conductor-design.md`).
> Vira a **camada 2 (Fronteira)** do Conductor. Mantido por histórico.

> Status: **DRAFT / design-first** · 2026-06-30. Derivado de 3 furos reais batidos ao vivo na sessão
> ACP (privacidade, awareness, lifecycle de subagente) — todos a MESMA raiz: o subagente/equipe não
> tem **fronteira**. Não buildar até o desenho estar bom (mesmo princípio do [ACP layer](2026-06-30-acp-agent-layer-design.md)).
> Pré-requisito: a camada ACP (`AgentNode`/`OmniAgent`) e o feature de subagente (`subagent_write` +
> `SubagentNode`) já existem na branch `feat/acp-spike`.

## Problema — 3 furos, 1 raiz

O subagente foi entregue como "escreve um `.claude/agents/<slug>.md` na pasta do pai". Ao usar, três
buracos apareceram em sequência — e os três são o MESMO problema: **não existe fronteira de time; o
subagente é escopado por DIRETÓRIO (não por agente), e o agente em execução não é avisado de nada.**

1. **Privacidade é mentira sem projeto.** O Claude Code escopa subagente por diretório:
   `<cwd>/.claude/agents` + o global `~/.claude/agents`. Sem projeto aberto, o OmniAgent e o
   Orquestrador-terminal rodam no MESMO cwd (`/home/skycracker`) → `code-reviewer.md`, `backend.md`,
   `dba.md` caem todos em `~/.claude/agents` → **qualquer** Claude lê todos. O OmniAgent listou
   `backend`/`dba` (que eram do Orquestrador) porque são globais. O label "privado de \<pai\>" no
   canvas promete uma isolação que o filesystem não dá.
2. **Awareness — o agente não sabe que tem o subagente.** Perguntado "qual o seu subagente?", o
   OmniAgent respondeu "não sou subagent, sou o orquestrador" — não listou o DevOps plugado nele.
3. **Lifecycle — criado ≠ carregado.** O Claude Code lê `.claude/agents` **no início da sessão**. O
   DevOps foi plugado DEPOIS da sessão ACP do OmniAgent abrir; o adapter não faz hot-reload → a
   sessão dele nem sabe que o `devops.md` existe. Pra enxergar/invocar, teria que reabrir a sessão.

**Raiz comum:** a unidade de isolamento do Claude Code é o **diretório**, não o agente. "Subagente
privado de UM agente" só existe se aquele agente tiver um **cwd próprio**. E plugar um subagente
precisa de um **ciclo de vida** (escreve → avisa → carrega), não só escrever um arquivo.

Junto disso, a direção que o Jessé bancou na sessão: **"times de desenvolvimento em grupos"** +
**"coordenação via o pai e a memória compartilhada"**. Subagente do Claude Code é hierárquico
(pai invoca via Task tool, filho devolve pro pai — sem peer-to-peer); a colaboração peer-to-peer é o
modelo de TIME (agentes cheios), e a troca assíncrona é via blackboard (`memory_*`).

## Solução — o Time tem uma fronteira física

**Um Time = um Grupo ligado a um worktree (cwd próprio).** A fronteira do time é um diretório de
verdade — e o OmniRift já tem worktrees git: os **Floors/Parallels** (Fase 6, `floors/`). Daí saem
as três isolações de graça:

| Eixo | Onde vive a fronteira |
|------|------------------------|
| **Subagentes privados** | `<worktree-do-time>/.claude/agents/` — só os agentes daquele time leem |
| **Blackboard do time** | namespace de memória = id do grupo/time (`memory_*` escopado) |
| **Roster do orquestrador** | `terminal_list` filtra pelos membros do grupo, não global |

### A. Time = Grupo + worktree (a peça nova)

- O **GroupNode** (já existe, `kind:"group"`, membros via `parentId`) ganha um modo **"time"**: ao
  virar time, o grupo é **bindado a um worktree** (reusa a infra de floors — branch + cwd dedicados,
  ou o cwd do floor onde o grupo vive).
- **Todo agente membro do time herda o cwd do time** no spawn (terminais e OmniAgents). É isso que dá
  a isolação: o `.claude/agents` daquele cwd é privado ao time.
- Dois times isolados = dois grupos com worktrees distintos. Um time só = um grupo = um cwd.
- **Decisão D1 (a travar):** o time é (a) **um Grupo com worktree dedicado** (mais granular, vários
  times por floor) ou (b) **o próprio Floor/Parallel** (mais simples, 1 floor = 1 time, reusa 100% a
  infra de worktree existente)? Recomendação: **começar por (b)** — Floor já É worktree, zero infra
  nova; o Grupo entra como sub-organização visual + namespace de blackboard dentro do floor. Migrar
  pra (a) depois se precisar de multi-time por floor.

### B. Lifecycle do subagente (resolve awareness + carregamento)

Plugar um subagente vira um ciclo, não um write solto:

1. **Escreve** `<cwd-do-time>/.claude/agents/<slug>.md` (já temos `subagent_write`; passa a SEMPRE
   exigir um cwd de time — nunca cai no global silenciosamente).
2. **Avisa o agente pai** (in-context, de graça — entra na awareness do AgentNode, igual o roster):
   "🔌 Subagente DevOps plugado (`.claude/agents/devops.md`). Invocável via Task tool após recarregar."
3. **Carrega.** O Claude Code só lê `.claude/agents` no boot da sessão. Opções:
   - **Reload explícito** — botão "↻ recarregar subagentes" no AgentNode → re-spawna a sessão ACP
     (perde a conversa atual; avisa antes). Limpo e previsível.
   - **Reload preservando contexto** — re-spawn com `session/load` (o handshake do Codex anuncia
     `loadSession:true`; o do Claude tem `sessionCapabilities`) injetando um resumo. Investigar.
   - **Agentes NOVOS** já nascem com os subagentes do cwd → o problema é só o agente JÁ aberto.
   - **Decisão D2:** reload explícito (v1) vs preservar-contexto (v2). Recomendação: **explícito v1**
     com aviso claro; o agente novo nasce certo, o já-aberto pede 1 clique pra recarregar.

### C. Blackboard por time (coordenação via memória)

- As tools `memory_remember`/`memory_recall` (LocalProvider SQLite, `memory/`) ganham um **escopo**
  por id de time (namespace). Cada time tem seu "mural"; não vaza pro outro.
- O agente-pai e os membros leem/escrevem o mural do time → trocam info **assíncrona** sem dump de
  contexto e sem peer-to-peer direto (que o Claude Code não faz).
- **Decisão D3:** o namespace é o id do grupo/floor, injetado nas tools `memory_*` via o
  `agent_mcp_config` por membro (cada agente do time nasce apontando pro mesmo namespace).

### D. Orquestrador escopado aos membros do time

- `terminal_list` (e o `CanvasAgentsMirror`/`AgentRegistry`) passa a **filtrar pelo grupo/floor** do
  orquestrador que pergunta → resolve o princípio do Jessé "cada agente vê só os SEUS" (subtree =
  grupo). Hoje é global (todo orquestrador vê todo mundo marcado).
- O contrato do orquestrador deixa de ser despejado no PTY (já matamos isso); o roster do time é
  consultável (`terminal_list`) + injetado lazy (awareness, já feito em `db3b6c0`).

## Arquitetura — arquivos tocados (estimativa)

- **`src-tauri/src/floors/`** (ou `parallels`): expor o cwd/worktree do time pra resolução de spawn.
- **`commands/agent_docs.rs`** (`subagent_write`): exigir `team_cwd`; remover o fallback global
  silencioso (ou marcá-lo explicitamente "global" no retorno).
- **`mcp/registry.rs` + `commands/mcp.rs`** (`canvas_agents_set`/`terminal_list`): filtro por grupo.
- **`memory/`** (`MemoryProvider`/`memory_remember`/`recall`): parâmetro `namespace` por time.
- **`commands/mcp.rs` (`agent_mcp_config`)**: injetar o namespace do time por membro.
- **Front `store/canvas-store.ts`**: `addAgent`/`addTerminal`/`addSubagent` herdam o cwd do
  grupo/floor; `GroupNode` ganha flag "time" + binding de worktree.
- **`components/nodes/GroupNode.tsx`**: UI de "time" (nome, membros, blackboard, worktree).
- **`components/nodes/AgentNode.tsx` + `TerminalNode.tsx`**: botão "↻ recarregar subagentes" +
  awareness "🔌 subagente plugado".
- **`components/nodes/SubagentNode.tsx`**: escopo honesto ("time X" vs "global") em vez de "privado".

## Faseamento

- **Fase 0 (stopgap, 2 min, independente):** `SubagentNode` mostra o escopo REAL ("global · visível a
  todos" vs "time/projeto X") — mata o label enganoso enquanto o resto é desenhado.
- **Fase 1:** Time = Floor (D1-b). Membros herdam o cwd do floor → subagentes isolados por floor de
  verdade. `subagent_write` exige cwd de time.
- **Fase 2:** Lifecycle (D2): aviso in-context + botão reload no AgentNode/TerminalNode.
- **Fase 3:** Blackboard namespaceado por time (D3) + `terminal_list` escopado ao grupo (D).
- **Fase 4 (opcional):** Grupo-com-worktree-dedicado (D1-a) pra multi-time por floor.

## Fora de escopo / não-objetivos

- Peer-to-peer direto entre subagentes (não existe no Claude Code; usar pai ou blackboard).
- Hot-reload de `.claude/agents` no adapter (não temos controle; resolvemos com reload de sessão).
- Codex: subagente é recurso do Claude Code (`.claude/agents`); Codex tem outro mecanismo — depois.

## Riscos

- **Reload de sessão perde conversa** (D2-v1) — mitigar com aviso + investigar `session/load` (v2).
- **Migração de subagentes globais já criados** — ao adotar cwd de time, os `.md` em `~/.claude/agents`
  ficam órfãos; oferecer "mover pro time" ou deixar como globais explícitos.
- **Floor sem worktree** (floors locais sem git) — definir o cwd fallback do time.

## Decisões a travar (Jessé revisa)

- **D1:** Time = Floor (recomendado v1) ou Grupo-com-worktree-dedicado?
- **D2:** Reload de subagente = explícito (recomendado v1) ou preservando contexto?
- **D3:** Namespace do blackboard = id do grupo ou do floor?
- **D4:** Fazer a Fase 0 (stopgap do label) já, em paralelo ao desenho?
