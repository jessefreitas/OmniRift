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

import { invoke } from "@tauri-apps/api/core";

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
