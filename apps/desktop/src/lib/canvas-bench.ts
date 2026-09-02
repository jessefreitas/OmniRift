// src/lib/canvas-bench.ts
//
// Orquestrador do harness de benchmark de jank e fluidez do canvas.
// Toda a lógica possui dependências injetadas para permitir execução e testes em Node puro
// sem necessidade de DOM, Tauri ou UI ativa.

import { FLUENCY } from "@/lib/canvas-fluency";
import {
  MEASURE_BEGIN_TAG,
  MEASURE_TICK_TAG,
  MEASURE_END_TAG,
} from "@/lib/canvas-score";
import {
  assertNodesMoved,
  benchSummaryLine,
  planDragGesture,
} from "@/lib/bench-load";

export interface BenchDeps {
  log: (line: string) => void;
  now: () => number;
  loadNodes: (count: number) => string[]; // devolve os ids injetados
  readPositions: (ids: string[]) => Map<string, { x: number; y: number }>;
  dragNode: (id: string, path: { x: number; y: number }[]) => Promise<void> | void;
  sleep: (ms: number) => Promise<void>;
  startTicker: (intervalMs: number, tick: () => void) => () => void; // devolve stop
}

export interface BenchConfig {
  mode: boolean;
  flags: string;
  nodes: number;
  dragSteps: number;
}

const DEFAULT_SUBSET_COUNT = 5;

/**
 * Executa o benchmark determinístico de fluidez do canvas.
 *
 * Regras:
 * - R1: cfg.mode === false => devolve 'skipped' imediatamente sem I/O ou store.
 * - R2: Se nenhum nó se mover, emite motivo, para ticker e devolve 'aborted' (sem MEASURE-END).
 * - R3: Se qualquer etapa lançar exceção: emita motivo, para ticker e devolve 'aborted' (sem MEASURE-END).
 * - R4: O ticker é garantidamente parado em todos os caminhos de saída (done, aborted, exceção).
 * - R5: Ordem estrita dos marcadores: BEGIN -> TICK(s) -> END (quando houver).
 */
export async function runCanvasBench(
  cfg: BenchConfig,
  deps: BenchDeps,
): Promise<"skipped" | "done" | "aborted"> {
  // R1: cfg.mode === false => custo zero em produção
  if (!cfg.mode) {
    return "skipped";
  }

  let stopTicker: (() => void) | null = null;

  try {
    // 1. Injeta nós sintéticos
    const nodeIds = deps.loadNodes(cfg.nodes);
    await deps.sleep(50);

    // 2. Emite MEASURE_BEGIN_TAG no formato canônico [<ISO>] [<TAG>] <detalhe>
    const beginIso = new Date(deps.now()).toISOString();
    deps.log(`[${beginIso}] [${MEASURE_BEGIN_TAG}] nodes=${cfg.nodes} flags=${cfg.flags}`);

    // 3. Liga o ticker com heartbeat comprovando que a medição rodou
    stopTicker = deps.startTicker(FLUENCY.TICK_MS, () => {
      const tickIso = new Date(deps.now()).toISOString();
      deps.log(`[${tickIso}] [${MEASURE_TICK_TAG}] heartbeat`);
    });

    // 4. Lê posições ANTES, arrasta um subconjunto de nós com planDragGesture, lê posições DEPOIS
    const targetCount = Math.min(nodeIds.length, DEFAULT_SUBSET_COUNT);
    const targetIds = nodeIds.slice(0, targetCount);

    const before = deps.readPositions(targetIds);

    for (const id of targetIds) {
      const start = before.get(id) ?? { x: 0, y: 0 };
      const to = { x: start.x + 120, y: start.y + 80 };
      const path = planDragGesture({
        from: start,
        to,
        steps: cfg.dragSteps,
      });

      await deps.dragNode(id, path);
      await deps.sleep(FLUENCY.TICK_MS);
    }

    const after = deps.readPositions(targetIds);

    // 5. Valida movimentação e emite linha de resumo
    const { moved, stuck } = assertNodesMoved(before, after, targetIds);
    deps.log(
      benchSummaryLine({
        nodes: cfg.nodes,
        movedOk: moved.length,
        stuck: stuck.length,
        flags: cfg.flags,
      }),
    );

    // R2: Falso positivo — se nenhum nó se moveu, aborta sem MEASURE_END_TAG
    if (moved.length === 0) {
      const abortIso = new Date(deps.now()).toISOString();
      deps.log(
        `[${abortIso}] [BENCH-ABORT] nenhum nó se moveu após o gesto (stuck=${stuck.length})`,
      );
      if (stopTicker) {
        stopTicker();
        stopTicker = null;
      }
      return "aborted";
    }

    // 6. Emite MEASURE_END_TAG e encerra com sucesso
    const endIso = new Date(deps.now()).toISOString();
    deps.log(`[${endIso}] [${MEASURE_END_TAG}] nodes=${cfg.nodes} movedOk=${moved.length}`);

    if (stopTicker) {
      stopTicker();
      stopTicker = null;
    }
    return "done";
  } catch (err) {
    // R3: Exceção no meio -> emite motivo, para ticker e aborta sem END
    try {
      const errIso = new Date(deps.now()).toISOString();
      const message = err instanceof Error ? err.message : String(err);
      deps.log(`[${errIso}] [BENCH-ABORT] exceção no harness: ${message}`);
    } catch {
      /* logging failure shouldn't mask abort */
    }
    // O ticker e' parado no `finally` logo abaixo (R4) — repetir aqui deixaria
    // uma atribuicao morta e um bloco vazio que o eslint (com razao) recusa.
    return "aborted";
  } finally {
    // R4: Ticker parado em todos os caminhos
    if (stopTicker) {
      try {
        stopTicker();
      } catch {
        // Parar o ticker nunca pode mascarar o resultado da rodada: se o proprio
        // stop falhar, a medicao ja acabou e o veredito e' o que importa.
      }
      // Sem `stopTicker = null` aqui: a funcao retorna em seguida e a atribuicao
      // morreria sem ser lida.
    }
  }
}
