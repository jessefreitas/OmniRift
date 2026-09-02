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

export interface StoreWriteCounts {
  position: number;
  size: number;
  remove: number;
  total: number;
}

let positionWrites = 0;
let sizeWrites = 0;
let removeWrites = 0;

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
  };
}

/**
 * Zera todos os contadores de escrita no store.
 */
export function resetStoreWrites(): void {
  positionWrites = 0;
  sizeWrites = 0;
  removeWrites = 0;
}

/**
 * Calcula a diferença entre dois snapshots de escrita.
 *
 * Faz a diferença campo a campo com piso em 0 (nunca negativo).
 * Se o contador for reiniciado no meio, evita diagnósticos absurdos.
 * O campo `total` é sempre a soma dos três deltas calculados.
 */
export function storeWritesSince(
  before: StoreWriteCounts,
  after: StoreWriteCounts,
): StoreWriteCounts {
  const position = Math.max(0, after.position - before.position);
  const size = Math.max(0, after.size - before.size);
  const remove = Math.max(0, after.remove - before.remove);
  return {
    position,
    size,
    remove,
    total: position + size + remove,
  };
}

/**
 * Formata a linha de evidência para o debug.log no formato canônico:
 * [<iso>] [📐 BENCH-WRITES] gestures=<n> position=<n> size=<n> remove=<n> total=<n>
 *
 * Determinística: mesma entrada produz estritamente a mesma string.
 */
export function formatStoreWritesLine(
  iso: string,
  gestures: number,
  counts: StoreWriteCounts,
): string {
  return `[${iso}] [${BENCH_WRITES_TAG}] gestures=${gestures} position=${counts.position} size=${counts.size} remove=${counts.remove} total=${counts.total}`;
}
