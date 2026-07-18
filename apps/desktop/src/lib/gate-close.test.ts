// TDD do gate de fechamento da intro: espera o áudio OU um teto de segurança.
import { gateClose } from "./gate-close";

let pass = 0, fail = 0;
const ok = (c: boolean, m: string) => { c ? pass++ : (fail++, console.log("❌ " + m)); };

(async () => {
  const t0 = Date.now();
  await gateClose(new Promise((r) => setTimeout(r, 10)), 500);
  ok(Date.now() - t0 < 300, "resolve pela promise quando ela é rápida (bem antes do teto)");

  const t1 = Date.now();
  await gateClose(new Promise(() => {}), 40);
  const dt = Date.now() - t1;
  ok(dt >= 30 && dt < 300, "resolve pelo TETO quando a promise nunca resolve (não prende o usuário)");

  await gateClose(Promise.reject(new Error("x")), 500);
  ok(true, "não rejeita quando a promise de áudio falha");

  console.log(`\n${pass} passaram, ${fail} falharam`);
  if (fail > 0) process.exit(1);
})();
