// Dedup de input IME no caminho xterm → PTY (WebKitGTK + IBus no Linux).
//
// Dois modos de duplicata observados:
// 1) Dead-key (´+a → á): compositionend + evento `input` seguinte emitem o MESMO
//    char. A dedup interna do xterm (`_isSendingComposition` + setTimeout 0)
//    perde a corrida nesse motor.
// 2) Tecla direta ABNT2 (ç): UM keydown gera DUAS emissões onData SEM passar por
//    compositionend — o guard (1) não pega; o keySeq pega.
//
// Safe-by-construction: em motores sem o bug nunca há 2ª cópia → no-op, nunca
// apaga caractere legítimo.

export const IME_COMPOSE_DEDUP_MS = 60;

export interface ImeDedup {
  /** Marca o fim de uma composição (dead-key). `data` vem de CompositionEvent.data. */
  noteCompositionEnd(data: string, now?: number): void;
  /** Conta uma tecla de 1 code point (keydown). Teclas especiais não chamam. */
  noteCharKeyDown(): void;
  /** true → encaminhar ao PTY; false → duplicata IBus, dropar. */
  shouldForward(data: string, now?: number): boolean;
}

export interface ImeDedupOptions {
  windowMs?: number;
  now?: () => number;
}

/** Tecla que produz 1 code point (distingue "ç" de Enter/Dead/Arrow…). */
export function isCharKey(key: string): boolean {
  return Array.from(key).length === 1;
}

export function createImeDedup(opts: ImeDedupOptions = {}): ImeDedup {
  const windowMs = opts.windowMs ?? IME_COMPOSE_DEDUP_MS;
  const nowFn = opts.now ?? Date.now;

  let composed: { data: string; until: number; seen: boolean } | null = null;
  let keySeq = 0;
  let lastEmit: { data: string; seq: number; until: number } | null = null;

  return {
    noteCompositionEnd(data, now) {
      if (!data) return;
      const t = now ?? nowFn();
      // Se o 1º onData já chegou ANTES do compositionend (ordem input-first /
      // _finalizeComposition síncrono do xterm), marca seen=true pra o eco dropar.
      // Só conta emissão do MESMO keySeq — senão áá legítimo (2º keydown) herdaria
      // seen=true do ciclo anterior ainda dentro da janela.
      // NÃO zerar lastEmit — isso reintroduzia o eco no ordenamento input-first.
      const already = !!(
        lastEmit &&
        lastEmit.data === data &&
        lastEmit.seq === keySeq &&
        t < lastEmit.until
      );
      composed = { data, until: t + windowMs, seen: already };
    },

    noteCharKeyDown() {
      keySeq++;
    },

    shouldForward(data, now) {
      const t = now ?? nowFn();

      // Guard ABNT2 / tecla direta: 2 emissões com o MESMO keySeq na janela = duplicata.
      // Janela evita engolir um 2º char idêntico legítimo depois (keySeq estagnado).
      if (
        lastEmit &&
        lastEmit.data === data &&
        lastEmit.seq === keySeq &&
        t < lastEmit.until
      ) {
        lastEmit = null;
        return false;
      }
      lastEmit = { data, seq: keySeq, until: t + windowMs };

      // Guard dead-key: 1ª cópia na janela passa; 2ª idêntica dropa uma vez.
      if (composed && t >= composed.until) composed = null;
      if (composed && data === composed.data) {
        if (composed.seen) {
          composed = null;
          return false;
        }
        composed.seen = true;
      }
      return true;
    },
  };
}

/**
 * Gate de onChange para inputs React controlados (SafeInput).
 * Durante compositionstart→end o pai NÃO deve receber onChange — re-render
 * no meio do preedit corrompe a composição no WebKitGTK.
 */
export function createCompositionChangeGate() {
  let composing = false;
  return {
    start(): void {
      composing = true;
    },
    /** Libera o gate e indica que o valor commitado deve propagar. */
    end(): void {
      composing = false;
    },
    /** false enquanto o IME está compondo. */
    allowChange(): boolean {
      return !composing;
    },
  };
}
