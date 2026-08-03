/*
 * Determinismo: as contagens de invocações são exatas e reprodutíveis entre execuções.
 * Apenas o tempo (ms) varia, pois depende da carga momentânea da máquina e de otimizações
 * do motor V8/JavaScriptCore.
 *
 * O QUE O NÚMERO PROVA: o ganho teórico e prático de roteamento no próprio broker
 * (1 listener por canal roteando internamente vs N listeners filtrando na borda),
 * reduzindo drasticamente o número de invocações de callback no processo.
 *
 * O QUE ELE NÃO PROVA: não mede jank de renderização no WebKitGTK, não substitui
 * medição na máquina real com a GUI aberta, e não captura custos de serialização
 * ou IPC do Tauri entre processos — apenas o trabalho dentro do runtime Node/WebView.
 */

import {

  subscribeBySession,
  resetEventBrokerForTests,
  setListenImpl,
  setInterestImpl,
} from "./event-broker";
import type { UnlistenFn, ListenImpl } from "./event-broker";

// ─────────────────────────────────────────────────────────────────────────────
// O QUE ESTE NÚMERO DIZ — E O QUE ELE NÃO DIZ
//
// DIZ: o modelo antigo invoca callback uma vez POR NÓ para cada evento; o novo,
// uma vez só. Com 50 sessões são 1.000.000 contra 20.000 invocações. Essa contagem
// é exata e reprodutível.
//
// NÃO DIZ que o app fica N vezes mais rápido. Repare nos tempos: o dispatch em si
// não melhora — o broker até tem overhead fixo maior (Map + roteamento), e o
// callback do modelo antigo é barato (compara uma string e descarta).
//
// O custo real que o broker corta está FORA deste processo: no Tauri, cada
// `listen()` é uma ponte JS↔Rust, e o payload é serializado e entregue a CADA
// listener registrado. Com 11 nós, o mesmo frame de saída atravessa a ponte 11
// vezes e é desserializado 11 vezes no webview. É isso que some — e é justamente
// o que este benchmark, rodando em Node puro sem Tauri, NÃO consegue medir.
//
// Ou seja: este arquivo prova a redução ESTRUTURAL de trabalho. A prova de fluidez
// continua sendo medição na máquina real, com a GUI aberta e carga controlada.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Mediana de N rodadas com aquecimento.
 *
 * Uma passada única mede JIT e GC, não o dispatch: na primeira versão deste bench o
 * modelo NOVO aparecia "mais lento" em 11 sessões, o que é ruído — a contagem de
 * invocações, essa sim determinística, mostrava 11x menos trabalho.
 */
function mediana(amostras: number[]): number {
  const ord = [...amostras].sort((a, b) => a - b);
  const meio = Math.floor(ord.length / 2);
  return ord.length % 2 ? ord[meio] : (ord[meio - 1] + ord[meio]) / 2;
}

const TOTAL_EVENTS = 20_000;
const SESSIONS = [1, 5, 11, 25, 50];

let manualEmit: ((payload: unknown) => void) | null = null;

const mockListen: ListenImpl = async <P>(
  _channel: string,
  cb: (event: { payload: P }) => void,
): Promise<UnlistenFn> => {
  manualEmit = (payload: unknown) => cb({ payload: payload as P });
  return () => {
    manualEmit = null;
  };
};

function runOldModel(sessionsCount: number, totalEvents: number): {
  invocations: number;
  time: number;
} {
  let invocations = 0;
  const handlers: Array<(payload: { session: string }) => void> = [];

  for (let i = 0; i < sessionsCount; i++) {
    handlers.push(() => {
      invocations++;
      // O trabalho de filtragem na borda (descarte) acontece aqui
    });
  }

  const start = performance.now();
  for (let i = 0; i < totalEvents; i++) {
    const session = `s-${i % sessionsCount}`;
    const payload = { session, data: "payload" };
    for (const h of handlers) {
      h(payload);
    }
  }
  const end = performance.now();

  return { invocations, time: end - start };
}

async function runNewModel(sessionsCount: number, totalEvents: number): Promise<{
  invocations: number;
  time: number;
}> {
  let invocations = 0;
  const unlisteners: UnlistenFn[] = [];

  for (let i = 0; i < sessionsCount; i++) {
    const mySession = `s-${i}`;
    const un = await subscribeBySession<{ session: string }>(
      "pty://bench",
      mySession,
      (p) => p.session,
      () => {
        invocations++;
        // O handler só é chamado para a sua sessão
      },
    );
    unlisteners.push(un);
  }

  const start = performance.now();
  for (let i = 0; i < totalEvents; i++) {
    const session = `s-${i % sessionsCount}`;
    const payload = { session, data: "payload" };
    if (manualEmit) {
      manualEmit(payload);
    }
  }
  const end = performance.now();

  for (const un of unlisteners) un();
  return { invocations, time: end - start };
}

function printTable(
  data: Array<{
    N: number;
    invOld: number;
    invNew: number;
    msOld: number;
    msNew: number;
  }>,
): void {
  const nf = new Intl.NumberFormat("pt-BR");
  const tf = new Intl.NumberFormat("pt-BR", {
    minimumFractionDigits: 1,
    maximumFractionDigits: 1,
  });

  const headers = [
    "sessões",
    "invocações antigo",
    "invocações novo",
    "fator",
    "ms antigo",
    "ms novo",
  ];

  console.log(
    ` ${headers[0].padStart(7)} | ${headers[1].padStart(17)} | ${headers[2].padStart(15)} | ${headers[3].padStart(5)} | ${headers[4].padStart(9)} | ${headers[5].padStart(7)}`,
  );

  for (const row of data) {
    const factor = row.invOld / row.invNew;
    const line = ` ${String(row.N).padStart(7)} | ${nf.format(row.invOld).padStart(17)} | ${nf.format(row.invNew).padStart(15)} | ${`${factor}x`.padStart(5)} | ${tf.format(row.msOld).padStart(9)} | ${tf.format(row.msNew).padStart(7)}`;
    console.log(line);
  }

  const maxNRow = data[data.length - 1];
  const maxFactor = maxNRow.invOld / maxNRow.invNew;
  console.log(
    `\nFator de redução no maior N (${maxNRow.N} sessões): ${maxFactor}x menos invocações de callback no modelo novo em relação ao antigo.`,
  );
}

async function main(): Promise<void> {
  const results: Array<{
    N: number;
    invOld: number;
    invNew: number;
    msOld: number;
    msNew: number;
  }> = [];

  const RODADAS = 5;
  for (const N of SESSIONS) {
    // Aquecimento + mediana: uma passada só mede JIT/GC. As INVOCAÇÕES são exatas
    // e reprodutíveis; o tempo é indicativo, e só isso.
    let oldRes = runOldModel(N, TOTAL_EVENTS);
    const msOldAmostras: number[] = [];
    for (let r = 0; r < RODADAS; r++) {
      oldRes = runOldModel(N, TOTAL_EVENTS);
      msOldAmostras.push(oldRes.time);
    }
    oldRes = { ...oldRes, time: mediana(msOldAmostras) };

    const msNewAmostras: number[] = [];
    let newRes;
    for (let r = 0; r < RODADAS; r++) {
      resetEventBrokerForTests();
      setListenImpl(mockListen);
      setInterestImpl(() => {
        /* no-op para benchmark */
      });
      newRes = await runNewModel(N, TOTAL_EVENTS);
      msNewAmostras.push(newRes.time);
    }
    newRes = { ...newRes!, time: mediana(msNewAmostras) };

    results.push({
      N,
      invOld: oldRes.invocations,
      invNew: newRes.invocations,
      msOld: oldRes.time,
      msNew: newRes.time,
    });
  }

  resetEventBrokerForTests();
  printTable(results);
}

void main();
