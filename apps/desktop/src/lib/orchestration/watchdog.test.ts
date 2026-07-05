import { stepWatchdog, INITIAL_WATCHDOG_STATE, DEFAULT_WATCHDOG_OPTS } from './watchdog';

let pass = 0;
let fail = 0;

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
  }
}

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
    console.log(`   esperado: ${JSON.stringify(expected)}`);
    console.log(`   obtido:   ${JSON.stringify(actual)}`);
  }
}

const opts = { minStallMs: 1000, stepMs: 1000 };

// Sinais de referência
const healthy = {
  now: 0,
  orchestratorPresent: true,
  readyIdleAgents: 2,
  anyRunning: false,
  hasDelivery: true,
};

const stall = {
  now: 0,
  orchestratorPresent: true,
  readyIdleAgents: 2,
  anyRunning: false,
  hasDelivery: false,
};

// 1. Fluxo saudável: com entrega, não dispara e reseta para o estado inicial.
let r = stepWatchdog(INITIAL_WATCHDOG_STATE, healthy, opts);
eq(r.fire, null, 'caso 1: fluxo saudável não deve disparar');
eq(r.state, INITIAL_WATCHDOG_STATE, 'caso 1: estado deve voltar ao inicial');

// 2. Sem orquestrador: não dispara e reseta.
r = stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, orchestratorPresent: false }, opts);
eq(r.fire, null, 'caso 2: sem orquestrador não deve disparar');
eq(r.state, INITIAL_WATCHDOG_STATE, 'caso 2: sem orquestrador deve resetar');

// 3. Algum agente em execução: não dispara e reseta.
r = stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, anyRunning: true }, opts);
eq(r.fire, null, 'caso 3: anyRunning=true não deve disparar');
eq(r.state, INITIAL_WATCHDOG_STATE, 'caso 3: anyRunning=true deve resetar');

// 4. Apenas um agente ocioso disponível: não dispara e reseta.
r = stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, readyIdleAgents: 1 }, opts);
eq(r.fire, null, 'caso 4: só 1 idle agent não deve disparar');
eq(r.state, INITIAL_WATCHDOG_STATE, 'caso 4: só 1 idle agent deve resetar');

// 5. Stall novo: primeira chamada marca stalledSince e ainda não dispara.
r = stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, now: 0 }, opts);
eq(r.fire, null, 'caso 5: primeiro stall não deve disparar');
assert(r.state.stalledSince === 0, 'caso 5: stalledSince deve ser definido como now');

// 6. Stall contínuo: nudge1, nudge2, alert e depois silêncio.
let state = stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, now: 0 }, opts).state;

r = stepWatchdog(state, { ...stall, now: 1000 }, opts);
eq(r.fire, 'nudge1', 'caso 6: após 1000ms deve disparar nudge1');
assert(r.state.stage === 1, 'caso 6: stage deve ser 1 no nudge1');

state = r.state;
r = stepWatchdog(state, { ...stall, now: 2000 }, opts);
eq(r.fire, 'nudge2', 'caso 6: após 2000ms deve disparar nudge2');
assert(r.state.stage === 2, 'caso 6: stage deve ser 2 no nudge2');

state = r.state;
r = stepWatchdog(state, { ...stall, now: 3000 }, opts);
eq(r.fire, 'alert', 'caso 6: após 3000ms deve disparar alert');
assert(r.state.stage === 3, 'caso 6: stage deve ser 3 no alert');

state = r.state;
r = stepWatchdog(state, { ...stall, now: 4000 }, opts);
eq(r.fire, null, 'caso 6: após 4000ms deve ficar em silêncio');
assert(r.state.stage === 3, 'caso 6: stage permanece 3 no silêncio');

// 7. Recuperação no meio: após nudge1, recuperação reseta; novo stall recomeça do nudge1.
state = stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, now: 0 }, opts).state;
r = stepWatchdog(state, { ...stall, now: 1000 }, opts);
eq(r.fire, 'nudge1', 'caso 7: primeiro stall deve dar nudge1');

r = stepWatchdog(r.state, { ...healthy, now: 1500 }, opts);
eq(r.fire, null, 'caso 7: recuperação não deve disparar');
eq(r.state, INITIAL_WATCHDOG_STATE, 'caso 7: recuperação deve resetar o estado');

state = stepWatchdog(r.state, { ...stall, now: 2000 }, opts).state;
r = stepWatchdog(state, { ...stall, now: 3000 }, opts);
eq(r.fire, 'nudge1', 'caso 7: novo stall deve recomeçar do nudge1, não do nudge2');

// 8. Imutabilidade: o estado passado não é alterado.
const before = JSON.stringify(INITIAL_WATCHDOG_STATE);
stepWatchdog(INITIAL_WATCHDOG_STATE, { ...stall, now: 0 }, opts);
const after = JSON.stringify(INITIAL_WATCHDOG_STATE);
eq(after, before, 'caso 8: estado de entrada não deve ser mutado');

console.log(`watchdog: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);