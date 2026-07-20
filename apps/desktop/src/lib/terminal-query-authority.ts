// Política pura da autoridade de OSC 10/11.
//
// O xterm precisa continuar processando a sequência inteira para aplicar SETs
// empilhados. Nós apenas marcamos as respostas automáticas de QUERY que devem ser
// descartadas antes de chegar ao PTY, pois o backend já é o respondedor autoritativo.

export type BackendOwnedColorCode = 10 | 11;

/**
 * Lista as queries de cor pertencentes ao backend, interpretando cada parâmetro pela
 * posição. OSC 10 empilha foreground, background e cursor; OSC 11 começa em background.
 */
export function backendOwnedColorQueries(
  osc: 10 | 11,
  data: string,
): BackendOwnedColorCode[] {
  const queries: BackendOwnedColorCode[] = [];

  for (const [index, parameter] of data.split(";").entries()) {
    const colorCode = osc + index;
    if (colorCode > 12) break;
    if (parameter === "?" && (colorCode === 10 || colorCode === 11)) {
      queries.push(colorCode);
    }
  }

  return queries;
}

const XTERM_COLOR_REPLY = /^\x1b\](10|11);rgb:[0-9a-f]{4}\/[0-9a-f]{4}\/[0-9a-f]{4}(?:\x07|\x1b\\)$/i;

/**
 * Consome somente uma resposta OSC 10/11 que tenha sido anunciada por uma query
 * imediatamente processada pelo xterm. Input comum (inclusive texto parecido) passa.
 */
export function consumeExpectedXtermColorReply(
  pending: BackendOwnedColorCode[],
  data: string,
): boolean {
  const match = XTERM_COLOR_REPLY.exec(data);
  if (!match) return false;

  const code = Number(match[1]) as BackendOwnedColorCode;
  const index = pending.indexOf(code);
  if (index < 0) return false;

  pending.splice(index, 1);
  return true;
}

interface Disposable {
  dispose: () => void;
}

interface TerminalQueryAuthorityPort {
  parser: {
    registerOscHandler: (
      ident: number,
      callback: (data: string) => boolean | Promise<boolean>,
    ) => Disposable;
  };
  onData: (callback: (data: string) => void) => Disposable;
}

export interface TerminalQueryAuthority {
  setForwarder: (forwarder: ((data: string) => void) | null) => void;
  dispose: () => void;
}

/** Instala o gate completo usado pela view, mantendo a API pequena e testável sem DOM. */
export function installTerminalQueryAuthority(
  terminal: TerminalQueryAuthorityPort,
): TerminalQueryAuthority {
  const pending: BackendOwnedColorCode[] = [];
  let forwarder: ((data: string) => void) | null = null;

  const handlers = ([10, 11] as const).map((osc) =>
    terminal.parser.registerOscHandler(osc, (data) => {
      pending.push(...backendOwnedColorQueries(osc, data));
      // Fallthrough é essencial: o builtin aplica todos os SETs da sequência.
      return false;
    }),
  );

  const data = terminal.onData((value) => {
    if (consumeExpectedXtermColorReply(pending, value)) return;
    forwarder?.(value);
  });

  return {
    setForwarder(value) {
      forwarder = value;
    },
    dispose() {
      forwarder = null;
      data.dispose();
      for (const handler of handlers) handler.dispose();
    },
  };
}
