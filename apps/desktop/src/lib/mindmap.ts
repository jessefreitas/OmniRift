// src/lib/mindmap.ts
//
// Constrói um mapa mental (estilo NotebookLM) a partir de JSON, XML ou HTML:
// detecta o formato, parseia numa árvore de nós, e faz o layout left-to-right
// (x = profundidade, y centralizado nos filhos). O React Flow desenha as curvas
// bezier + pan/zoom; o colapsar é por estado (Set de ids colapsados).

export type MindKind = "root" | "branch" | "leaf";

export interface MindTree {
  nodes: Record<string, { id: string; label: string; kind: MindKind; children: string[] }>;
  rootId: string;
  format: "json" | "xml" | "html";
}

function leafText(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

function buildJson(tree: MindTree, value: unknown, key: string | null, depth: number, nextId: () => string): string {
  const id = nextId();
  const isObj = value !== null && typeof value === "object";
  if (!isObj) {
    tree.nodes[id] = { id, label: `${key !== null ? key + ": " : ""}${leafText(value)}`, kind: "leaf", children: [] };
    return id;
  }
  const isArr = Array.isArray(value);
  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const bracket = isArr ? `[${entries.length}]` : `{${entries.length}}`;
  const label = key !== null ? `${key} ${bracket}` : bracket;
  const children: string[] = [];
  tree.nodes[id] = { id, label, kind: depth === 0 ? "root" : "branch", children };
  for (const [ck, cv] of entries) {
    children.push(buildJson(tree, cv, isArr ? `[${ck}]` : ck, depth + 1, nextId));
  }
  return id;
}

function buildDom(tree: MindTree, el: Element, depth: number, nextId: () => string): string {
  const id = nextId();
  const kids = Array.from(el.children);
  const attrs = Array.from(el.attributes)
    .map((a) => `${a.name}="${a.value.length > 24 ? a.value.slice(0, 24) + "…" : a.value}"`)
    .join(" ");
  const text = kids.length === 0 ? (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 40) : "";
  const label = `<${el.tagName.toLowerCase()}${attrs ? " " + attrs : ""}>${text ? " " + text : ""}`;
  const children: string[] = [];
  tree.nodes[id] = { id, label, kind: depth === 0 ? "root" : kids.length ? "branch" : "leaf", children };
  for (const c of kids) children.push(buildDom(tree, c, depth + 1, nextId));
  return id;
}

/** Detecta JSON/XML/HTML e devolve a árvore, ou um erro. */
export function buildTree(text: string): MindTree | { error: string } {
  const t = text.trim();
  if (!t) return { error: "vazio" };
  let counter = 0;
  const nextId = () => `n${counter++}`;

  // JSON primeiro
  try {
    const v = JSON.parse(t);
    const tree: MindTree = { nodes: {}, rootId: "", format: "json" };
    tree.rootId = buildJson(tree, v, null, 0, nextId);
    return tree;
  } catch {
    /* tenta markup */
  }

  // XML / HTML
  try {
    const isHtml = /^<!doctype html|<html[\s>]/i.test(t);
    const doc = new DOMParser().parseFromString(t, isHtml ? "text/html" : "application/xml");
    if (!isHtml && doc.querySelector("parsererror")) return { error: "XML inválido" };
    const root = doc.documentElement;
    if (!root) return { error: "markup vazio" };
    const tree: MindTree = { nodes: {}, rootId: "", format: isHtml ? "html" : "xml" };
    tree.rootId = buildDom(tree, root, 0, nextId);
    return tree;
  } catch (e) {
    return { error: `não é JSON, XML nem HTML válido (${e instanceof Error ? e.message : e})` };
  }
}

export interface FlowNode {
  id: string;
  position: { x: number; y: number };
  label: string;
  kind: MindKind;
  hasChildren: boolean;
  collapsed: boolean;
}
export interface FlowEdge {
  id: string;
  source: string;
  target: string;
}

const X_GAP = 230;
const Y_GAP = 46;

/** Layout left-to-right; respeita os ids colapsados (subárvore some). */
export function layoutTree(tree: MindTree, collapsed: Set<string>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  let cursorY = 0;

  function place(id: string, depth: number): number {
    const n = tree.nodes[id];
    const isCollapsed = collapsed.has(id);
    const kids = isCollapsed ? [] : n.children;
    let y: number;
    if (kids.length === 0) {
      y = cursorY;
      cursorY += Y_GAP;
    } else {
      const ys = kids.map((c) => {
        edges.push({ id: `e-${id}-${c}`, source: id, target: c });
        return place(c, depth + 1);
      });
      y = (ys[0] + ys[ys.length - 1]) / 2;
    }
    nodes.push({
      id,
      position: { x: depth * X_GAP, y },
      label: n.label,
      kind: n.kind,
      hasChildren: n.children.length > 0,
      collapsed: isCollapsed,
    });
    return y;
  }

  place(tree.rootId, 0);
  return { nodes, edges };
}
