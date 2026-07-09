---
status: active
title: Orquestrador — sistema unificado de orquestração e comunicação inter-agente
date: 2026-07-09
supersedes:
  - docs/superpowers/specs/2026-06-16-spec-lifecycle-e-orquestracao-design.md
  - docs/superpowers/specs/2026-06-30-times-grupo-subagentes-design.md
---

# Orquestrador — Design

**Goal:** unificar sob um nome só — **Orquestrador** — tudo que o OmniRift já tem de orquestração
(Orquestrador coroado, teto/aprovação/ondas, Times = Floor + blackboard) **mais** a camada que
faltava: **comunicação ativa peer-a-peer entre agentes** (perguntar, avisar, negociar). Hoje a
coordenação é *passiva* — um agente posta um claim no blackboard, outro lê. Orquestrador adiciona o
tecido *conversacional*: A pergunta a B o que ele está fazendo, B responde; B avisa A que terminou;
B esbarra num recurso de A e **negocia** em vez de recuar mudo.

**Por que agora:** o substrato de coordenação existe (`claim_*`, `terminal_*`, blackboard `memory_*`,
`orchestration_send`, teto de agentes, roster escopado por time), mas não há canal para um agente
**perguntar** algo a outro e **receber a resposta correlacionada**. O mais próximo (`do_send_task`) é
orquestrador→agente e grosseiro (devolve o scrollback até idle). Falta o canal peer com correlação.

**Origem:** absorve e supersede os designs de orquestração de 2026-06-16 (ciclo de vida + Bloco D/E)
e 2026-06-30 (Times = Grupo + worktree + blackboard). A camada 4 (comunicação ativa) e o
faseamento 5/6/7 nasceram na sessão de brainstorming de 2026-07-09.

---

## Princípios

- **Turn-based é a lei física.** Agente LLM num PTY não é daemon: só "ouve" quando tem a vez de ler
  input. Isso define a arquitetura — comunicação síncrona (pull) encaixa no modelo de tool-call;
  push é entregue mas só visto no próximo turno do destinatário; pub/sub reativo não existe de graça.
- **Uma superfície por intenção.** `agent_status` (barato, não toca no alvo) vs `agent_ask`
  (interrompe, resposta real) vs `agent_tell` (avisa, fire-and-forget). O agente escolhe pela
  ferramenta — zero classificador mágico no meio.
- **Correlação por id.** Toda pergunta carrega um `id`; a resposta casa por esse `id`. A recebe
  exatamente a resposta de B, nunca o scrollback bruto.
- **Isolamento forte = Floor.** Time = Floor = worktree. Agentes em floors distintos mexem em
  *cópias* — colisão só no merge. É a única garantia *dura* contra corrupção de dados.
- **Claim é advisory; negociação é a rede de segurança.** Fora de floors isolados, claim protege
  agente disciplinado. Ao esbarrar, o agente **pergunta ao dono** em vez de recuar cego. Lock duro
  (FS guard) é camada 6, opcional e tardia.
- **Humano no controle do fan-out.** Orquestrador propõe e **pergunta** antes de spawnar; teto
  rígido como backstop. (Herdado do Bloco D de 06-16.)
- **Nada destrutivo automático.** Arquivar ≠ deletar; reload avisa antes de perder conversa.

---

## Arquitetura — 7 camadas

```
                         ORQUESTRADOR
  ┌──────────────────────────────────────────────────────────┐
  │ 1. HIERARQUIA   Orquestrador 👑 → membros                 │  ✅ existe (v0.1.103)
  │    teto (max 5) · aprovação do usuário · ondas            │
  ├──────────────────────────────────────────────────────────┤
  │ 2. FRONTEIRA    Time = Floor/worktree (cwd próprio)       │  🔶 desenhado (06-30)
  │    blackboard namespaceado · roster escopado ao time      │
  ├──────────────────────────────────────────────────────────┤
  │ 3. COORD. PASSIVA  claim_acquire/check · decisões no      │  🔶 contrato (06-16 Bloco E)
  │    blackboard · overlap por `paths:`                      │
  ├──────────────────────────────────────────────────────────┤
  │ 4. COMUNICAÇÃO ATIVA ⭐  agent_status · agent_ask ·        │  📋 NOVO (esta sessão)
  │    agent_tell  via protocolo de marcador + preâmbulo      │     — foundation, tudo reusa
  │    negociação por claim (esbarrou → pergunta ao dono)     │
  ├──────────────────────────────────────────────────────────┤
  │ 5. BARRAMENTO   pub/sub leve (tag no blackboard, já dá) + │  ⏳ fase 2
  │    entrega ativa via marcador (camada 4)                  │
  ├──────────────────────────────────────────────────────────┤
  │ 6. ENFORCEMENT DURO  FS guard (fanotify/fuse) — hard-lock │  ⏳ fase 3 (caro, tardio)
  ├──────────────────────────────────────────────────────────┤
  │ 7. MONITOR PASSIVO (OmniPartner)  lê AgentStatusEvent →   │  ⏳ paralelo ao 4
  │    notifica o HUMANO quando agente termina/bloqueia       │
  └──────────────────────────────────────────────────────────┘

  Ordem de construção:  4  →  (5, 7)  →  6
  (4 é a base: o mecanismo de marcador + correlação é reusado por 5, 6, 7.)
```

---

## Camada 4 — Comunicação ativa (o núcleo novo)

O coração do Orquestrador. Três ferramentas MCP novas em `mcp/tools.rs`, no padrão existente
(`terminal_*`, `orchestration_*`, `claim_*`), roteadas pelo MCP server embutido (`mcp/server.rs`,
SSE + JSON-RPC 2.0, já injetado em todo agente pelo `agent_mcp_config`).

### 4.1 As três ferramentas

| Tool | Intenção | Toca no alvo? | Retorno |
|---|---|---|---|
| `agent_status(target)` | "o que B está fazendo?" (barato) | **não** | síntese: `AgentState` + resumo do output recente + última nota de B no blackboard |
| `agent_ask(target, question)` | pergunta real, espera resposta | **sim** (interrompe) | resposta limpa de B, correlacionada; ou timeout |
| `agent_tell(target, message)` | avisa B de algo (fire-and-forget) | injeta (não bloqueia) | `ok` — B vê no próximo turno |

- `target` = label/role/sid, resolvido pelo `AgentRegistry` (mesma resolução do `orchestration_send`;
  aceita `@label`/`@role`).
- **`agent_status` NÃO gasta turno de ninguém**: lê `AgentState` (`pty/detector.rs`:
  Idle/Working/Blocked/Done/Dead) + tail do output do PTY + `memory_recall` da última nota de B.
  Resposta rasa mas instantânea. É o default para "o que está fazendo".
- **`agent_ask` gasta um turno de B** — usado sob demanda, para perguntas que só B sabe responder
  ("como você resolveu X?", "me passa o resultado").
- **`agent_tell`** reusa a plumbing do `agent_ask` sem o bloqueio-por-reply. Cobre "B avisa A que
  terminou" (o push dirigido). Custo: injeta texto não-solicitado no contexto de A — aceitável,
  controlado por quem envia.

### 4.2 Protocolo de marcador (a parte difícil)

Problema: injetar texto cru no PTY de B vira ruído que B pode tratar como tarefa, e não há como
casar a resposta. Solução — **marcador + preâmbulo de role**:

**`agent_ask` (síncrono, bloqueia):**
```
control plane → injeta no PTY de B:
    [[OMNIRIFT-ASK from=@A id=<uuid>]] <pergunta>
B (role-primed) responde numa linha própria:
    [[OMNIRIFT-REPLY id=<uuid>]] <resposta>
control plane → leitor de PTY casa o REPLY pelo <uuid>, extrai só a resposta,
                desbloqueia o agent_ask de A com esse texto.
```

**`agent_tell` (fire-and-forget):**
```
control plane → injeta no PTY de B:
    [[OMNIRIFT-MSG from=@A]] <mensagem>
não espera reply; devolve `ok` imediatamente a A. B lê no próximo turno.
```

- **Correlação:** `uuid` por `agent_ask`. O `agent_ask` de A é uma chamada MCP que **bloqueia
  assíncrono** (reusa o padrão de `do_send_task` em `mcp/server.rs`, que já bloqueia-até-resultado)
  até o REPLY casar ou estourar timeout.
- **Timeout:** default configurável (ex.: 90s). Ao estourar → devolve
  `"sem resposta (timeout) · estado de B = Working"`. **Nunca** trava A para sempre.
- **Parsing:** o leitor de PTY (o mesmo loop que alimenta `AgentState`/scrollback em
  `pty/session.rs`) ganha um matcher dos marcadores `[[OMNIRIFT-*]]`. Um único regex por linha;
  extrai `id` e payload. Marcadores nunca são renderizados como saída "normal" (filtrados do que o
  xterm mostra, ou marcados como meta).

### 4.3 Preâmbulo de role (etiqueta injetada)

Todo agente nasce sabendo o protocolo. Injetado no spawn pelo **mesmo caminho do `agent_mcp_config`**
(`commands/mcp.rs`) que já injeta Serena/memória. Bloco de texto curto no system prompt/role:

```
Você participa do Orquestrador. Outros agentes podem falar com você:
- Ao ver `[[OMNIRIFT-ASK from=@X id=N]] <pergunta>`: responda em UMA linha
  `[[OMNIRIFT-REPLY id=N]] <resposta curta>` e volte ao que fazia.
- `[[OMNIRIFT-MSG from=@X]] <aviso>` é informação; incorpore e siga.
- ANTES de editar um arquivo: `claim_check`. Se estiver travado por outro agente,
  use `agent_ask(dono, "preciso de <arquivo> — libera ou espero?")` e respeite a resposta.
```

Custo consciente: o preâmbulo consome um pouco do contexto inicial de cada agente. Aceito — é o preço
de agentes "Orquestrador-aware" por padrão.

### 4.4 Negociação por claim (liga camada 3 ↔ 4)

Não é ferramenta nova — é a **etiqueta do preâmbulo** + `claim_*` (existe) + `agent_ask` (novo):

```
B vai editar auth.rs
  → claim_check(auth.rs) → A tem o claim
  → em vez de recuar mudo: agent_ask(A, "preciso do auth.rs — libera ou espero?")
  → A responde ("libero" / "espera 5min, tô no meio do struct" / "faz você, já commitei")
  → resolvem sem colidir
Se A e B estão em Floors separados: worktree já isolou — nem chega aqui.
```

É aqui que a comunicação **ganha o valor real**: transforma o bloqueio silencioso do claim advisory
numa conversa que resolve.

---

## Camadas 1–3 — o que já existe (absorvido das specs antigas)

Estas camadas vêm dos designs de 06-16 e 06-30 (agora supersedidos por este). Resumo do contrato que
o Orquestrador mantém; o detalhe fica no histórico git dos arquivos originais.

### Camada 1 — Hierarquia (✅ existe, v0.1.103)
- **Orquestrador** = líder promovido (coroa 👑, dock), persona de comando: divide/aciona/cobra/integra
  via Kanban + blackboard + `agent_wake`/`agent_sleep`. Membros seguem "membro focado".
- **Teto rígido** `maxConcurrentAgents` (default 5, faixa 1–8): `terminal_spawn`/`_on_floor` contam
  agentes ativos via `AgentRegistry` e **recusam** acima do teto (erro legível). Backstop no código.
- **Aprovação + ondas:** o Orquestrador propõe (quantos/quais papéis/quais floors), **pergunta e
  espera** confirmação, e roda em ondas se a spec precisa de mais que o teto.

### Camada 2 — Fronteira (🔶 desenhado, 06-30)
- **Time = Floor = worktree** (cwd próprio). Todo membro herda o cwd do time no spawn → o
  `.claude/agents` daquele cwd é privado ao time (resolve a "privacidade é mentira sem projeto").
- **Blackboard namespaceado** por id de time (`memory_*` recebe `namespace` via `agent_mcp_config`
  por membro).
- **Roster escopado:** `terminal_list` filtra pelos membros do grupo/floor, não global.
- **Decisão D1 (mantida):** começar por Time = Floor (reusa 100% a infra de worktree); Grupo com
  worktree dedicado (multi-time por floor) fica para depois.
- **Lifecycle de subagente** (D2): escreve → avisa o pai in-context → reload explícito v1 (re-spawn
  da sessão ACP, avisa antes; agente novo já nasce certo).

### Camada 3 — Coordenação passiva (🔶 contrato, 06-16 Bloco E)
- **Claims:** `claim_acquire`/`claim_check`/`claim_release` (`mcp/claims.rs`, blackboard de arquivos).
  Advisory — protege quem checa. A camada 4 adiciona a negociação quando o claim colide.
- **Decisões compartilhadas:** convenções duráveis viram fatos no blackboard (`memory_remember`) pra
  não reinventar entre specs.
- **Detecção de sobreposição:** frontmatter `paths:` (globs). Duas specs ativas com paths que se
  cruzam → UI/Orquestrador avisa antes do dispatch.

### Spec lifecycle (absorvido de 06-16, Blocos A/B/C)
- Status de spec derivado (frontmatter → checkboxes 100% → pasta archive → active); `spec_archive`;
  raízes de spec configuráveis; "Nova/Importar"; "Enviar ao Orquestrador". Mantido como está.

---

## Camada 5 — Barramento (⏳ fase 2)

- **Versão leve JÁ EXISTE:** o blackboard (`memory_remember`/`recall` por tag) é um quadro
  compartilhado — B grava `tag=auth "pronto"`, quem se importa faz `memory_recall(tag=auth)`. Cobre
  "anúncio pra quem interessa" sem infra nova. **Recomendação: use isso primeiro.**
- **Versão ativa (a construir):** entrega push a inscritos reusa o marcador `[[OMNIRIFT-MSG]]` da
  camada 4 — inscrição num tópico → quando alguém publica, o control plane injeta o MSG no PTY de
  cada inscrito. Depende inteiramente da camada 4 estar sólida.
- **Contrato que a camada 4 deve expor pra 5 plugar:** função interna `deliver_msg(target, payload)`
  (o injetor de `[[OMNIRIFT-MSG]]`) reutilizável por um dispatcher de tópicos.
- YAGNI até haver cenário real com N agentes onde `recall` por tag não serve.

---

## Camada 6 — Enforcement duro (⏳ fase 3, caro, tardio)

- **Objetivo:** barrar *fisicamente* um `echo > auth.rs` no shell de um agente rebelde que ignora o
  claim advisory.
- **Custo real:** exige guard no nível de filesystem (fanotify/inotify + política, ou fuse
  overlay, ou rotear toda escrita por uma tool). Inviável interceptar shell arbitrário sem infra de
  SO.
- **Por que por último:** o Floor (worktree isolado, camada 2) já é a garantia dura contra colisão —
  resolve o "agente rebelde" melhor que um lock. Só construir 6 se aparecer um caso concreto onde
  agentes precisam compartilhar o MESMO working copy E não dá pra confiar no contrato. **Provável
  never.** Documentado para não ser reinventado.

---

## Camada 7 — Monitor passivo / OmniPartner (⏳ paralelo à 4)

- O "avisa quando acabar" que o Jessé quer **não** pertence à camada agente↔agente (destinatário é o
  humano, não outro agente turn-based). Pertence ao **monitor**.
- Consome os `AgentStatusEvent` que o backend **já emite** (`pty/detector.rs`:
  Working/Blocked/Done/Dead) → notifica **você** na UI (toast/badge/som) quando um agente termina ou
  bloqueia. Pode responder "o que o Codex está fazendo?" reusando `agent_status` (camada 4).
- Alta alavancagem de UX, baixo backend novo (o evento existe; falta surfaçar). Sai em paralelo à
  camada 4 assim que `agent_status` existir.
- Cruzar escopo com `2026-06-28-omnipartner-aprender-design.md` (o OmniPartner já tem spec própria na
  vertente "Aprender"; o monitor passivo é a vertente "vigia").

---

## Faseamento

Ordem por dependência e valor. Cada fase é um PR/floor próprio.

1. **Fase 4a — núcleo pull:** `agent_status` + `agent_ask` + protocolo de marcador (ASK/REPLY) +
   correlação por uuid + timeout + preâmbulo de role. *Entrega o valor central sozinha: agentes
   conversam.* Base de tudo.
2. **Fase 4b — push + negociação:** `agent_tell` (`[[OMNIRIFT-MSG]]`, fire-and-forget) + etiqueta de
   negociação por claim no preâmbulo. Barato sobre 4a.
3. **Fase 7 — monitor passivo** (paralelo a 4b): `AgentStatusEvent` → notificação na UI + "o que X
   está fazendo?" via `agent_status`.
4. **Fase 5 — barramento ativo:** dispatcher de tópicos sobre `deliver_msg`. Só se `recall` por tag
   não bastar.
5. **Fase 6 — FS guard:** hard-lock. Só sob cenário concreto. Provável never.

Camadas 1–3 já existem/estão desenhadas; o trabalho novo começa na Fase 4a.

---

## Arquivos tocados (estimativa)

- **`mcp/tools.rs`** — definição + handler das 3 tools novas (`agent_status`/`agent_ask`/`agent_tell`).
- **`mcp/server.rs`** — bloqueio-por-reply do `agent_ask` (reusa padrão `do_send_task`); registro.
- **`pty/session.rs`** (ou `detector.rs`) — matcher dos marcadores `[[OMNIRIFT-*]]` no read-loop;
  filtro pra não renderizar marcador como saída normal.
- **`commands/mcp.rs` (`agent_mcp_config`)** — injetar o preâmbulo de role Orquestrador no spawn.
- **`mcp/registry.rs`** — resolução de `target` (label/role/sid), se ainda não coberta pelo
  `orchestration_send`.
- **(Fase 7)** `metrics`/front — consumir `AgentStatusEvent` → notificação UI.
- **Front** — opcional: indicador visual de "A ↔ B conversando" no canvas (corda ativa), reusando
  `pipe_list`.

---

## Testes

- **Unit:** parsing dos marcadores ASK/REPLY/MSG; correlação por `id` (reply certo casa, reply de
  outro `id` é ignorado); timeout devolve a mensagem certa; resolução de `target`.
- **Integração (agentes reais):** spawn de 2 agentes; A faz `agent_ask(B, …)` → recebe REPLY
  correlacionado; `agent_status(B)` retorna estado sem tocar em B (B não ganha turno); `agent_tell`
  entrega e B vê no próximo turno; fluxo de negociação: A trava `x`, B faz `claim_check` → `agent_ask`
  → A responde → sem colisão.
- **Regression guard:** rodar TODA a suíte (tsc + cargo check + testes) — a camada 4 mexe no read-loop
  do PTY, que é caminho crítico; não regredir scrollback/AgentState/pipes existentes.

---

## Riscos / decisões abertas

- **Marcador no output do agente por engano** — se um agente imprimir `[[OMNIRIFT-REPLY id=…]]` fora
  de contexto (ex.: ecoando a instrução), pode casar falso. Mitigar: `id` é uuid (colisão improvável)
  + o matcher só aceita REPLY com `id` de um ASK *pendente*.
- **Interrupt derailla B** — injetar ASK no meio de uma tarefa de B pode confundir B. Mitigar: o
  preâmbulo instrui "responda curto e VOLTE ao que fazia"; e `agent_status` (não-intrusivo) é o
  default para a maioria das perguntas. Reavaliar se na prática B se perde.
- **Preâmbulo consome contexto** — bloco de etiqueta em todo agente. Manter curto; medir impacto.
- **Timeout vs tarefa longa** — B legitimamente ocupado pode estourar o timeout do `agent_ask`.
  Retorno inclui o `AgentState` pra A decidir (esperar/repetir/seguir). Timeout configurável.
- **Claims advisory** (herdado) — não travam de verdade; confiam no contrato. Floor é a garantia dura;
  FS guard (camada 6) é o lock duro opcional e provavelmente desnecessário.
- **Nome "Orquestrador"** — nome guarda-chuva do sistema; não há artefato antigo literal com esse nome
  (o código usa "Orquestrador"). Decidir se renomeia a persona/UI para Orquestrador ou mantém
  "Orquestrador" no código e "Orquestrador" só como nome do sistema/produto.

---

## Specs absorvidas (supersedidas por esta)

- `2026-06-16-spec-lifecycle-e-orquestracao-design.md` — camadas 1, 3 + spec lifecycle.
- `2026-06-30-times-grupo-subagentes-design.md` — camada 2 (Times = Floor + blackboard namespaceado).

Ambas mantidas no repo por histórico; frontmatter marcado `superseded_by: 2026-07-09-orquestracao-design.md`.
