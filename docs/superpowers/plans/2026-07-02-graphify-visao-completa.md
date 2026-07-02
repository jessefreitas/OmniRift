# Graphify — visão completa (aproveitar o máximo + loop de aprendizado contínuo)

**Data:** 2026-07-02 · **Autor:** Jessé (via análise ancorada no código real) · **Status:** 📋 plano

## Contexto

Graphify = knowledge graph de código (Python/MIT/CLI): comunidades **Leiden**, **god nodes** (funções-hub),
arestas com **confidence** (`EXTRACTED` / `INFERRED` / `AMBIGUOUS`) e `get_pr_impact`. A análise profunda já
concluiu: a jogada #1 é o **Arquiteto ancorado** (F1, já em implementação). Decisões travadas:
**NÃO** injetar o MCP do Graphify em todo agente (Serena já cobre query pontual); **NÃO** bundlar Python;
**opt-in**; dep Python via `uvx` (igual Serena); o `graph.json` grande vive no **processo `serve`**, não no WebView.

O ganho estratégico do pedido do Jessé — *"o sistema aprendendo com ele e melhorando continuamente"* — mora na
**F4 (loop)**: o trabalho dos agentes melhora o grafo, o grafo melhora as próximas decisões dos agentes.

---

## F1 — Arquiteto ancorado ✅ (em implementação nesta sessão)

**O que já está sendo feito.** Comando Rust `graphify_report(cwd)` destila o `GRAPH_REPORT` a **~6KB**
(top comunidades + nomes + god nodes + arestas AMBIGUOUS de maior grau) e injeta no prompt do Arquiteto.

Ponto de injeção real: `apps/desktop/src/lib/pipeline-client.ts` → `schemaHint(desc)` (a string do `PROJETO:`).
O `graphify_report` entra como um bloco `MAPA ESTRUTURAL DO CÓDIGO (Graphify):` **prependado** ao `desc`, tanto no
caminho CLI (`generatePipelinePlanViaCli`) quanto BYOK (`generatePipelinePlan`). Chamada em
`PipelineArchitectModal.tsx#generate()` — só busca o report se o grafo existe (senão string vazia, comportamento intocado).

**Critério de aceite F1:**
- `graphify_report` retorna ≤ 6KB **ou** `""` (sem grafo / dep ausente) — nunca lança pro `generate()`.
- Com grafo presente, o plano do Arquiteto referencia comunidades/god nodes reais (ex: agentes por comunidade).
- Repo sem grafo → plano idêntico ao de hoje (zero regressão). Opt-in por presença do `graph.json`.

---

## F2 — Grafo de código NO CANVAS (viz honesta)

**Viabilidade honesta:** renderizar o grafo de **entidade inteiro** MATA o WebKitGTK (registrado na memória —
mesmo motivo que derrubou a Central de Skills em matriz e virou lista). Logo: **só comunidades**, como nós
**colapsáveis**. Nunca funções individuais no canvas.

1. **`CommunityNode` xyflow** — registrar em `FloorCanvas.tsx` (`nodeTypes`, linha 65: `community: CommunityNode`).
   Nó = 1 comunidade Leiden (nome, nº de arquivos, nº de god nodes, cor). Colapsado por default; expandir mostra os
   **god nodes** (texto), nunca o grafo interno inteiro.
2. **Importer `graph.json → nodes`** — reusa o layout de **ondas** do `PipelineArchitectModal.build()`
   (`x = 80 + wave*360`, `y = 80 + col*240`, `colByFloorWave`): comunidade vira "onda" por profundidade no DAG de
   dependência entre clusters. Só o **digest** (nomes + contagens) cruza pro WebView; o `graph.json` fica no `serve`.
3. **confidence → estilo de aresta** — reusa as **conexões cor-por-estado** do `edges/FlowEdge.tsx`
   (`strokeDasharray` + `COLORS` por `kind`). Novo `kind: "graph-edge"` + campo `confidence`:
   - `EXTRACTED` → **sólida** (idle branco/ciano).
   - `INFERRED` → **tracejada** (`strokeDasharray: "6 4"`, reusa o do `sending`).
   - `AMBIGUOUS` → **pontilhada vermelha** (`"2 4"` + `COLORS.error`).
4. **Ligação viva AgentNode → CommunityNode** ("trabalha neste cluster") — o turn-done do `AgentNode.tsx` (linha 600)
   já dispara `scheduleReindex`; no mesmo hook, casar os arquivos editados no turno (`lastDiffRef`/diff do worktree)
   com o índice `arquivo → comunidade` (via `_path_match`, mesmo padrão do `cwd_inside_mount`). Match → a edge
   `agent→community` **acende** (reusa `edgeFlow` = `received`, verde ~2s de fade). É o "olho" do usuário sobre qual
   cluster cada agente está mexendo — em tempo real.

**Shippável:** F2.1 (CommunityNode + importer estático via botão "Importar grafo") → F2.2 (edges + confidence) →
F2.3 (ligação viva). Cada uma commitável isolada.

---

## F3 — Gate estrutural + confidence no review

1. **`gate:graph` nas Routines** — reusa `RoutineTrigger` (`routines.ts`) e o encanamento de `runLandGates`.
   Gate **determinístico, sub-500ms, SEM LLM**: `diff do worktree → nodes_affected → communities_touched →
   interseção com god_nodes → exit code`. Roda via um comando Rust `graphify_gate(cwd, base)` (não `parallel_run_hook`,
   porque precisa do resultado estruturado, não só exit). Roda **ANTES** do `runReview` caro em
   `Sidebar.tsx#landFloor()` — hoje a ordem é `review gate (1067) → onLand (1086) → runLandGates (1097) → land (1107)`;
   o graph gate entra **no topo do landFloor**, curto-circuitando o LLM quando a estrutura já reprova.
2. **Política por projeto** — reusa a estrutura de `review-policy.ts` (por-projeto + global, localStorage). Novos campos:
   `godNodeTouched: "block"`, `communitiesTouched: { max: N, action: "review" }`, `ambiguousEdge: "review"`.
3. **Badge no AgentNode / card Kanban** — o header do AgentNode já tem badges (emoji/tempo/RSS). Novo badge
   `▲ toca 2 god nodes` (amarelo) alimentado pelo `graphify_gate` no turn-done; espelhado no card Kanban semeado
   pelo `build()` (`kanbanCardCreate`).
4. **confidence sobe severidade no code-review-ai** — em `review.ts#buildPrompt`, injetar as arestas de confidence
   dos arquivos do diff: "arquivos X/Y têm arestas **AMBIGUOUS/INFERRED** — trate acoplamento incerto como risco".
   No `aggregate`, uma dependência AMBIGUOUS tocada por um finding sobe `WARNING→CRITICAL` (peso `architecture`).

**Shippável:** F3.1 (`graphify_gate` + gate no landFloor, sem UI) → F3.2 (política) → F3.3 (badges) → F3.4 (review).

---

## F4 — O LOOP DE APRENDIZADO CONTÍNUO (o coração do pedido) 🫀

Como o sistema **melhora a cada ciclo**:

- **(a) Re-build do grafo no turn-done, debounced.** Espelho EXATO do `scheduleReindex` (`omnifs-client.ts`):
  timer module-level, janela de silêncio ~60s, coalesce rajada de turnos num rebuild só, re-checa cwd gerenciado no
  disparo, fire-and-forget. Novo `scheduleGraphRebuild(cwd)` chamado nos **mesmos** sítios do turn-done
  (`AgentNode.tsx:605`, `useTerminalSession.ts:388`). O grafo nunca fica velho sem custar turno do agente.
- **(b) Arestas AMBIGUOUS → SUB-TASKS automáticas** (o grafo se **auto-limpa** com o trabalho dos agentes). Cada
  aresta `AMBIGUOUS` de alto grau vira um subagente "**resolver ambiguidade arquitetural**" — reusa o par
  `addSubagent` + `subagent_write` de `PipelineArchitectModal.build()` (linhas 254-277). O subagente confirma/nega a
  relação; confirma → a aresta promove a `EXTRACTED` no próximo rebuild (a). É o motor que **fecha o loop**: menos
  incerteza a cada ciclo.
- **(c) God nodes emergentes → alertas de dívida.** No rebuild (a), se uma função cruza o limiar de hub, dispara
  `notify` (mesmo canal do Sidebar): *"`fn X` virou hub (N callers) — refatorar?"*. Vira card no Kanban do projeto.
- **(d) AGENTS.md por papel grava insights do grafo.** A persona que aprende já existe
  (`agentsMdInstruction(role)` → `./.omnirift/agents-md/<slug>.md`). O brief instrui: ao terminar, registrar no
  AGENTS.md o que aprendeu da estrutura ("a comunidade `auth` é god-node-pesada; toque com cuidado"). Próxima montagem
  do mesmo papel nasce sabendo.
- **(e) Cruzamento com issue #152 (temporal × structural).** OmniFS = memória **temporal/semântica** (o que mudou,
  quando, busca por significado); Graphify = memória **estrutural** (quem chama quem, onde estão os hubs). Os dois
  no mesmo prompt do Arquiteto (F1) e do review (F3.4) = **memória completa**. O digest da F1 já é o ponto de fusão.

**Como o loop fecha:** trabalho dos agentes → rebuild (a) → grafo mais limpo (b) + dívida sinalizada (c) →
próximas decisões do Arquiteto (F1) e gates (F3) melhores → agentes mais certeiros → repete.

---

## F5 — Custo / opt-in / riscos

- **Dep Python via `uvx`** (igual Serena) — detecção espelha `find_omnifs_bin`/`find_sidecar`; **nunca bundlar**.
  Ausente → todas as features degradam pra no-op silencioso (report `""`, gate `GO`, sem CommunityNode).
- **`graph.json` grande fica no `serve`.** Graphify roda como **daemon `serve`** (padrão do OmniFS `ensure_daemon`):
  OmniRift é cliente; só o **digest ≤6KB + resumos de comunidade** cruzam pro WebView. `graph.json` >512MB **nunca**
  entra no DOM.
- **~0% de ganho em repo pequeno** → toggle **"modo projeto grande"** (Ferramentas → Graphify); off por default;
  liga só quando `LOC > limiar` ou o usuário escolhe. Repo pequeno = Serena já basta.
- **GC do `graph.json`** — ledger com cap (padrão do `record_snapshot`, cap 500) + purga do store por idade/tamanho.
- **Risco #1: rebuild caro em rajada** → mitigado pelo debounce (a). **Risco #2: gate falso-positivo** trava Land →
  política `warn` por default (F3.2), `block` é opt-in.

---

## Ordem de execução e dependências

```
F1 (em curso) ──► F2 ‖ F3 (paralelas; ambas só exigem graph.json existir) ──► F4 (loop)
```

| Fatia | Depende de | Desbloqueia | Estimativa |
|-------|-----------|-------------|-----------|
| **F1** Arquiteto ancorado | Graphify serve + `graphify_report` | tudo (grafo passa a existir) | 🔨 em curso |
| **F3.1** `graphify_gate` no Land | F1 (serve) | steering barato dos agentes | ~1 dia |
| **F2.1–2.3** grafo no canvas | F1 (serve) | leitura visual + ligação viva | ~2-3 dias |
| **F3.2–3.4** política + badges + review | F3.1 | gate configurável + review afiado | ~1-2 dias |
| **F4a** rebuild debounced | F1 | grafo sempre fresco | ~0.5 dia |
| **F4b** AMBIGUOUS→subtask | F4a + F2.2 (arestas) | auto-limpeza do grafo | ~1-2 dias |
| **F4c–e** dívida + AGENTS.md + fusão | F4a | loop completo | ~1-2 dias |

**Fatia de MAIOR alavancagem depois da F1: `F3.1` (o `graphify_gate` determinístico no Land).**
Motivo: é a mais barata (sub-500ms, **zero LLM**), reusa quase inteiro o encanamento de `runLandGates`, roda **antes**
do review caro (economiza tokens), **sem UI nova**, e é o primeiro ponto onde o grafo passa a **steerar** o
comportamento dos agentes (bloqueando blast-radius em god nodes) — exatamente o "sistema melhorando" que o Jessé pediu,
com o menor custo de implementação. Ela é também o pré-requisito de contexto pra F4b (o gate identifica as arestas
AMBIGUOUS que viram as sub-tasks de auto-limpeza — o verdadeiro coração do loop).
