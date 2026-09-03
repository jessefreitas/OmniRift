/**
 * store-writes.ts
 *
 * Módulo puro de medição de trabalho direto do canvas (escritas no store).
 *
 * MOTIVAÇÃO REAL:
 * O harness original media JANK (bloqueios da main thread) como proxy de fluidez.
 * Isso é frágil: depende do aquecimento da CPU, duração da janela e custo de renderização
 * de cada nó. Em testes reais, o resultado foi ambíguo.
 *
 * A flag `drag-commit-on-end` ataca diretamente as escritas no store durante o arrasto:
 * - flag OFF: para CADA micro-mudança de posição, chama updateNodePosition (dezenas de escritas/s).
 * - flag ON: acumula no DragBuffer e chama updateNodePosition apenas no commit do fim do gesto.
 *
 * Contar o TRABALHO REAL (escritas no store por gesto) é uma métrica honesta,
 * determinística e imune a timing, temperatura de máquina e duração de janela.
 *
 * DECISÕES:
 * - Estado de módulo puro: sem React, sem Tauri, sem I/O.
 * - Memória constante e zero alocações no caminho quente de contagem: countStoreWrite
 *   apenas incrementa variáveis inteiras em memória de módulo.
 * - storeWriteSnapshot retorna uma cópia defensiva para evitar contaminação externa.
 * - storeWritesSince calcula a diferença campo a campo com piso em 0 (Math.max(0, ...)),
 *   evitando números negativos caso haja reset no meio da medição.
 * - total é sempre a soma estrita dos três tipos de escrita (position + size + remove).
 * - formatStoreWritesLine gera linha determinística no formato canônico do debug.log.
 */

export const BENCH_WRITES_TAG = "📐 BENCH-WRITES";

export type StoreWriteKind = "position" | "size" | "remove";

/**
 * Fases de um evento de arrasto de nó (NodePositionChange).
 *
 * CERNE DO DIAGNÓSTICO DA ANOMALIA (508 vs 243 escritas no store):
 * Com 500 nós (K=4), o modo OFF manteve-se estável em 243 escritas nas 4 rodadas,
 * enquanto o modo ON produziu uma série bimodal [508, 8, 8, 8].
 * O `absorb` do DragBuffer só bufferiza quando `change.dragging === true`; qualquer
 * outro valor — inclusive o campo AUSENTE (undefined) — cai no else e commita na hora.
 *
 * Contar eventos por fase separa com precisão as duas hipóteses concorrentes:
 * 1. O React Flow omitiu o campo (`unknown`), fazendo o buffer degradar silenciosamente.
 * 2. O WebKitGTK gerou uma rajada maior de eventos de ponteiro naquela passada.
 *
 * Semântica estrita:
 * - "dragging": change trouxe `dragging === true` explicitamente.
 * - "settled":  trouxe `dragging === false` explicitamente (fim de gesto legítimo).
 * - "unknown":  campo `dragging` veio AUSENTE (undefined / omitido pelo React Flow).
 *
 * Jamais juntar `settled` com `unknown`: essa fusão destruiria o diagnóstico.
 */
export type DragPhase = "dragging" | "settled" | "unknown";

export interface StoreWriteCounts {
  position: number;
  size: number;
  remove: number;
  total: number;
  dragging?: number;
  settled?: number;
  unknown?: number;
}

let positionWrites = 0;
let sizeWrites = 0;
let removeWrites = 0;
let draggingChanges = 0;
let settledChanges = 0;
let unknownChanges = 0;

/**
 * Contabiliza uma escrita direta no store pelo seu tipo.
 *
 * Caminho quente: deve ser estritamente incremento de inteiro sem nenhuma alocação
 * de objeto ou chamada de log para que a medição não crie o jank que mede.
 */
export function countStoreWrite(kind: StoreWriteKind): void {
  switch (kind) {
    case "position":
      positionWrites++;
      break;
    case "size":
      sizeWrites++;
      break;
    case "remove":
      removeWrites++;
      break;
  }
}

/**
 * Contabiliza a ocorrência de um change de posição pela sua fase de arrasto.
 *
 * Caminho quente: estritamente incremento de inteiro puro em memória de módulo,
 * sem alocações ou logs, preservando a fluidez da main thread durante a medição.
 */
export function countDragChange(phase: DragPhase): void {
  switch (phase) {
    case "dragging":
      draggingChanges++;
      break;
    case "settled":
      settledChanges++;
      break;
    case "unknown":
      unknownChanges++;
      break;
  }
}

/**
 * Retorna uma cópia independente dos contadores acumulados até o momento.
 *
 * Mutar o objeto retornado não altera o estado interno do módulo.
 */
export function storeWriteSnapshot(): StoreWriteCounts {
  return {
    position: positionWrites,
    size: sizeWrites,
    remove: removeWrites,
    total: positionWrites + sizeWrites + removeWrites,
    dragging: draggingChanges,
    settled: settledChanges,
    unknown: unknownChanges,
  };
}

/**
 * Zera todos os contadores de escrita no store e de fases de arrasto.
 */
export function resetStoreWrites(): void {
  positionWrites = 0;
  sizeWrites = 0;
  removeWrites = 0;
  draggingChanges = 0;
  settledChanges = 0;
  unknownChanges = 0;
}

/**
 * Calcula a diferença entre dois snapshots de escrita e fases de arrasto.
 *
 * Faz a diferença campo a campo com piso em 0 (nunca negativo).
 * Se o contador for reiniciado no meio, evita diagnósticos absurdos.
 * O campo `total` é sempre a soma estrita dos três tipos de escrita (position + size + remove).
 */
export function storeWritesSince(
  before: StoreWriteCounts,
  after: StoreWriteCounts,
): StoreWriteCounts {
  const position = Math.max(0, after.position - before.position);
  const size = Math.max(0, after.size - before.size);
  const remove = Math.max(0, after.remove - before.remove);
  const dragging = Math.max(0, (after.dragging ?? 0) - (before.dragging ?? 0));
  const settled = Math.max(0, (after.settled ?? 0) - (before.settled ?? 0));
  const unknown = Math.max(0, (after.unknown ?? 0) - (before.unknown ?? 0));
  return {
    position,
    size,
    remove,
    total: position + size + remove,
    dragging,
    settled,
    unknown,
  };
}

/**
 * Formata a linha de evidência para o debug.log no formato canônico:
 * [<iso>] [📐 BENCH-WRITES] gestures=<n> position=<n> size=<n> remove=<n> total=<n> dragging=<n> settled=<n> unknown=<n>
 *
 * Determinística: mesma entrada produz estritamente a mesma string.
 */
export function formatStoreWritesLine(
  iso: string,
  gestures: number,
  counts: StoreWriteCounts,
): string {
  const dragging = counts.dragging ?? 0;
  const settled = counts.settled ?? 0;
  const unknown = counts.unknown ?? 0;
  return `[${iso}] [${BENCH_WRITES_TAG}] gestures=${gestures} position=${counts.position} size=${counts.size} remove=${counts.remove} total=${counts.total} dragging=${dragging} settled=${settled} unknown=${unknown}`;
}
