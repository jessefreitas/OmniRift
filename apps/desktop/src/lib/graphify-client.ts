// src/lib/graphify-client.ts
//
// Ponte frontend → Graphify (knowledge graph de código). Fase F3.1: o GATE
// ESTRUTURAL do Land. `graphifyImpact` chama o comando Rust homônimo (determinístico,
// sub-500ms, SEM LLM) que mede o "raio de explosão" de um diff contra o graph.json já
// no disco: nós/comunidades tocados, cruzamento com god nodes (funções-hub) e arestas
// AMBIGUOUS (acoplamento incerto). A POLÍTICA (`GraphGatePolicy`) — por projeto + global,
// em localStorage, no molde do review-policy.ts — decide se um impacto vira WARN ou BLOCK.
//
// Default = WARN: o gate só loga/avisa, nunca bloqueia o Land — evita que um falso-positivo
// estrutural trave o merge. `block` é opt-in por projeto (o Jessé liga quando confia no grafo).
//
// ── MEMÓRIA COMPLETA = temporal × structural (fusão OmniFS × Graphify — F4e / issue #152) ──
// Dois cérebros de memória plugável, com eixos ORTOGONAIS e complementares:
//   • OmniFS  = memória TEMPORAL/SEMÂNTICA — o que MUDOU, QUANDO, e busca por SIGNIFICADO
//     (snapshots + timeline + índice semântico do drive).
//   • Graphify = memória ESTRUTURAL — QUEM chama QUEM, ONDE estão os hubs (god nodes), como o
//     código se agrupa (comunidades Leiden) e onde o acoplamento é incerto (arestas AMBIGUOUS).
// Sozinho, cada um responde metade: "o que aconteceu" (OmniFS) vs "como o código é" (Graphify).
// JUNTOS, no MESMO prompt do Arquiteto (F1) e do review (F3.4), fecham a memória: o time decide
// ancorado na estrutura REAL e no histórico REAL. O digest ≤6KB da F1 é o ponto físico de fusão
// (relatório estrutural destilado ao lado do contexto temporal). O LOOP (F4) mantém os DOIS
// frescos no turn-done — `scheduleReindex` (OmniFS) e `scheduleGraphRebuild` (Graphify) são
// espelhos um do outro, disparados nos MESMOS sítios (turn-done do AgentNode + idle/done do
// terminal). Trabalho dos agentes → memória temporal E estrutural mais frescas → próximas
// decisões melhores → repete. Ambos degradam a no-op se o respectivo backend estiver ausente.

import { invoke } from "@tauri-apps/api/core";
import { notify } from "@/lib/notify";
import type { GraphJson, GraphNodeRaw, GraphEdgeRaw } from "@/lib/graphify-graph";

/** Uma aresta de baixa confiança tocada pelo diff (labels legíveis das duas pontas). */
export interface GraphAmbiguousEdge {
  source: string;
  target: string;
  /** Hoje sempre "AMBIGUOUS" (o campo deixa distinguir se um dia entrar INFERRED). */
  confidence: string;
}

/** Impacto estrutural de um diff, medido contra o graph.json (espelha o `GraphImpact` do Rust). */
export interface GraphImpact {
  /** Havia graph.json legível? false → o gate não tem base pra decidir (passa). */
  available: boolean;
  nodesAffected: number;
  communitiesTouched: number[];
  godNodesTouched: string[];
  ambiguousEdgesTouched: GraphAmbiguousEdge[];
}

/** Impacto vazio (sem grafo / sem Tauri) — `available:false` sempre passa o gate. */
export const EMPTY_IMPACT: GraphImpact = {
  available: false,
  nodesAffected: 0,
  communitiesTouched: [],
  godNodesTouched: [],
  ambiguousEdgesTouched: [],
};

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Mede o blast-radius de `changedFiles` contra o graph.json de `cwd`. Sem Tauri → impacto
 *  vazio (não bloqueia). Erro do backend propaga pro chamador (runGraphGate trata e passa). */
export async function graphifyImpact(cwd: string, changedFiles: string[]): Promise<GraphImpact> {
  if (!hasTauri() || !cwd.trim()) return EMPTY_IMPACT;
  return invoke<GraphImpact>("graphify_impact", { cwd, changedFiles });
}

// ── Política do gate estrutural (por projeto + default global) ────────────────────────

/** Ação do gate: `off` desliga; `warn` só avisa (default, nunca bloqueia); `block` aborta
 *  o Land quando alguma condição dispara. */
export type GraphGateAction = "off" | "warn" | "block";

export interface GraphGatePolicy {
  action: GraphGateAction;
  /** Dispara quando o diff toca ≥1 god node (função-hub). */
  blockOnGodNode: boolean;
  /** Dispara quando `communitiesTouched > maxCommunities`. 0 = desligado. */
  maxCommunities: number;
  /** Dispara quando o diff toca ≥1 aresta AMBIGUOUS. */
  blockOnAmbiguous: boolean;
}

/** Default = WARN (nunca bloqueia sem opt-in). As condições já vêm marcadas pra que, ao
 *  trocar a ação pra `block`, o gate reprove blast-radius em hub / acoplamento incerto. */
export const DEFAULT_GRAPH_GATE_POLICY: GraphGatePolicy = {
  action: "warn",
  blockOnGodNode: true,
  maxCommunities: 0,
  blockOnAmbiguous: true,
};

const KEY = "omnirift-graph-gate-policy-v1";

function readAll(): Record<string, GraphGatePolicy> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

/** Política do escopo (projeto) ou o default global. Mescla com o DEFAULT (campos novos). */
export function loadGraphGatePolicy(scope?: string): GraphGatePolicy {
  const all = readAll();
  const stored = all[scope || "__global"] ?? all["__global"];
  return stored ? { ...DEFAULT_GRAPH_GATE_POLICY, ...stored } : DEFAULT_GRAPH_GATE_POLICY;
}

export function saveGraphGatePolicy(policy: GraphGatePolicy, scope?: string): void {
  const all = readAll();
  all[scope || "__global"] = policy;
  localStorage.setItem(KEY, JSON.stringify(all));
}

/** Veredito do gate sobre um impacto, dada a política. `blocked` só é true quando
 *  `action === "block"` E alguma condição dispara; `reason` descreve o achado (pro notify). */
export interface GraphGateVerdict {
  pass: boolean;
  reason: string;
  blocked: boolean;
}

/** PURA (testável): aplica a política ao impacto. Monta a lista de motivos disparados,
 *  depois deixa a AÇÃO decidir — `off` ignora, `warn` avisa sem bloquear, `block` reprova. */
export function evaluateGraphGate(impact: GraphImpact, policy: GraphGatePolicy): GraphGateVerdict {
  if (policy.action === "off" || !impact.available) {
    return { pass: true, reason: "gate desligado", blocked: false };
  }
  const reasons: string[] = [];
  if (policy.blockOnGodNode && impact.godNodesTouched.length > 0) {
    reasons.push(`toca ${impact.godNodesTouched.length} god node(s): ${impact.godNodesTouched.join(", ")}`);
  }
  if (policy.maxCommunities > 0 && impact.communitiesTouched.length > policy.maxCommunities) {
    reasons.push(`toca ${impact.communitiesTouched.length} comunidades (limite ${policy.maxCommunities})`);
  }
  if (policy.blockOnAmbiguous && impact.ambiguousEdgesTouched.length > 0) {
    reasons.push(`toca ${impact.ambiguousEdgesTouched.length} aresta(s) AMBIGUOUS (acoplamento incerto)`);
  }
  const triggered = reasons.length > 0;
  const reason = triggered ? reasons.join("; ") : "estrutura ok";
  if (policy.action === "warn") {
    return { pass: true, reason, blocked: false };
  }
  // block
  return { pass: !triggered, reason, blocked: triggered };
}

// ═══ F4 — O LOOP DE APRENDIZADO CONTÍNUO ══════════════════════════════════════════════
//
// O sistema aprende com o grafo e melhora a cada ciclo: trabalho dos agentes → rebuild do
// grafo (a) → grafo mais limpo (b: ambiguidades viram sub-tasks) + dívida sinalizada (c: god
// nodes emergentes) → próximas decisões do Arquiteto (F1) e gates (F3) melhores → repete.

// ── F4a — REBUILD debounced no turn-done (espelho EXATO do scheduleReindex do OmniFS) ──────
//
// Quando um agente (OmniAgent ou terminal) termina um turno, agendamos um rebuild do grafo —
// o knowledge graph nunca fica velho sem custar um turno do agente. Debounce module-level: uma
// RAJADA de turnos (vários agentes terminando junto) coalesce num único rebuild ao fim da janela
// de silêncio. Janela MAIOR que a do OmniFS (90s vs 60s): `graphify update` re-extrai a AST e
// re-clusteriza (Leiden), bem mais caro que o reindex do OmniFS. Fire-and-forget: nunca lança
// pro chamador. O gate (graphify disponível + grafo no disco) é BARATO e vive no comando Rust
// `graphify_rebuild`, que devolve [] no-op se algum faltar.

/** Um god node (função-hub) que EMERGIU no rebuild (espelha o `GodNodeAlert` do Rust). */
export interface GodNodeAlert {
  label: string;
  degree: number;
}

function hasTauriRebuild(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

/** Roda `graphify update <cwd>` e devolve os god nodes EMERGENTES (dívida). Sem Tauri / cwd
 *  vazio → [] (o comando Rust já gateia barato: graphify indisponível ou sem grafo = no-op). */
export async function graphifyRebuild(cwd: string): Promise<GodNodeAlert[]> {
  if (!hasTauriRebuild() || !cwd.trim()) return [];
  return invoke<GodNodeAlert[]>("graphify_rebuild", { cwd });
}

/** Janela de silêncio antes de disparar o rebuild do grafo (ms). Ver comentário acima. */
const GRAPH_REBUILD_DEBOUNCE_MS = 90_000;
let rebuildTimer: ReturnType<typeof setTimeout> | null = null;

/** Agenda um rebuild do grafo de código após {@link GRAPH_REBUILD_DEBOUNCE_MS} de silêncio.
 *  Cada chamada CANCELA o timer anterior (debounce). No disparo, o comando Rust re-checa BARATO
 *  (graphify disponível + grafo no disco) antes de rodar o build caro — sem grafo, no-op. Ao
 *  terminar, notifica cada god node EMERGENTE como dívida (F4c). Fire-and-forget: nunca lança
 *  pro chamador (rebuild é best-effort, não pode travar o turn-done). */
export function scheduleGraphRebuild(cwd: string): void {
  if (!cwd) return;
  if (rebuildTimer) clearTimeout(rebuildTimer);
  rebuildTimer = setTimeout(() => {
    rebuildTimer = null;
    void (async () => {
      try {
        const emergent = await graphifyRebuild(cwd);
        // F4c — god node emergente = alerta de dívida (mesmo canal notify do Sidebar).
        for (const g of emergent) {
          void notify(
            `⚠️ ${g.label} virou um hub (${g.degree} conexões) — considere refatorar`,
            "info",
          );
        }
      } catch {
        /* rebuild é best-effort — silêncio total */
      }
    })();
  }, GRAPH_REBUILD_DEBOUNCE_MS);
}

// ── F4b — Arestas AMBIGUOUS → sub-tasks automáticas (o grafo se AUTO-LIMPA) ─────────────────
//
// Cada aresta AMBIGUOUS (acoplamento incerto) é uma pergunta em aberto sobre a arquitetura.
// Em vez de deixá-las apodrecendo, o usuário/Orquestrador pede "limpar o grafo" e criamos UM
// subagente que confirma/nega as relações no código. Confirmadas → promovem a EXTRACTED no
// próximo rebuild (a). É o motor que fecha o loop: menos incerteza a cada ciclo.

/** Uma aresta AMBIGUOUS pronta pra virar sub-task (labels legíveis das duas pontas). */
export interface AmbiguousPair {
  source: string;
  target: string;
}

/** Extrai as top-K arestas AMBIGUOUS "mais surpreendentes" do graph.json cru. Critério (reusa
 *  a heurística de 'surprising connection' do importer da F2): arestas que CRUZAM comunidades
 *  vêm primeiro (acoplamento inesperado entre clusters distintos), desempate pelo grau somado
 *  das pontas (hubs incertos importam mais). PURA/testável; sem grafo/sem AMBIGUOUS → []. */
export function topAmbiguousEdges(graph: GraphJson, k: number): AmbiguousPair[] {
  const rawNodes: GraphNodeRaw[] = Array.isArray(graph.nodes) ? graph.nodes : [];
  const rawLinks: GraphEdgeRaw[] = Array.isArray(graph.links)
    ? graph.links
    : Array.isArray(graph.edges)
      ? graph.edges
      : [];

  const label = new Map<string, string>();
  const community = new Map<string, string>();
  for (const n of rawNodes) {
    if (!n || typeof n.id !== "string") continue;
    label.set(n.id, (n.label || n.name || n.id).toString());
    const c = n.community ?? n.community_name;
    if (c !== undefined && c !== null && c !== "") community.set(n.id, String(c));
  }

  const degree = new Map<string, number>();
  for (const e of rawLinks) {
    if (!e || typeof e.source !== "string" || typeof e.target !== "string") continue;
    degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
    degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
  }

  const scored = rawLinks
    .filter(
      (e) =>
        e &&
        typeof e.source === "string" &&
        typeof e.target === "string" &&
        String(e.confidence ?? "").toUpperCase() === "AMBIGUOUS",
    )
    .map((e) => {
      const s = e.source as string;
      const t = e.target as string;
      const cross = community.get(s) !== community.get(t) ? 1 : 0;
      const deg = (degree.get(s) ?? 0) + (degree.get(t) ?? 0);
      return { s, t, cross, deg };
    });
  // Cross-community desc, depois grau somado desc (as mais impactantes primeiro).
  scored.sort((a, b) => b.cross - a.cross || b.deg - a.deg);

  const seen = new Set<string>();
  const out: AmbiguousPair[] = [];
  for (const { s, t } of scored) {
    const src = label.get(s) ?? s;
    const tgt = label.get(t) ?? t;
    const key = `${src} ${tgt}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ source: src, target: tgt });
    if (out.length >= k) break;
  }
  return out;
}

/** Monta o prompt do subagente "resolver ambiguidades": lista as arestas incertas e manda
 *  confirmar/negar cada uma NO CÓDIGO, com evidência. PURA — a UI só injeta o retorno no
 *  `.claude/agents/<slug>.md` (via subagent_write) e no nó do canvas (via addSubagent). */
export function buildAmbiguityResolverBrief(edges: AmbiguousPair[]): string {
  const list = edges.map((e, i) => `${i + 1}. ${e.source} → ${e.target}`).join("\n");
  return (
    "Você é o subagente RESOLVER AMBIGUIDADES do grafo de código (Graphify). O knowledge graph " +
    "marcou estas relações arquiteturais como AMBIGUOUS (acoplamento incerto):\n" +
    `${list}\n\n` +
    "Para CADA par A → B: verifique NO CÓDIGO-FONTE se A realmente depende de B (import, chamada, " +
    "herança, uso de tipo). Use a Serena (find_symbol / find_referencing_symbols) pra navegar em " +
    "vez de grep cego. Documente o veredito de CADA par: CONFIRMA (com evidência arquivo:linha) ou " +
    "NEGA (por quê). Ao terminar, grave o resultado com memory_remember pro próximo rebuild do grafo " +
    "promover as relações CONFIRMADAS de AMBIGUOUS → EXTRACTED. NÃO altere código: só investigue e " +
    "documente — este subagente limpa o grafo, não refatora."
  );
}
