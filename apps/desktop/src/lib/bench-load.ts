// src/lib/bench-load.ts
//
// Harness de carga sintética do canvas — lógica PURA para estresse e benchmark de fluidez.
// Sem React, Tauri, DOM ou I/O: roda em Node puro no gate de fluidez e no benchmark.
//
// Por que nós de comunidade (CommunityNode)?
// São nós estáticos e leves no canvas, ideais para medir o custo de renderização, virtualização
// e sincronização de arrasto sem o ruído ou overhead de processos de terminal ou I/O.

import type { CanvasNode, CommunityNode } from "@/types/canvas";

export const BENCH_LOAD_TAG = "BENCH-LOAD";

/**
 * Gera nós sintéticos do tipo 'community' em grade determinística para importCommunityNodes.
 *
 * Por que determinístico?
 * Para que benchmarks comparativos (OFF vs ON) operem exatamente sobre a mesma carga geométrica
 * e topológica, eliminando flutuações causadas por números aleatórios ou timestamps dinâmicos.
 */
export function makeSyntheticNodes(
  count: number,
  opts?: {
    cols?: number;
    gapX?: number;
    gapY?: number;
    prefix?: string;
  },
): CanvasNode[] {
  // Entradas não-inteiras, NaN, Infinity ou menores/iguais a zero devolvem array vazio sem lançar
  if (!Number.isInteger(count) || count <= 0) {
    return [];
  }

  const cols = opts?.cols && opts.cols > 0 ? opts.cols : 10;
  const gapX = opts?.gapX ?? 300;
  const gapY = opts?.gapY ?? 200;
  const prefix = opts?.prefix ?? "bench-";

  const nodes: CanvasNode[] = [];

  for (let i = 0; i < count; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);

    const node: CommunityNode = {
      id: `${prefix}${i}`,
      kind: "community",
      name: `Community ${i}`,
      memberCount: 1,
      godNodes: [],
      topMembers: [],
      fileCount: 1,
      color: "#a78bfa",
      // Timestamp fixo para preservar determinismo absoluto entre rodadas
      createdAt: 0,
      position: {
        x: col * gapX,
        y: row * gapY,
      },
      size: { width: 260, height: 150 },
    };

    nodes.push(node);
  }

  return nodes;
}

/**
 * Planeja uma trajetória de arrasto dividida em passos determinísticos.
 *
 * Por que o último ponto precisa ser exatamente 'to'?
 * Se o gesto acumular erro de ponto flutuante na interpolação e não atingir a coordenada exata
 * de destino, a validação de movimentação dos nós pode falhar, invalidando todo o benchmark.
 */
export function planDragGesture(args: {
  from: { x: number; y: number };
  to: { x: number; y: number };
  steps: number;
}): { x: number; y: number }[] {
  const steps = Math.floor(args.steps);
  if (!Number.isFinite(steps) || steps <= 0) {
    return [{ x: args.to.x, y: args.to.y }];
  }

  const points: { x: number; y: number }[] = [];
  const dx = args.to.x - args.from.x;
  const dy = args.to.y - args.from.y;

  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    points.push({
      x: args.from.x + dx * t,
      y: args.from.y + dy * t,
    });
  }

  // O último ponto tem que ser EXATAMENTE 'to' sem resíduo de float
  points.push({ x: args.to.x, y: args.to.y });
  return points;
}

/**
 * Compara as posições antes e depois de um gesto para atestar quais nós realmente se moveram.
 *
 * Por que esta validação é crítica?
 * Um gesto simulado que não move nada resultaria em zero re-renders e zero jank, criando um
 * falso verde enganoso. Identificar nós 'stuck' garante que os handlers do canvas foram de fato
 * exercitados durante a medição.
 */
export function assertNodesMoved(
  before: Map<string, { x: number; y: number }>,
  after: Map<string, { x: number; y: number }>,
  ids: string[],
): { moved: string[]; stuck: string[] } {
  const moved: string[] = [];
  const stuck: string[] = [];

  for (const id of ids) {
    const b = before.get(id);
    const a = after.get(id);

    // Se o nó não existia antes, ou não existe depois, ou manteve as mesmas coordenadas
    if (!b || !a || (a.x === b.x && a.y === b.y)) {
      stuck.push(id);
    } else {
      moved.push(id);
    }
  }

  return { moved, stuck };
}

/**
 * Formata uma linha determinística para registro no debug.log, permitindo auditoria entre rodadas.
 */
export function benchSummaryLine(args: {
  nodes: number;
  movedOk: number;
  stuck: number;
  flags: string;
}): string {
  return `[${BENCH_LOAD_TAG}] nodes=${args.nodes} movedOk=${args.movedOk} stuck=${args.stuck} flags=${args.flags}`;
}
