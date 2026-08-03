import { strict as assert } from "node:assert";
import {
  setListenImpl,
  subscribeBySession,
  activeChannelCount,
  resetEventBrokerForTests,
  type ListenImpl,
} from "./event-broker";

let passed = 0;
function test(name: string, fn: () => Promise<void> | void) {
  return Promise.resolve(fn()).then(() => {
    passed++;
  }).catch(err => {
    console.error(`FALHOU: ${name}`);
    throw err;
  });
}

const channelCallbacks = new Map<string, (payload: unknown) => void>();
let listenCalls = 0;
let unlistenCalls = 0;

// O tipo é genérico em P; o fake trata payload como unknown e a asserção fica na
// atribuição (não depois do corpo da arrow, que é erro de sintaxe).
const fakeListen = (async (channel: string, cb: (event: { payload: unknown }) => void) => {
  listenCalls++;
  channelCallbacks.set(channel, (payload) => cb({ payload }));
  return () => {
    unlistenCalls++;
    channelCallbacks.delete(channel);
  };
}) as unknown as ListenImpl;

function fire(channel: string, payload: unknown) {
  const cb = channelCallbacks.get(channel);
  if (cb) cb(payload);
}

function resetMock() {
  channelCallbacks.clear();
  listenCalls = 0;
  unlistenCalls = 0;
}

async function main() {
  // FIX: Múltiplos nós no mesmo canal sobrecarregavam o Tauri com 1 listener global por nó.
  await test("um_listener_por_canal_mesmo_com_muitos_inscritos", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);
    for (let i = 0; i < 11; i++) {
      await subscribeBySession("pty://1", `s${i}`, () => "s", () => {});
    }
    assert.equal(listenCalls, 1);
    assert.equal(activeChannelCount(), 1);
  });

  // FIX: Um evento era processado e descartado por todos os nós, gerando 10x de processamento inútil.
  await test("evento_vai_so_para_a_sessao_dona", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    const calls: Record<string, number> = { a: 0, b: 0 };
    await subscribeBySession("pty://2", "a", (p: { id?: string }) => p.id, () => { calls.a++; });
    await subscribeBySession("pty://2", "b", (p: { id?: string }) => p.id, () => { calls.b++; });

    fire("pty://2", { id: "a" });
    assert.equal(calls.a, 1);
    assert.equal(calls.b, 0);
  });

  // FIX: Inscritos criados no mesmo tick do React geravam múltiplos listeners globais para o mesmo canal.
  await test("inscricoes_concorrentes_nao_criam_dois_listeners", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    await Promise.all([
      subscribeBySession("pty://3", "a", () => "a", () => {}),
      subscribeBySession("pty://3", "b", () => "b", () => {}),
    ]);

    assert.equal(listenCalls, 1);
  });

  // FIX: Um erro de render de um terminal matava o listener global e congelava os demais terminais.
  await test("handler_que_lanca_nao_derruba_os_outros", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    let received = 0;
    await subscribeBySession("pty://4", "a", () => "a", () => { throw new Error("boom"); });
    await subscribeBySession("pty://4", "a", () => "a", () => { received++; });

    fire("pty://4", "a");
    assert.equal(received, 1);

    fire("pty://4", "a");
    assert.equal(received, 2);
  });

  // FIX: Desmontar um terminal podia acidentalmente remover o handler de outro terminal.
  await test("unsubscribe_remove_so_o_proprio_handler", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    let r1 = 0, r2 = 0;
    const u1 = await subscribeBySession("pty://5", "a", () => "a", () => { r1++; });
    await subscribeBySession("pty://5", "a", () => "a", () => { r2++; });

    u1();
    fire("pty://5", "a");
    assert.equal(r1, 0);
    assert.equal(r2, 1);
  });

  // FIX: Desmontar todos os terminais deixava um listener global órfão causando vazamento de memória.
  await test("ultimo_unsubscribe_desliga_o_listener_global", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    const u1 = await subscribeBySession("pty://6", "a", () => "a", () => {});
    const u2 = await subscribeBySession("pty://6", "b", () => "b", () => {});
    u1();
    assert.equal(activeChannelCount(), 1);
    u2();
    assert.equal(activeChannelCount(), 0);
    assert.equal(unlistenCalls, 1);
  });

  // FIX: Double unlisten no React Strict Mode lançava erro ao desmontar componente duas vezes.
  await test("unsubscribe_e_idempotente", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    let r1 = 0, r2 = 0;
    const u1 = await subscribeBySession("pty://7", "a", () => "a", () => { r1++; });
    await subscribeBySession("pty://7", "a", () => "a", () => { r2++; });

    u1();
    u1(); 
    fire("pty://7", "a");
    assert.equal(r1, 0);
    assert.equal(r2, 1);
  });

  // FIX: Eventos de sistema sem sessão ativa invadiam todos os terminais e travavam o canvas.
  await test("payload_sem_sessao_e_descartado", async () => {
    resetEventBrokerForTests();
    resetMock();
    setListenImpl(fakeListen);

    let r = 0;
    await subscribeBySession("pty://8", "a", () => undefined, () => { r++; });
    fire("pty://8", { id: "a" });
    assert.equal(r, 0);
  });

  console.log(`OK ${passed}`);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
