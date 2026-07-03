// src/lib/workflow-templates.ts
//
// Templates de workflow: os 6 padrões canônicos de orquestração multi-agente (roubados
// dos deep-agents do LangChain). Cada template DESCREVE uma topologia (nós + conexões)
// relativa a um ponto de inserção — aqui NÃO há efeito colateral, só geometria e papéis.
// O WorkflowTemplatesMenu materializa a topologia via a API PÚBLICA do canvas-store
// (addAgent / addFilterNode / addEdge). Como os ids reais dos nós só nascem na inserção
// (nanoid do store), as arestas referenciam `key`s locais que o menu remapeia pro id criado.

/** Tipo de nó a criar. "agent" = OmniAgent (ACP) com persona; "filter" = FilterNode existente. */
export type WorkflowNodeKind = "agent" | "filter";

export interface WorkflowNodeSpec {
  /** Referência local (dentro do template) usada pelas arestas. */
  key: string;
  kind: WorkflowNodeKind;
  /** Rótulo/papel do nó (ex: "Dispatcher", "Worker 1", "Sintetizador"). */
  label: string;
  /** Persona (prompt de priming do OmniAgent) — só pra nós "agent". */
  persona?: string;
  /** Posição ABSOLUTA no canvas (já resolvida a partir do ponto de inserção). */
  position: { x: number; y: number };
}

export interface WorkflowEdgeSpec {
  /** `key` do nó de origem. */
  from: string;
  /** `key` do nó de destino. */
  to: string;
}

export interface WorkflowBuildResult {
  nodes: WorkflowNodeSpec[];
  edges: WorkflowEdgeSpec[];
}

export interface WorkflowTemplate {
  id: string;
  name: string;
  emoji: string;
  description: string;
  /** Monta a topologia a partir do ponto de inserção. `count` = fan-out (workers/
   *  verificadores/geradores) onde faz sentido; default 3. */
  build: (origin: { x: number; y: number }, count?: number) => WorkflowBuildResult;
}

// Espaçamento generoso: o AgentNode nasce 420×480, então colunas de 520 e linhas de 540
// garantem que os nós NÃO se sobreponham (o fitView do menu reenquadra depois da inserção).
const COL = 520;
const ROW = 540;

/** y de cada peer de um leque de `n` nós, centrado verticalmente em `cy`. */
function fanY(cy: number, i: number, n: number): number {
  return cy + (i - (n - 1) / 2) * ROW;
}

/** N do fan-out: default 3, preso a um intervalo são pra não estourar o canvas. */
function clampCount(count: number | undefined, min: number, max: number): number {
  const n = count ?? 3;
  return Math.max(min, Math.min(max, Math.round(n)));
}

export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  // 1 — Classify-and-Act: 1 classificador roteia pra N handlers especializados.
  {
    id: "classify-and-act",
    name: "Classify-and-Act",
    emoji: "🧭",
    description: "1 classificador roteia a entrada para N handlers especializados.",
    build: (o, count) => {
      const n = clampCount(count, 2, 6);
      const nodes: WorkflowNodeSpec[] = [
        {
          key: "classifier",
          kind: "agent",
          label: "Classificador",
          persona:
            "Você é o CLASSIFICADOR. Leia a entrada e decida a QUAL handler especializado ela pertence. " +
            "Não execute a tarefa em si — só identifique a categoria/rota e encaminhe para o handler correto.",
          position: { x: o.x, y: o.y },
        },
      ];
      const edges: WorkflowEdgeSpec[] = [];
      for (let i = 0; i < n; i++) {
        const key = `handler-${i + 1}`;
        nodes.push({
          key,
          kind: "agent",
          label: `Handler ${i + 1}`,
          persona:
            `Você é o HANDLER ${i + 1} — um especialista. Só age quando o Classificador roteia uma entrada da sua categoria. ` +
            "Execute a tarefa da sua especialidade e devolva o resultado.",
          position: { x: o.x + COL, y: fanY(o.y, i, n) },
        });
        edges.push({ from: "classifier", to: key });
      }
      return { nodes, edges };
    },
  },

  // 2 — Fanout-and-Synthesize: 1 dispatcher → N workers paralelos → 1 sintetizador.
  {
    id: "fanout-and-synthesize",
    name: "Fanout-and-Synthesize",
    emoji: "🌐",
    description: "1 dispatcher → N workers paralelos → 1 sintetizador.",
    build: (o, count) => {
      const n = clampCount(count, 2, 6);
      const nodes: WorkflowNodeSpec[] = [
        {
          key: "dispatcher",
          kind: "agent",
          label: "Dispatcher",
          persona:
            "Você é o DISPATCHER. Quebre a tarefa em subtarefas independentes e despache uma para cada Worker " +
            "em paralelo. Não resolva você mesmo — só distribua e defina o que cada um deve entregar.",
          position: { x: o.x, y: o.y },
        },
        {
          key: "synth",
          kind: "agent",
          label: "Sintetizador",
          persona:
            "Você é o SINTETIZADOR. Receba as saídas de todos os Workers e combine-as num resultado único, " +
            "coerente e sem redundância.",
          position: { x: o.x + 2 * COL, y: o.y },
        },
      ];
      const edges: WorkflowEdgeSpec[] = [];
      for (let i = 0; i < n; i++) {
        const key = `worker-${i + 1}`;
        nodes.push({
          key,
          kind: "agent",
          label: `Worker ${i + 1}`,
          persona:
            `Você é o WORKER ${i + 1}. Execute SÓ a subtarefa que o Dispatcher te entregar e devolva o ` +
            "resultado ao Sintetizador. Não coordene os outros workers.",
          position: { x: o.x + COL, y: fanY(o.y, i, n) },
        });
        edges.push({ from: "dispatcher", to: key });
        edges.push({ from: key, to: "synth" });
      }
      return { nodes, edges };
    },
  },

  // 3 — Adversarial-Verification: 1 gerador → N verificadores/refutadores → 1 juiz.
  {
    id: "adversarial-verification",
    name: "Adversarial-Verification",
    emoji: "⚖️",
    description: "1 gerador → N verificadores/refutadores → 1 juiz.",
    build: (o, count) => {
      const n = clampCount(count, 2, 6);
      const nodes: WorkflowNodeSpec[] = [
        {
          key: "generator",
          kind: "agent",
          label: "Gerador",
          persona:
            "Você é o GERADOR. Produza uma solução/afirmação completa para o problema. Ela será atacada pelos " +
            "verificadores — seja rigoroso e justifique cada passo.",
          position: { x: o.x, y: o.y },
        },
        {
          key: "judge",
          kind: "agent",
          label: "Juiz",
          persona:
            "Você é o JUIZ. Pese a proposta do Gerador contra as refutações dos Verificadores e decida o " +
            "veredito final (aceitar, corrigir ou rejeitar), justificando.",
          position: { x: o.x + 2 * COL, y: o.y },
        },
      ];
      const edges: WorkflowEdgeSpec[] = [];
      for (let i = 0; i < n; i++) {
        const key = `verifier-${i + 1}`;
        nodes.push({
          key,
          kind: "agent",
          label: `Verificador ${i + 1}`,
          persona:
            `Você é o VERIFICADOR ${i + 1} (advogado do diabo). Tente REFUTAR a proposta do Gerador: procure ` +
            "erros, contra-exemplos e furos. Reporte os achados ao Juiz.",
          position: { x: o.x + COL, y: fanY(o.y, i, n) },
        });
        edges.push({ from: "generator", to: key });
        edges.push({ from: key, to: "judge" });
      }
      return { nodes, edges };
    },
  },

  // 4 — Generate-and-Filter: 1 gerador → 1 filtro/crítico (FilterNode) → saída.
  {
    id: "generate-and-filter",
    name: "Generate-and-Filter",
    emoji: "🧪",
    description: "1 gerador → 1 filtro/crítico → saída.",
    build: (o) => {
      const nodes: WorkflowNodeSpec[] = [
        {
          key: "generator",
          kind: "agent",
          label: "Gerador",
          persona:
            "Você é o GERADOR. Produza candidatos (ideias, soluções, variações) para o problema, com volume e " +
            "diversidade — a filtragem vem depois.",
          position: { x: o.x, y: o.y },
        },
        {
          // FilterNode existente: roteamento por conteúdo (o "crítico" que corta o que não passa).
          key: "filter",
          kind: "filter",
          label: "Filtro/Crítico",
          position: { x: o.x + COL, y: o.y },
        },
        {
          key: "output",
          kind: "agent",
          label: "Saída",
          persona:
            "Você é a SAÍDA. Receba só os candidatos que passaram no filtro e entregue o resultado final, " +
            "formatado e pronto para uso.",
          position: { x: o.x + 2 * COL, y: o.y },
        },
      ];
      const edges: WorkflowEdgeSpec[] = [
        { from: "generator", to: "filter" },
        { from: "filter", to: "output" },
      ];
      return { nodes, edges };
    },
  },

  // 5 — Tournament: N geradores independentes → bracket de comparação 2-a-2 → vencedor.
  {
    id: "tournament",
    name: "Tournament",
    emoji: "🏆",
    description: "N geradores independentes → bracket de comparação 2-a-2 → vencedor.",
    build: (o, count) => {
      const n = clampCount(count, 2, 6);
      const nodes: WorkflowNodeSpec[] = [];
      const edges: WorkflowEdgeSpec[] = [];
      // Coluna 0: N geradores independentes (competidores).
      for (let i = 0; i < n; i++) {
        nodes.push({
          key: `gen-${i + 1}`,
          kind: "agent",
          label: `Gerador ${i + 1}`,
          persona:
            `Você é o GERADOR ${i + 1}. Produza sua MELHOR solução independente para o problema — você compete ` +
            "com os outros geradores no bracket.",
          position: { x: o.x, y: fanY(o.y, i, n) },
        });
      }
      // Coluna 1: comparadores 2-a-2 (1ª rodada do bracket) — ceil(n/2) juízes de par.
      const pairs = Math.ceil(n / 2);
      for (let p = 0; p < pairs; p++) {
        const key = `match-${p + 1}`;
        nodes.push({
          key,
          kind: "agent",
          label: `Comparação ${p + 1}`,
          persona:
            "Você é um COMPARADOR do bracket. Receba as soluções concorrentes, compare-as pelos critérios do " +
            "problema e promova só a VENCEDORA para a final.",
          position: { x: o.x + COL, y: fanY(o.y, p, pairs) },
        });
        edges.push({ from: `gen-${p * 2 + 1}`, to: key });
        if (p * 2 + 2 <= n) edges.push({ from: `gen-${p * 2 + 2}`, to: key });
      }
      // Coluna 2: final — escolhe a vencedora entre as ganhadoras dos pares.
      nodes.push({
        key: "winner",
        kind: "agent",
        label: "Vencedor",
        persona:
          "Você é a FINAL. Receba as vencedoras de cada comparação, escolha a melhor de todas e entregue-a como " +
          "solução vencedora do torneio.",
        position: { x: o.x + 2 * COL, y: o.y },
      });
      for (let p = 0; p < pairs; p++) edges.push({ from: `match-${p + 1}`, to: "winner" });
      return { nodes, edges };
    },
  },

  // 6 — Loop-Until-Done: 1 worker + 1 checker em loop até a condição de saída.
  {
    id: "loop-until-done",
    name: "Loop-Until-Done",
    emoji: "🔁",
    description: "1 worker + 1 checker em loop até a condição de saída.",
    build: (o) => {
      const nodes: WorkflowNodeSpec[] = [
        {
          key: "worker",
          kind: "agent",
          label: "Worker",
          persona:
            "Você é o WORKER do loop. A cada rodada, tente avançar/corrigir a tarefa e entregue o estado atual " +
            "ao Checker. Se o Checker reprovar, use o feedback dele e tente de novo.",
          position: { x: o.x, y: o.y },
        },
        {
          key: "checker",
          kind: "agent",
          label: "Checker",
          persona:
            "Você é o CHECKER (condição de saída). Avalie a entrega do Worker contra o critério de pronto: se " +
            "passou, encerre o loop; se não, devolva ao Worker o que ainda falta para outra rodada.",
          position: { x: o.x + COL, y: o.y },
        },
      ];
      // Loop de verdade: worker→checker (entrega) e checker→worker (feedback de volta).
      const edges: WorkflowEdgeSpec[] = [
        { from: "worker", to: "checker" },
        { from: "checker", to: "worker" },
      ];
      return { nodes, edges };
    },
  },
];
