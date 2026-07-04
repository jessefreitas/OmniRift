// src/lib/omnigraph-graph.ts
//
// OmniGraph F2 — importer do knowledge graph de código PRO CANVAS. Lê o `graph.json` CRU
// (formato node-link do networkx: `nodes[]` + `links[]`/`edges[]`) que o comando Rust
// `omnigraph_graph_json` devolve e destila só o DIGEST de COMUNIDADES Leiden — um
// CommunityNode por comunidade + arestas de acoplamento agregadas entre elas.
//
// VIABILIDADE (memória do projeto): renderizar o grafo de ENTIDADE inteiro MATA o WebKitGTK
// (mesma lição que derrubou a Central de Skills em matriz → virou lista). Por isso o importer
// NUNCA cria um nó por função: agrupa em comunidades e ainda assim IMPÕE tetos duros
// (MAX_COMMUNITIES / MAX_EDGES) — no pior caso o canvas ganha dezenas de nós, não milhares.
//
// Layout reusa a IDEIA das "ondas" do PipelineArchitectModal.build() (x = 80 + wave*360,
// y = 80 + col*240) — código próprio, sem importar o modal: a onda de cada comunidade é a
// profundidade dela no DAG de acoplamento; sem direção no grafo, cai num grid legível.

import { nanoid } from "nanoid";
import type { CanvasEdge, CanvasNode, CommunityNode, GraphConfidence } from "@/types/canvas";

/** Um nó do graph.json cru (node-link do networkx). Campos são tolerantes: versões e
 *  linguagens diferentes preenchem subconjuntos distintos. */
export interface GraphNodeRaw {
  id: string;
  label?: string;
  name?: string;
  /** Id numérico (ou string) da comunidade Leiden. */
  community?: number | string;
  /** Rótulo legível da comunidade (determinístico no omnigraph). */
  community_name?: string;
  /** Arquivo-fonte de onde o nó veio (pra contar arquivos por comunidade). */
  source_file?: string;
  file_type?: string;
  [k: string]: unknown;
}

/** Uma aresta do graph.json cru. `confidence` é o eixo central da F2. */
export interface GraphEdgeRaw {
  source: string;
  target: string;
  relation?: string;
  confidence?: string;
  [k: string]: unknown;
}

/** O `graph.json` cru. `links` é o default do networkx; versões novas usam `edges`. Aceita
 *  também um `communities`/`metadata` já normalizado, se algum backend futuro o incluir. */
export interface GraphJson {
  nodes?: GraphNodeRaw[];
  links?: GraphEdgeRaw[];
  edges?: GraphEdgeRaw[];
  graph?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  [k: string]: unknown;
}

// ── Tetos anti-WebKitGTK (a razão de existir deste módulo) ────────────────────────────
/** Máx. de CommunityNodes criados (top por tamanho). Acima disto o resto é agregado num
 *  "…mais N comunidades" e NÃO vira nó — o canvas nunca recebe centenas de nós. */
const MAX_COMMUNITIES = 60;
/** Máx. de arestas de acoplamento (top por peso). 60 nós → até 1770 pares; cortamos bem antes. */
const MAX_EDGES = 150;
/** God nodes destacados por comunidade (zona de review). Nunca o grafo interno inteiro. */
const GOD_NODES_PER_COMMUNITY = 8;
/** Top membros mostrados no EXPAND do nó. Cap pequeno — nunca todos (grafo inteiro trava). */
const TOP_MEMBERS = 12;
/** Colunas por onda antes de embrulhar (grid legível quando o grafo não tem direção). */
const MAX_ROWS_PER_WAVE = 8;

/** Paleta estável (índice da comunidade → cor). Cobre o cap com folga; cicla se estourar. */
const PALETTE = [
  "#a78bfa", "#60a5fa", "#34d399", "#f472b6", "#fbbf24", "#38bdf8",
  "#f87171", "#c084fc", "#4ade80", "#fb923c", "#2dd4bf", "#e879f9",
];

/** Ordem de SEVERIDADE (desempate da confiança dominante — puxa pro incerto pra dar
 *  visibilidade ao risco: uma aresta AMBÍGUA importa mais que N certas). */
const SEVERITY: Record<GraphConfidence, number> = { AMBIGUOUS: 3, INFERRED: 2, EXTRACTED: 1 };

/** Normaliza qualquer string de confiança do grafo pro enum; desconhecido → EXTRACTED. */
function normConfidence(raw: unknown): GraphConfidence {
  const s = String(raw ?? "").toUpperCase();
  if (s === "AMBIGUOUS") return "AMBIGUOUS";
  if (s === "INFERRED") return "INFERRED";
  return "EXTRACTED";
}

/** Label legível de um nó do grafo (label > name > id). */
function nodeLabel(n: GraphNodeRaw): string {
  return (n.label || n.name || n.id || "?").toString();
}

/** Arquivos de DOCUMENTAÇÃO (.md/.mdx/.txt/.rst) distintos referenciados pelo grafo
 *  (`source_file` dos nós), ordenados por DENSIDADE (quantos nós vêm do arquivo → os docs mais
 *  "ricos" primeiro). Pro "explorar docs no canvas": cada path vira um PreviewNode. `max` corta
 *  a cauda (evita despejar dezenas de previews e travar o WebView). */
export function extractDocFiles(parsed: GraphJson, max = 16): string[] {
  const count = new Map<string, number>();
  for (const n of parsed.nodes ?? []) {
    const sf = typeof n.source_file === "string" ? n.source_file : "";
    if (/\.(md|mdx|markdown|txt|rst)$/i.test(sf)) count.set(sf, (count.get(sf) ?? 0) + 1);
  }
  return [...count.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, max)
    .map(([f]) => f);
}

/** True se `graphSrc` e `changed` apontam pro MESMO arquivo respeitando FRONTEIRA de path
 *  (não casa `foobar.rs` com `foo.rs`). Porte 1:1 do `path_match` do Rust
 *  (`commands/omnigraph.rs`), que espelha o `_path_match` da engine — cobre repo-relativo
 *  vs. absoluto/prefixado dos dois lados. */
function pathMatch(graphSrc: string, changed: string): boolean {
  return graphSrc === changed || graphSrc.endsWith(`/${changed}`) || changed.endsWith(`/${graphSrc}`);
}

/**
 * GRAFO INTEGRADO (#30) — dado um `path` de arquivo editado e os nós do canvas, acha o
 * CommunityNode DONO desse arquivo: a comunidade cujo `sourceFiles` casa o path por FRONTEIRA
 * (pathMatch, o mesmo do gate de impacto do Rust). É o elo agente↔comunidade — o AgentNode
 * edita um arquivo no turno e isto resolve a comunidade a LIGAR (edge "works-on") + ACENDER.
 * Degrada limpo: sem CommunityNodes (ou sem `sourceFiles`, ou path vazio) → undefined (no-op).
 * 1º match vence — cada nó do grafo tem 1 `source_file` → 1 comunidade (não sobrepõem na prática).
 */
export function communityForPath(nodes: CanvasNode[], path: string): CommunityNode | undefined {
  if (!path) return undefined;
  for (const n of nodes) {
    if (n.kind !== "community") continue;
    if ((n.sourceFiles ?? []).some((f) => pathMatch(f, path))) return n;
  }
  return undefined;
}

/** Chave de comunidade de um nó: prioriza o id `community`; senão o `community_name`; senão
 *  null (nó sem comunidade — fica de fora dos nós de comunidade). */
function communityKey(n: GraphNodeRaw): string | null {
  if (n.community !== undefined && n.community !== null && n.community !== "") return `id:${n.community}`;
  if (n.community_name) return `nm:${n.community_name}`;
  return null;
}

interface Bucket {
  key: string;
  name: string;
  members: string[]; // node ids
  files: Set<string>;
}

/**
 * Extrai as comunidades do grafo cru e monta os nós + arestas do canvas.
 *
 * @param graphJson  o `graph.json` já parseado (JSON.parse do retorno do Rust).
 * @param cwd        pasta do projeto (só pra futura referência; não muda o resultado hoje).
 * @returns          `{ nodes, edges, truncatedCommunities }` — nós/arestas prontos pro store
 *                   (ids já são nanoid únicos) e quantas comunidades ficaram de fora do cap.
 */
export function importCommunities(
  graphJson: GraphJson,
  _cwd?: string,
): { nodes: CanvasNode[]; edges: CanvasEdge[]; truncatedCommunities: number } {
  const rawNodes = Array.isArray(graphJson.nodes) ? graphJson.nodes : [];
  const rawLinks = Array.isArray(graphJson.links)
    ? graphJson.links
    : Array.isArray(graphJson.edges)
      ? graphJson.edges
      : [];

  // node id → comunidade + label; degree por nó (do conjunto de arestas, não-direcionado).
  const nodeCommunity = new Map<string, string>();
  const nodeLabelMap = new Map<string, string>();
  const buckets = new Map<string, Bucket>();

  for (const n of rawNodes) {
    if (!n || typeof n.id !== "string") continue;
    nodeLabelMap.set(n.id, nodeLabel(n));
    const key = communityKey(n);
    if (!key) continue;
    nodeCommunity.set(n.id, key);
    let b = buckets.get(key);
    if (!b) {
      b = { key, name: (n.community_name || `Comunidade ${key.replace(/^\w+:/, "")}`).toString(), members: [], files: new Set() };
      buckets.set(key, b);
    }
    b.members.push(n.id);
    if (typeof n.source_file === "string" && n.source_file) b.files.add(n.source_file);
  }

  // Degree por nó (conta as duas pontas de cada aresta válida — não-direcionado).
  const degree = new Map<string, number>();
  const bump = (id: string) => degree.set(id, (degree.get(id) ?? 0) + 1);
  for (const e of rawLinks) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    bump(e.source);
    bump(e.target);
  }

  if (buckets.size === 0) return { nodes: [], edges: [], truncatedCommunities: 0 };

  // Ordena comunidades por tamanho (desc) e corta no teto.
  const ordered = [...buckets.values()].sort((a, b) => b.members.length - a.members.length);
  const kept = ordered.slice(0, MAX_COMMUNITIES);
  const truncatedCommunities = ordered.length - kept.length;
  const keptKeys = new Set(kept.map((b) => b.key));

  // ── Ondas: profundidade no DAG de acoplamento entre comunidades ─────────────────────
  // Constrói adjacência dirigida comunidade→comunidade a partir das arestas cross-community.
  const outAdj = new Map<string, Set<string>>();
  const indeg = new Map<string, number>();
  for (const b of kept) indeg.set(b.key, 0);
  const seenPair = new Set<string>();
  for (const e of rawLinks) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    const ck = nodeCommunity.get(e.source);
    const tk = nodeCommunity.get(e.target);
    if (!ck || !tk || ck === tk || !keptKeys.has(ck) || !keptKeys.has(tk)) continue;
    const pair = `${ck} ${tk}`;
    if (seenPair.has(pair)) continue;
    seenPair.add(pair);
    if (!outAdj.has(ck)) outAdj.set(ck, new Set());
    outAdj.get(ck)!.add(tk);
    indeg.set(tk, (indeg.get(tk) ?? 0) + 1);
  }
  // Longest-path layering (Kahn com camadas) — ciclos são cortados pelo guard de visitados.
  const wave = new Map<string, number>();
  for (const b of kept) wave.set(b.key, 1);
  {
    const inCopy = new Map(indeg);
    let frontier = kept.map((b) => b.key).filter((k) => (inCopy.get(k) ?? 0) === 0);
    const visited = new Set<string>();
    let level = 1;
    while (frontier.length > 0 && visited.size <= kept.length) {
      const next: string[] = [];
      for (const k of frontier) {
        if (visited.has(k)) continue;
        visited.add(k);
        wave.set(k, level);
        for (const t of outAdj.get(k) ?? []) {
          const d = (inCopy.get(t) ?? 0) - 1;
          inCopy.set(t, d);
          if (d <= 0 && !visited.has(t)) next.push(t);
        }
      }
      frontier = next;
      level++;
    }
  }
  const distinctWaves = new Set([...wave.values()]).size;

  // ── Monta os CommunityNodes ─────────────────────────────────────────────────────────
  const keyToNodeId = new Map<string, string>();
  const nodes: CanvasNode[] = [];
  const colByWave = new Map<number, number>();

  kept.forEach((b, idx) => {
    const byDegree = [...b.members].sort((a, c) => (degree.get(c) ?? 0) - (degree.get(a) ?? 0));
    const god = byDegree.slice(0, GOD_NODES_PER_COMMUNITY).map((id) => nodeLabelMap.get(id) ?? id);
    const top = byDegree.slice(0, TOP_MEMBERS).map((id) => nodeLabelMap.get(id) ?? id);

    // Sem sinal de direção (tudo na onda 1) → grid puro por índice; senão usa a onda do DAG.
    const w = distinctWaves > 1 ? (wave.get(b.key) ?? 1) : Math.floor(idx / MAX_ROWS_PER_WAVE) + 1;
    let col = colByWave.get(w) ?? 0;
    // Embrulha colunas altas pra não virar uma pilha vertical de 60 (ilegível).
    const wrapExtra = Math.floor(col / MAX_ROWS_PER_WAVE);
    const row = col % MAX_ROWS_PER_WAVE;
    colByWave.set(w, col + 1);
    const x = 80 + (w - 1 + wrapExtra) * 360;
    const y = 80 + row * 240;

    const id = nanoid();
    keyToNodeId.set(b.key, id);
    const node: CommunityNode = {
      id,
      kind: "community",
      name: b.name,
      memberCount: b.members.length,
      fileCount: b.files.size || undefined,
      // Guarda os paths reais (não só a contagem) — communityForPath casa o arquivo editado
      // pelo agente contra estes pra ligar a edge "works-on" e acender a comunidade (#30).
      sourceFiles: b.files.size ? [...b.files] : undefined,
      godNodes: god,
      topMembers: top,
      color: PALETTE[idx % PALETTE.length],
      createdAt: Date.now(),
      position: { x, y },
      size: { width: 260, height: 150 },
    };
    nodes.push(node);
  });

  // ── Arestas de acoplamento agregadas (não-direcionadas) entre comunidades ────────────
  interface Agg { a: string; b: string; total: number; byConf: Record<GraphConfidence, number> }
  const aggs = new Map<string, Agg>();
  for (const e of rawLinks) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    const ck = nodeCommunity.get(e.source);
    const tk = nodeCommunity.get(e.target);
    if (!ck || !tk || ck === tk || !keptKeys.has(ck) || !keptKeys.has(tk)) continue;
    // Par não-direcionado (ordena as chaves) → não duplica A→B e B→A.
    const [a, b] = ck < tk ? [ck, tk] : [tk, ck];
    const key = `${a} ${b}`;
    let agg = aggs.get(key);
    if (!agg) {
      agg = { a, b, total: 0, byConf: { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 } };
      aggs.set(key, agg);
    }
    agg.total++;
    agg.byConf[normConfidence(e.confidence)]++;
  }

  const edges: CanvasEdge[] = [...aggs.values()]
    .sort((x, y) => y.total - x.total)
    .slice(0, MAX_EDGES)
    .map((agg) => {
      // Confiança dominante = a mais frequente; empate resolve pela severidade (incerto ganha).
      const dominant = (Object.keys(agg.byConf) as GraphConfidence[]).sort((c1, c2) => {
        const d = agg.byConf[c2] - agg.byConf[c1];
        return d !== 0 ? d : SEVERITY[c2] - SEVERITY[c1];
      })[0];
      return {
        id: nanoid(),
        source: keyToNodeId.get(agg.a)!,
        target: keyToNodeId.get(agg.b)!,
        kind: "graph-edge" as const,
        confidence: dominant,
      };
    });

  return { nodes, edges, truncatedCommunities };
}

// ══ F5 — MÚLTIPLAS VISÕES do mesmo graph.json ═════════════════════════════════════════
//
// O usuário quis "gerar vários gráficos": o MESMO graph.json rende leituras diferentes.
//   • communities = arquitetura macro (o importCommunities acima, default).
//   • callgraph   = entidades (funções/classes) + arestas de chamada, CAPADO (top-N por grau —
//                   o grafo de entidade inteiro MATA o WebKitGTK; excedente vira um nó "+N ocultos").
//   • deps        = dependências entre módulos (agrega por source_file), nós = módulos.
//   • risk        = "visão de dívida": só god nodes + pontas de arestas AMBIGUOUS + as arestas incertas.
// Cada visão devolve {nodes, edges} pro canvas, com COR e LABEL prefixado distintos (canvas misto
// não confunde). Reusa os tetos/paleta/heurísticas já provados neste módulo.

export type GraphView = "communities" | "callgraph" | "deps" | "risk";

/** Resultado de uma visão: nós/arestas prontos pro store + quantos ficaram fora do cap. */
export interface GraphViewResult {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
  /** Nós/módulos/comunidades omitidos pelos tetos anti-WebKitGTK (pro toast "+N ocultos"). */
  hidden: number;
  /** Nota humana opcional quando a visão vem vazia (ex: "sem arestas AMBIGUOUS"). */
  note?: string;
}

/** Metadados por visão: rótulo (prefixo do nó + toast) e cor base dos nós. */
export const VIEW_META: Record<GraphView, { label: string; color: string }> = {
  communities: { label: "comunidades", color: "#a78bfa" },
  callgraph: { label: "callgraph", color: "#60a5fa" },
  deps: { label: "deps", color: "#2dd4bf" },
  risk: { label: "risco", color: "#f87171" },
};

// Tetos das visões de ENTIDADE (o grafo inteiro mata o WebKitGTK — mesma lição de MAX_COMMUNITIES).
const ENTITY_MAX_NODES = 80;
const ENTITY_MAX_EDGES = 200;
const VIEW_TOP_NEIGHBORS = 10;
/** Top-fração por grau tratada como god node (espelha GOD_NODE_TOP_FRACTION do Rust). */
const GOD_TOP_FRACTION = 0.02;
/** Grau mínimo pra um nó ser god node (espelha GOD_NODE_MIN_DEGREE do Rust — não promove folha). */
const GOD_MIN_DEGREE = 2;

function rawNodesOf(graph: GraphJson): GraphNodeRaw[] {
  return Array.isArray(graph.nodes) ? graph.nodes : [];
}
function rawLinksOf(graph: GraphJson): GraphEdgeRaw[] {
  return Array.isArray(graph.links) ? graph.links : Array.isArray(graph.edges) ? graph.edges : [];
}

/** Grau (não-direcionado) por nó, do conjunto de arestas. */
function degreeMap(links: GraphEdgeRaw[]): Map<string, number> {
  const d = new Map<string, number>();
  const bump = (id: string) => d.set(id, (d.get(id) ?? 0) + 1);
  for (const e of links) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    bump(e.source);
    bump(e.target);
  }
  return d;
}

/** id → label legível de todos os nós válidos. */
function labelMap(nodes: GraphNodeRaw[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const n of nodes) if (n && typeof n.id === "string") m.set(n.id, nodeLabel(n));
  return m;
}

/** god nodes GLOBAIS: marcações explícitas vencem; senão top-2% por grau (mín. grau 2). Porte 1:1
 *  do `god_node_ids` do Rust — a MESMA heurística do gate/diff. */
function godNodeIds(nodes: GraphNodeRaw[], degree: Map<string, number>): Set<string> {
  const explicit = new Set<string>();
  for (const n of nodes) {
    if (!n || typeof n.id !== "string") continue;
    if (n.god === true || n.is_god === true) explicit.add(n.id);
  }
  if (explicit.size > 0) return explicit;
  const ids = nodes.filter((n) => n && typeof n.id === "string").map((n) => n.id as string);
  if (ids.length === 0) return new Set();
  const k = Math.max(1, Math.ceil(ids.length * GOD_TOP_FRACTION));
  const ranked = ids
    .map((id) => ({ id, d: degree.get(id) ?? 0 }))
    .filter((x) => x.d >= GOD_MIN_DEGREE)
    .sort((a, b) => b.d - a.d || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return new Set(ranked.slice(0, k).map((x) => x.id));
}

/** Confiança dominante de um bucket agregado (mais frequente; empate → severidade, incerto ganha). */
function dominantConf(byConf: Record<GraphConfidence, number>): GraphConfidence {
  return (Object.keys(byConf) as GraphConfidence[]).sort((c1, c2) => {
    const d = byConf[c2] - byConf[c1];
    return d !== 0 ? d : SEVERITY[c2] - SEVERITY[c1];
  })[0];
}

/** Posição em grid (reusa a métrica das ondas: x = 80 + col*360, y = 80 + row*240). */
function gridPos(index: number): { x: number; y: number } {
  const col = Math.floor(index / MAX_ROWS_PER_WAVE);
  const row = index % MAX_ROWS_PER_WAVE;
  return { x: 80 + col * 360, y: 80 + row * 240 };
}

/** Monta um nó do canvas (reusa o CommunityNode como "nó de grafo" genérico das visões — o único
 *  tipo de nó de grafo registrado; os campos são reinterpretados por visão via o label prefixado). */
function makeGraphNode(opts: {
  name: string;
  memberCount: number;
  godNodes: string[];
  topMembers: string[];
  color: string;
  index: number;
  fileCount?: number;
  sourceFiles?: string[];
}): CommunityNode {
  return {
    id: nanoid(),
    kind: "community",
    name: opts.name,
    memberCount: opts.memberCount,
    fileCount: opts.fileCount,
    sourceFiles: opts.sourceFiles,
    godNodes: opts.godNodes,
    topMembers: opts.topMembers,
    color: opts.color,
    createdAt: Date.now(),
    position: gridPos(opts.index),
    size: { width: 260, height: 150 },
  };
}

/** callgraph — entidades + chamadas, capado top-N por grau. memberCount = grau; topMembers = vizinhos. */
function buildCallgraphView(graph: GraphJson): GraphViewResult {
  const nodes = rawNodesOf(graph).filter((n) => n && typeof n.id === "string");
  const links = rawLinksOf(graph);
  const degree = degreeMap(links);
  const labels = labelMap(nodes);
  const gods = godNodeIds(nodes, degree);

  const adj = new Map<string, Set<string>>();
  for (const e of links) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    if (!adj.has(e.source)) adj.set(e.source, new Set());
    if (!adj.has(e.target)) adj.set(e.target, new Set());
    adj.get(e.source)!.add(e.target);
    adj.get(e.target)!.add(e.source);
  }

  const ranked = nodes
    .map((n) => n.id as string)
    .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0));
  const keptIds = ranked.slice(0, ENTITY_MAX_NODES);
  const keptSet = new Set(keptIds);
  const hidden = ranked.length - keptIds.length;

  const idToNode = new Map<string, string>();
  const outNodes: CanvasNode[] = [];
  keptIds.forEach((id, idx) => {
    const lbl = labels.get(id) ?? id;
    const neighbors = [...(adj.get(id) ?? [])]
      .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
      .slice(0, VIEW_TOP_NEIGHBORS)
      .map((nid) => labels.get(nid) ?? nid);
    const node = makeGraphNode({
      name: `[${VIEW_META.callgraph.label}] ${lbl}`,
      memberCount: degree.get(id) ?? 0,
      godNodes: gods.has(id) ? [lbl] : [],
      topMembers: neighbors,
      color: VIEW_META.callgraph.color,
      index: idx,
    });
    idToNode.set(id, node.id);
    outNodes.push(node);
  });
  // Nó-sentinela "+N ocultos" (o grafo tinha mais que o cap; não some silenciosamente).
  if (hidden > 0) {
    outNodes.push(
      makeGraphNode({
        name: `[${VIEW_META.callgraph.label}] +${hidden} ocultos`,
        memberCount: hidden,
        godNodes: [],
        topMembers: [],
        color: VIEW_META.callgraph.color,
        index: keptIds.length,
      }),
    );
  }

  // Arestas entre nós mantidos, dedup direcional, cap por grau somado (as mais centrais primeiro).
  const seen = new Set<string>();
  const cands: { s: string; t: string; conf: GraphConfidence; w: number }[] = [];
  for (const e of links) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    if (e.source === e.target || !keptSet.has(e.source) || !keptSet.has(e.target)) continue;
    const key = `${e.source} ${e.target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    cands.push({
      s: e.source,
      t: e.target,
      conf: normConfidence(e.confidence),
      w: (degree.get(e.source) ?? 0) + (degree.get(e.target) ?? 0),
    });
  }
  cands.sort((a, b) => b.w - a.w);
  const edges: CanvasEdge[] = cands.slice(0, ENTITY_MAX_EDGES).map((c) => ({
    id: nanoid(),
    source: idToNode.get(c.s)!,
    target: idToNode.get(c.t)!,
    kind: "graph-edge" as const,
    confidence: c.conf,
  }));

  return { nodes: outNodes, edges, hidden };
}

/** Basename de um módulo/arquivo (último segmento do path). */
function moduleBasename(mod: string): string {
  const parts = mod.split(/[\\/]/);
  return parts[parts.length - 1] || mod;
}

/** deps — só dependências entre MÓDULOS (agrega por source_file); nós = módulos. */
function buildDepsView(graph: GraphJson): GraphViewResult {
  const nodes = rawNodesOf(graph).filter((n) => n && typeof n.id === "string");
  const links = rawLinksOf(graph);
  const degree = degreeMap(links);
  const labels = labelMap(nodes);

  const nodeModule = new Map<string, string>();
  interface Mod {
    key: string;
    members: string[];
  }
  const mods = new Map<string, Mod>();
  for (const n of nodes) {
    const mk = typeof n.source_file === "string" && n.source_file ? n.source_file : null;
    if (!mk) continue;
    nodeModule.set(n.id as string, mk);
    let m = mods.get(mk);
    if (!m) {
      m = { key: mk, members: [] };
      mods.set(mk, m);
    }
    m.members.push(n.id as string);
  }
  if (mods.size === 0) {
    return { nodes: [], edges: [], hidden: 0, note: "sem source_file nos nós — não dá pra derivar módulos" };
  }

  const ordered = [...mods.values()].sort((a, b) => b.members.length - a.members.length);
  const kept = ordered.slice(0, MAX_COMMUNITIES);
  const hidden = ordered.length - kept.length;
  const keptKeys = new Set(kept.map((m) => m.key));

  const modToNode = new Map<string, string>();
  const outNodes: CanvasNode[] = kept.map((m, idx) => {
    const top = [...m.members]
      .sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))
      .slice(0, TOP_MEMBERS)
      .map((id) => labels.get(id) ?? id);
    const node = makeGraphNode({
      name: `[${VIEW_META.deps.label}] ${moduleBasename(m.key)}`,
      memberCount: m.members.length,
      godNodes: [],
      topMembers: top,
      color: VIEW_META.deps.color,
      fileCount: 1,
      // Módulo = 1 source_file → a edge "works-on" também acende nós da visão deps (#30).
      sourceFiles: [m.key],
      index: idx,
    });
    modToNode.set(m.key, node.id);
    return node;
  });

  // Aresta módulo→módulo (direcionada, agregada por confiança dominante).
  interface Agg {
    s: string;
    t: string;
    total: number;
    byConf: Record<GraphConfidence, number>;
  }
  const aggs = new Map<string, Agg>();
  for (const e of links) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    const sm = nodeModule.get(e.source);
    const tm = nodeModule.get(e.target);
    if (!sm || !tm || sm === tm || !keptKeys.has(sm) || !keptKeys.has(tm)) continue;
    const key = `${sm} ${tm}`;
    let agg = aggs.get(key);
    if (!agg) {
      agg = { s: sm, t: tm, total: 0, byConf: { EXTRACTED: 0, INFERRED: 0, AMBIGUOUS: 0 } };
      aggs.set(key, agg);
    }
    agg.total++;
    agg.byConf[normConfidence(e.confidence)]++;
  }
  const edges: CanvasEdge[] = [...aggs.values()]
    .sort((a, b) => b.total - a.total)
    .slice(0, MAX_EDGES)
    .map((agg) => ({
      id: nanoid(),
      source: modToNode.get(agg.s)!,
      target: modToNode.get(agg.t)!,
      kind: "graph-edge" as const,
      confidence: dominantConf(agg.byConf),
    }));

  return { nodes: outNodes, edges, hidden };
}

/** risk — a "visão de dívida": só god nodes + pontas de arestas AMBIGUOUS + as próprias incertas. */
function buildRiskView(graph: GraphJson): GraphViewResult {
  const nodes = rawNodesOf(graph).filter((n) => n && typeof n.id === "string");
  const links = rawLinksOf(graph);
  const degree = degreeMap(links);
  const labels = labelMap(nodes);
  const gods = godNodeIds(nodes, degree);

  const ambiguous = links.filter(
    (e) =>
      e &&
      typeof e.source === "string" &&
      typeof e.target === "string" &&
      normConfidence(e.confidence) === "AMBIGUOUS",
  );

  const included = new Set<string>(gods);
  for (const e of ambiguous) {
    included.add(e.source as string);
    included.add(e.target as string);
  }
  if (included.size === 0) {
    return { nodes: [], edges: [], hidden: 0, note: "sem god nodes nem arestas AMBIGUOUS — dívida estrutural zero 🎉" };
  }

  const partners = new Map<string, Set<string>>();
  for (const e of ambiguous) {
    const s = e.source as string;
    const t = e.target as string;
    if (!partners.has(s)) partners.set(s, new Set());
    if (!partners.has(t)) partners.set(t, new Set());
    partners.get(s)!.add(t);
    partners.get(t)!.add(s);
  }

  const ranked = [...included].sort(
    (a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0) || (a < b ? -1 : a > b ? 1 : 0),
  );
  const keptIds = ranked.slice(0, ENTITY_MAX_NODES);
  const keptSet = new Set(keptIds);
  const hidden = ranked.length - keptIds.length;

  const idToNode = new Map<string, string>();
  const outNodes: CanvasNode[] = keptIds.map((id, idx) => {
    const lbl = labels.get(id) ?? id;
    const partnerLabels = [...(partners.get(id) ?? [])]
      .map((pid) => labels.get(pid) ?? pid)
      .slice(0, VIEW_TOP_NEIGHBORS);
    const node = makeGraphNode({
      name: `[${VIEW_META.risk.label}] ${lbl}`,
      memberCount: degree.get(id) ?? 0,
      godNodes: gods.has(id) ? [lbl] : [],
      topMembers: partnerLabels,
      color: VIEW_META.risk.color,
      index: idx,
    });
    idToNode.set(id, node.id);
    return node;
  });

  const seen = new Set<string>();
  const edges: CanvasEdge[] = [];
  for (const e of ambiguous) {
    const s = e.source as string;
    const t = e.target as string;
    if (s === t || !keptSet.has(s) || !keptSet.has(t)) continue;
    const key = s < t ? `${s} ${t}` : `${t} ${s}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edges.push({
      id: nanoid(),
      source: idToNode.get(s)!,
      target: idToNode.get(t)!,
      kind: "graph-edge",
      confidence: "AMBIGUOUS",
    });
    if (edges.length >= ENTITY_MAX_EDGES) break;
  }

  return { nodes: outNodes, edges, hidden };
}

/**
 * Ponto único das VISÕES: dado o graph.json cru e a visão escolhida, devolve {nodes, edges} pro
 * canvas. `communities` delega ao importer original (intocado); as demais montam entidade/módulo/
 * dívida com tetos anti-WebKitGTK. Todos os nomes ficam PREFIXADOS com a visão (canvas misto).
 */
export function importGraph(
  graphJson: GraphJson,
  cwd: string | undefined,
  view: GraphView,
): GraphViewResult {
  switch (view) {
    case "callgraph":
      return buildCallgraphView(graphJson);
    case "deps":
      return buildDepsView(graphJson);
    case "risk":
      return buildRiskView(graphJson);
    case "communities":
    default: {
      const r = importCommunities(graphJson, cwd);
      const prefix = `[${VIEW_META.communities.label}] `;
      const nodes = r.nodes.map((n) =>
        n.kind === "community" ? { ...n, name: `${prefix}${n.name}` } : n,
      );
      return { nodes, edges: r.edges, hidden: r.truncatedCommunities };
    }
  }
}
