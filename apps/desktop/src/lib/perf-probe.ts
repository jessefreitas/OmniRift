/**
 * perf-probe.ts
 *
 * Módulo puro de evidências de performance para o watchdog da main thread.
 *
 * MOTIVAÇÃO REAL:
 * - O app congela entre 0,9s e 9,7s com ~11 terminais ativos.
 * - O watchdog atual registra apenas "main thread parada ~Nms", sem contexto.
 *   Isso tem dois furos graves:
 *     1. Não distingue fase: um bloqueio de 2s no boot é esperado; o mesmo
 *        bloqueio com o canvas renderizado é o bug.
 *     2. Não trata janela oculta: quando minimizada o timer é throttlado pelo
 *        navegador, gerando drift falso e poluindo o debug.log.
 * - Além disso, suspeitamos de custo O(N²) no Tauri: cada TerminalNode instala
 *   seu próprio listener global e filtra na borda. Medir listeners, views e
 *   eventos é pré-requisito para decidir a reescrita.
 *
 * DECISÕES:
 * - Tudo é estado de módulo puro; nada de React/setState aqui.
 * - Sem dependências externas (funciona no front WebKitGTK e em Node para testes).
 * - Eventos usam 10 buckets fixos de 100ms: zero objetos/splice por frame e
 *   memória constante, porque a própria medição não pode criar jank.
 * - Contadores nunca ficam negativos (piso em 0), evitando diagnósticos absurdos.
 * - perfSnapshot aceita `now` injetado para testes determinísticos.
 */

let currentAppPhase: AppPhase = "boot";

export type AppPhase = "boot" | "intro" | "canvas";

export function setPhase(p: AppPhase): void {
  currentAppPhase = p;
}

export function currentPhase(): AppPhase {
  return currentAppPhase;
}

export type TickVerdict =
  | { kind: "ok" }
  | { kind: "ignored"; reason: "hidden" | "phase-boot" }
  | { kind: "block"; driftMs: number; phase: AppPhase };

/**
 * Classifica uma amostra do watchdog.
 *
 * ORDEM DAS REGRAS importa:
 * 1. hidden === true -> ignored/hidden (throttling de background cria drift
 *    artificial; não é evidência de congelamento real).
 * 2. phase === "boot" -> ignored/phase-boot (o boot é intencionalmente bloqueante;
 *    misturar isso com canvas/intro mascara o bug real).
 * 3. drift >= warnMs -> block (com a fase junto, para saber onde olhar).
 * 4. else -> ok.
 */
export function classifyTick(args: {
  driftMs: number;
  hidden: boolean;
  phase: AppPhase;
  warnMs: number;
}): TickVerdict {
  if (args.hidden) {
    return { kind: "ignored", reason: "hidden" };
  }

  if (args.phase === "boot") {
    return { kind: "ignored", reason: "phase-boot" };
  }

  if (args.driftMs >= args.warnMs) {
    return {
      kind: "block",
      driftMs: args.driftMs,
      phase: args.phase,
    };
  }

  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// Contadores de eventos com janela deslizante
// ---------------------------------------------------------------------------

type EventKind = "pty" | "acp";

type EventBucket = {
  /** índice monotônico do intervalo de 100ms armazenado neste slot */
  tick: number;
  count: number;
  bytes: number;
};

const BUCKET_MS = 100;
const BUCKET_COUNT = 10;

function makeBuckets(): EventBucket[] {
  return Array.from(
    { length: BUCKET_COUNT },
    () => ({ tick: Number.NEGATIVE_INFINITY, count: 0, bytes: 0 }),
  );
}

const eventBuckets: Record<EventKind, EventBucket[]> = {
  pty: makeBuckets(),
  acp: makeBuckets(),
};

let listenerCount = 0;
let mountedViewCount = 0;

function perfNow(): number {
  // globalThis.performance existe tanto no front (WebKitGTK) quanto em Node
  // moderno, mantendo a mesma unidade para testes.
  return globalThis.performance.now();
}

function tickAt(now: number): number {
  return Math.floor(now / BUCKET_MS);
}

function slotFor(tick: number): number {
  return ((tick % BUCKET_COUNT) + BUCKET_COUNT) % BUCKET_COUNT;
}

/**
 * Contabiliza um evento do tipo pty ou acp, com seus bytes.
 *
 * POR QUÊ: "pty" representa dados vindos do pseudo-terminal; "acp" representa
 * eventos do canal ACP/Tauri. Separar permite ver se o gargalo é tráfego de
 * terminal bruto ou envelope de eventos global.
 */
export function countEvent(kind: "pty" | "acp", bytes: number): void {
  const now = perfNow();
  const tick = tickAt(now);
  const bucket = eventBuckets[kind][slotFor(tick)];
  if (bucket.tick !== tick) {
    bucket.tick = tick;
    bucket.count = 0;
    bucket.bytes = 0;
  }
  bucket.count++;
  bucket.bytes += Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
}

/**
 * Incrementa/decrementa o número de listeners globais ativos.
 *
 * POR QUÊ: queremos confirmar a suspeita de que cada TerminalNode registra seu
 * próprio listener Tauri, crescendo linearmente com N e custando O(N²) na
 * entrega. delta negativo é permitido, mas o valor final nunca fica negativo.
 */
export function countListener(delta: 1 | -1): void {
  listenerCount = Math.max(0, listenerCount + delta);
}

/**
 * Incrementa/decrementa o número de views montadas.
 *
 * POR QUÊ: listeners e views não são 1:1 (um view pode registrar vários
 * listeners); comparar os dois revela se estamos criando ouvintes em excesso.
 */
export function countMountedView(delta: 1 | -1): void {
  mountedViewCount = Math.max(0, mountedViewCount + delta);
}

export interface PerfSnapshot {
  phase: AppPhase;
  eventsPerSec: { pty: number; acp: number };
  bytesPerSec: { pty: number; acp: number };
  listeners: number;
  mountedViews: number;
}

/**
 * Retorna o estado de performance atual.
 *
 * POR QUÊ: sem `now`, usa performance.now(); aceitar `now` injetado torna os
 * testes determinísticos sem precisar mockar timers.
 *
 * As taxas são contagens dentro da janela de 1s. Como a janela tem exatamente
 * 1s de duração, a contagem já representa eventos/segundo e bytes/segundo.
 */
export function perfSnapshot(now?: number): PerfSnapshot {
  const t = now ?? perfNow();
  const nowTick = tickAt(t);

  const sum = (kind: EventKind): { count: number; bytes: number } => {
    let count = 0;
    let bytes = 0;
    for (const bucket of eventBuckets[kind]) {
      const age = nowTick - bucket.tick;
      if (age >= 0 && age < BUCKET_COUNT) {
        count += bucket.count;
        bytes += bucket.bytes;
      }
    }
    return { count, bytes };
  };
  const pty = sum("pty");
  const acp = sum("acp");

  return {
    phase: currentAppPhase,
    eventsPerSec: {
      pty: pty.count,
      acp: acp.count,
    },
    bytesPerSec: {
      pty: pty.bytes,
      acp: acp.bytes,
    },
    listeners: listenerCount,
    mountedViews: mountedViewCount,
  };
}

/**
 * Formata bytes de forma humana.
 *
 * POR QUÊ: o debug.log do watchdog é lido por humanos; "38912B/s" é ruim.
 * Queremos algo como "38KB/s".
 */
function formatBytes(n: number): string {
  if (n < 1024) {
    return `${n}B`;
  }
  if (n < 1024 * 1024) {
    return `${Math.round(n / 1024)}KB`;
  }
  return `${(n / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Gera uma linha curta para o debug.log.
 *
 * Exemplo: "fase=canvas pty=142/s 38KB/s acp=3/s listeners=11 views=24"
 *
 * POR QUÊ: o watchdog precisa de contexto ao registrar um bloqueio. Uma linha
 * sócia permite correlacionar congelamento, fase, tráfego de terminal,
 * envelope de eventos e número de listeners/views.
 */
export function perfContextLine(snap: PerfSnapshot): string {
  return [
    `fase=${snap.phase}`,
    `pty=${snap.eventsPerSec.pty}/s ${formatBytes(snap.bytesPerSec.pty)}/s`,
    `acp=${snap.eventsPerSec.acp}/s ${formatBytes(snap.bytesPerSec.acp)}/s`,
    `listeners=${snap.listeners}`,
    `views=${snap.mountedViews}`,
  ].join(" ");
}
