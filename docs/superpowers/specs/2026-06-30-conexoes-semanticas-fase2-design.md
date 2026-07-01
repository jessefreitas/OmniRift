# Conexões Semânticas (Fase 2 do ACP) — Design

> Status: **DRAFT / design-first** · 2026-06-30. O payoff central da aposta ACP: a linha deixa de
> passar **texto cru** e passa a carregar **estrutura** (diff, resultado tipado, artefato), com
> **review/gate** e **roteamento por conteúdo**. Alvo: **próxima release**. Não buildar até o desenho
> estar bom (mesmo princípio do [ACP layer](2026-06-30-acp-agent-layer-design.md) e do
> [Times=Grupo](2026-06-30-times-grupo-subagentes-design.md)).

## Problema — a linha é burra, mas o agente já é estruturado

Hoje a linha entre nós carrega **texto**:
- **Pipe PTY** (terminal→terminal): stdout cru → stdin.
- **Cano de chat** (agente→agente, `generic`): a resposta do turno vira prompt do próximo.
- **Comando** (OmniAgent→terminal, `agent-link`): via `terminal_send_text` (MCP).

Mas o OmniAgent (ACP) **já emite estrutura** — o `acp://update` traz `tool_call` com `content`
(incluindo **diff** de edições), `locations`, `rawInput`, `status`; além de `plan` e `result`. O
`AgentNode.applyUpdate` (`components/nodes/AgentNode.tsx:190`) hoje **extrai só** `title`/`kind`/
`status` e **joga o resto fora**. E o `DiffViewerModal` (`components/DiffViewerModal.tsx`) já sabe
renderizar diff. Ou seja: **a estrutura já chega e já dá pra mostrar — só não flui pela linha.**

A promessa da Fase 2 do ACP (registrada em [[acp-agent-layer-bet]]): "estruturado destrava Conexões
Fase 2 (semânticas) + review de diff + gating de permissão". É isso que falta codar.

## Solução — 3 capacidades sobre a linha

### A. Payload estruturado na linha (não só texto)

A saída de um agente passa a ter **tipo**: `text` | `diff` | `result` | `artifact`.
- O `AgentNode.applyUpdate` **captura** o `tool_call.content` (diff, path, rawInput) além do título.
- Ao fim do turno (ou por tool-call), publica no store um **payload tipado** (não só `agentOutputs.text`):
  `agentOutputs[nodeId] = { kind: "diff"|"result"|"text", text, diff?, path?, meta?, seq }`.
- O `useConnectionRouting` roteia o **payload** (não só o texto): destino agente → recebe como
  contexto tipado; destino nó de review → segura; destino terminal → serializa pra texto (fallback).
- A **edge** ganha um badge do que está passando (📄 diff, ✅ result) — a "conexão semântica" fica
  legível no canvas.

### B. Review / gate na linha (aprovar antes de fluir)

Um **nó novo `ReviewNode`** (ou um modo da edge) que fica **entre** dois agentes e **segura** o payload:
- Recebe um `diff`/`result` → mostra no **DiffViewerModal** (reuso) dentro do nó.
- Botões **Aprovar / Rejeitar / Editar** → só flui pro próximo nó se aprovado.
- Enquanto pendente, a edge fica **amarela/pulsando** (estado `review`); aprovado → verde flui;
  rejeitado → vermelho, não passa.
- Isso é o "gating de permissão visual" que o ACP prometeu: *"o agente quer editar X, aprova?"* — só
  que na **linha**, entre produtor e consumidor.

### C. Roteamento por conteúdo (a linha decide o que passa)

Uma edge (ou um **`FilterNode`**) com uma **condição**: só deixa passar o que casa.
- Condição simples v1: por **tipo** (`só diff`, `só result`), por **regex no texto**, ou por **path**
  (ex: só edições em `src/**`).
- Futuro: transformação (map) — a edge reescreve o payload antes de passar.

## Arquitetura — arquivos tocados

- **`components/nodes/AgentNode.tsx`** (`applyUpdate`): capturar `up.content`/`locations`/`rawInput`
  do `tool_call`; acumular o diff do turno; publicar payload tipado.
- **`store/canvas-store.ts`**: `agentOutputs` vira `{ kind, text, diff?, path?, meta?, seq }`;
  `emitAgentOutput` aceita o payload. Novo `edgePayloadKind` p/ o badge.
- **`hooks/useConnectionRouting.ts`**: rotear o payload tipado (não só `out.text`); tratar destino
  `review` (segura) vs `agent`/`terminal` (flui/serializa).
- **`components/nodes/ReviewNode.tsx` (NOVO)**: nó de review — reusa `DiffLines` do
  `DiffViewerModal`; Aprovar/Rejeitar; publica o payload aprovado adiante.
- **`components/nodes/FilterNode.tsx` (NOVO, Fase 2c)**: condição de passagem.
- **`components/edges/FlowEdge.tsx`**: badge do payload (📄/✅) + estado `review` (amarelo).
- **`types/canvas.ts`**: `NodeKind += "review" | "filter"`; edge kind `semantic`.
- **Backend `acp/mod.rs`**: nada novo — o `acp://update` já traz `content`/`diff` (só o front descarta).

## Faseamento (rumo à próxima release)

- **Fase 2a — Payload estruturado (diff):** capturar o diff do `tool_call`, publicar tipado, badge na
  edge, roteamento do payload. **Entregável mínimo com valor:** ver "passou um diff" na linha.
- **Fase 2b — ReviewNode (gate):** nó de review entre agentes, Aprovar/Rejeitar com DiffViewer,
  estado `review` na edge. **É o grande diferencial** (nenhum concorrente tem review-na-linha visual).
- **Fase 2c — FilterNode (roteamento por conteúdo):** condição de passagem por tipo/regex/path.

## Não-objetivos / fora de escopo

- Merge/apply automático do diff no disco (o ReviewNode mostra + aprova; **quem aplica é o agente
  consumidor**, não a linha — a linha não escreve arquivo).
- Transformação complexa (só filtro v1; map fica pra depois).
- Fluxo estruturado a partir de **terminais PTY** (bytes cegos) — só de **OmniAgents** (ACP). Terminal
  segue no texto (fallback de serialização).

## Decisões a travar (Jessé revisa)

- **D1:** Review é um **nó novo** (`ReviewNode` na linha) ou um **modo da edge** (clica na linha →
  painel)? Recomendação: **nó** (visível, arrastável, reusa o padrão de nós).
- **D2:** O payload tipado **substitui** `agentOutputs.text` (migração) ou é **campo novo** ao lado?
  Recomendação: **campo novo** (`kind`+`diff?`) mantendo `text` (back-compat, zero regressão).
- **D3:** Fase 2a sozinha já entra na próxima release, ou espera a 2b (review) pra ter valor visível?
  Recomendação: **2a + 2b juntas** — payload sem review é pouco; review é o diferencial.
- **D4:** O ReviewNode aprova e **encaminha** o payload adiante (fluxo) ou só **audita** (read-only)?
  Recomendação: **encaminha** (é o gate no fluxo, não só um visualizador).
