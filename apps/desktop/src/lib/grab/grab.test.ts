// src/lib/grab/grab.test.ts
//
// Testes PUROS do subsistema Design Mode grab. Não há vitest em apps/desktop;
// estes testes rodam via node (transpilados por esbuild) — ver scripts/run-grab-tests.mjs.
// Se vitest for adicionado depois, este arquivo já está no padrão de `describe`/`it`
// (usamos um shim mínimo que também serve ao vitest: importamos de um helper local).
//
// Cobertura exigida pela spec:
//   1. clampPayload corta HTML/CSS/texto gigante.
//   2. redact mascara password + token + apikey (página E app).
//   3. formatGrabAsMarkdown escapa `<`/`>`/backtick (XSS-safe).
//   4. máquina de estado (grabReducer) ignora resultado stale por opId.

import { GRAB_BUDGET, clampPayload, redactHtml, redactText, redactAttrs, type GrabPayload } from "./payload";
import { formatGrabAsMarkdown, escapeForMarkdown } from "./format";
import { grabReducer, initialGrabMachine } from "../../hooks/useGrabMode";

// ── micro test harness (zero deps; vitest pode substituir) ──────────────────
let passed = 0;
let failed = 0;
const fails: string[] = [];
function check(name: string, cond: boolean, detail?: string) {
  if (cond) { passed++; }
  else { failed++; fails.push(`✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
function eq<T>(name: string, got: T, want: T) {
  check(name, JSON.stringify(got) === JSON.stringify(want), `got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ── 1. clampPayload corta HTML/CSS/texto gigante ────────────────────────────
{
  const bigHtml = "<div>" + "x".repeat(10_000) + "</div>";
  const bigText = "y".repeat(5_000);
  const manyCss: Record<string, string> = {};
  for (let i = 0; i < 100; i++) manyCss[`prop-${i}`] = "z".repeat(100);
  const manyNearby = Array.from({ length: 50 }, (_, i) => `nearby-${i}-` + "w".repeat(500));
  const manyAttrs: Record<string, string> = {};
  for (let i = 0; i < 100; i++) manyAttrs[`attr${i}`] = "v".repeat(500);

  const raw = {
    page: { url: "http://localhost:3000", title: bigText },
    target: { tag: "DIV", selector: "s".repeat(2000), attrs: manyAttrs, computedCss: manyCss, rect: { x: 1.7, y: 2.2, width: 10, height: 20 }, role: "" },
    outerHtml: bigHtml,
    nearbyText: manyNearby,
    ancestorPath: Array.from({ length: 40 }, (_, i) => `div-${i}`),
  };
  const p = clampPayload(raw);

  check("clamp: outerHtml ≤ budget+marker", p.outerHtml.length <= GRAB_BUDGET.htmlSnippet + 40, `len=${p.outerHtml.length}`);
  check("clamp: outerHtml truncado tem marcador", p.outerHtml.includes("…truncado"));
  check("clamp: selector ≤ budget", p.target.selector.length <= GRAB_BUDGET.selector + 1, `len=${p.target.selector.length}`);
  check("clamp: title clampado", p.page.title.length <= 300 + 1, `len=${p.page.title.length}`);
  check("clamp: nearbyText nº entradas ≤ budget", p.nearbyText.length <= GRAB_BUDGET.nearbyTextEntries, `n=${p.nearbyText.length}`);
  check("clamp: nearbyText cada entrada ≤ budget", p.nearbyText.every((s) => s.length <= GRAB_BUDGET.nearbyTextEntry + 1));
  check("clamp: ancestorPath ≤ budget", p.ancestorPath.length <= GRAB_BUDGET.ancestorPathEntries, `n=${p.ancestorPath.length}`);
  check("clamp: attrs nº ≤ budget", Object.keys(p.target.attrs).length <= GRAB_BUDGET.attrCount, `n=${Object.keys(p.target.attrs).length}`);
  const cssLen = Object.entries(p.target.computedCss).reduce((a, [k, v]) => a + k.length + v.length, 0);
  check("clamp: computedCss total ≤ budget", cssLen <= GRAB_BUDGET.computedCss + 200, `len=${cssLen}`);
  eq("clamp: rect arredondado", p.target.rect, { x: 2, y: 2, width: 10, height: 20 });
  eq("clamp: tag lowercase", p.target.tag, "div");
}

// ── 2. redact mascara password + token + apikey ─────────────────────────────
{
  // password input → SEMPRE [redacted]
  const h1 = redactHtml('<input type="password" value="hunter2">');
  check("redact: password value mascarado", h1.includes("[redacted]") && !h1.includes("hunter2"), h1);

  // qualquer input value → [redacted]
  const h2 = redactHtml('<input type="text" value="meu-cpf-123">');
  check("redact: input value mascarado", h2.includes("[redacted]") && !h2.includes("meu-cpf-123"), h2);

  // atributo cuja chave é secreta → [redacted]
  const h3 = redactHtml('<a data-api-key="abc123secret" href="/x">link</a>');
  check("redact: atributo api_key mascarado", !h3.includes("abc123secret"), h3);

  // token solto em texto livre (Bearer)
  const t1 = redactText("Authorization: Bearer ABCD1234efgh5678ijkl");
  check("redact: bearer token mascarado", t1.includes("[redacted]") && !t1.includes("ABCD1234efgh5678ijkl"), t1);

  // chave estilo OpenAI (sk-…)
  const t2 = redactText("key=sk-abcdefghijklmnopqrstuvwx");
  check("redact: sk- key mascarada", !t2.includes("sk-abcdefghijklmnopqrstuvwx"), t2);

  // JWT
  const t3 = redactText("token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N");
  check("redact: JWT mascarado", t3.includes("[redacted]"), t3);

  // #1 [GLM-audit] redact-before-truncate: senha que cruza o corte do budget não vaza.
  const straddle =
    "x".repeat(GRAB_BUDGET.htmlSnippet - 34) + '<input type="password" value="STRADDLESECRET">';
  const cpStraddle = clampPayload({
    page: { url: "x", title: "x" },
    target: { tag: "input", selector: "i", attrs: {}, computedCss: {}, rect: {}, role: "" },
    outerHtml: straddle, nearbyText: [], ancestorPath: [],
  });
  check("redact: senha cruzando o corte do budget não vaza", !cpStraddle.outerHtml.includes("STRA"), cpStraddle.outerHtml.slice(-60));

  // #3 [GLM-audit] conteúdo interno de <textarea> com nome secreto → mascarado.
  const taSecret = redactHtml('<textarea name="password">myPlainSecret</textarea>');
  check("redact: conteúdo de textarea secreta mascarado", !taSecret.includes("myPlainSecret"), taSecret);
  const taNormal = redactHtml('<textarea name="comment">keep this text</textarea>');
  check("redact: textarea normal preservada", taNormal.includes("keep this text"), taNormal);

  // attrs map: chave secreta + valor com token
  const am = redactAttrs({ "client_secret": "topsecret", "title": "Bearer XYZ1234567890abcd", "id": "ok" });
  eq("redact: attr client_secret", am["client_secret"], "[redacted]");
  check("redact: attr title token mascarado", am["title"].includes("[redacted]"), am["title"]);
  eq("redact: attr id intacto", am["id"], "ok");

  // app-side re-redação: clampPayload re-mascara mesmo HTML cru hostil.
  const p = clampPayload({
    page: { url: "http://localhost", title: "x" },
    target: { tag: "input", selector: "input", attrs: { "x-api-key": "leak123" }, computedCss: {}, rect: {}, role: "" },
    outerHtml: '<input type="password" value="leaked-pw"><span>Bearer leakToken12345678</span>',
    nearbyText: ["api_key=plaintextleak987654"],
    ancestorPath: [],
  });
  check("redact(app): password no outerHtml", !p.outerHtml.includes("leaked-pw"), p.outerHtml);
  check("redact(app): bearer no outerHtml", !p.outerHtml.includes("leakToken12345678"), p.outerHtml);
  eq("redact(app): attr secreta", p.target.attrs["x-api-key"], "[redacted]");
}

// ── 3. formatGrabAsMarkdown escapa < / > / backtick (XSS-safe) ───────────────
{
  const payload: GrabPayload = {
    page: { url: "http://localhost/<script>", title: "t`itle" },
    target: {
      tag: "button",
      selector: "div > button.`evil`",
      attrs: { "onclick": "alert(`<xss>`)" },
      computedCss: { "content": "</style><script>" },
      rect: { x: 0, y: 0, width: 10, height: 10 },
      role: "button",
    },
    outerHtml: "<button onclick=\"alert(1)\">```evil fence```</button>",
    nearbyText: ["<b>bold</b>", "back`tick"],
    ancestorPath: ["div", "section<x>"],
  };
  const md = formatGrabAsMarkdown(payload);

  // O HTML fica num fence ```html (texto literal, XSS-safe por não ser innerHTML);
  // dentro do fence `<` pode ser literal. FORA do fence, todo `<`/`>` deve ter sido
  // escapado pra &lt;/&gt; (é o conteúdo interpolado em headers/attrs/styles).
  const outsideFence = md.split(/```html[\s\S]*?```/).join("");
  // `<` é o caractere perigoso (início de tag). Fora do fence, NENHUM `<` cru pode
  // sair — todo valor interpolado é escapado pra &lt;. (`>` cru só aparece como o
  // separador estrutural " > " controlado pelo código, nunca de conteúdo do usuário.)
  check("md: fora do fence sem '<' cru", !/</.test(outsideFence), "raw < outside fence");
  const rawGt = outsideFence.replace(/ > /g, " "); // remove só o separador estrutural.
  check("md: fora do fence sem '>' cru (exceto separador)", !/>/.test(rawGt), "raw > outside fence");
  check("md: '<' virou &lt;", md.includes("&lt;"));
  check("md: '>' virou &gt;", md.includes("&gt;"));
  // backticks fora dos delimitadores de inline-code/fence devem estar escapados.
  check("md: backtick perigoso escapado", md.includes("\\`"), "no escaped backtick");
  // o fence do HTML não pode ter sido fechado prematuramente pelos ``` do conteúdo.
  const fenceOpens = (md.match(/```html/g) || []).length;
  eq("md: exatamente 1 fence ```html", fenceOpens, 1);
  check("md: conteúdo do fence neutralizou backticks", md.includes("\\`\\`\\`evil"), md);

  // escapeForMarkdown unitário
  eq("escape: <", escapeForMarkdown("<a>"), "&lt;a&gt;");
  eq("escape: backtick", escapeForMarkdown("a`b"), "a\\`b");
}

// ── 4. grabReducer ignora resultado stale por opId ──────────────────────────
{
  // arma op 1
  let m = grabReducer(initialGrabMachine, { type: "ARM", opId: 1 });
  eq("fsm: ARM → armed", m.state, "armed");
  m = grabReducer(m, { type: "AWAIT", opId: 1 });
  eq("fsm: AWAIT → awaiting", m.state, "awaiting");

  // re-arma como op 2 (troca de URL no meio) — opId corrente vira 2.
  m = grabReducer(m, { type: "ARM", opId: 2 });
  eq("fsm: re-ARM adota opId 2", m.opId, 2);
  eq("fsm: re-ARM volta a armed", m.state, "armed");

  // PICK stale (op 1) é IGNORADO.
  const stalePayload = clampPayload({ page: { url: "x", title: "" }, target: { tag: "p", selector: "p", attrs: {}, computedCss: {}, rect: {}, role: "" }, outerHtml: "<p>x</p>", nearbyText: [], ancestorPath: [] });
  const afterStale = grabReducer(m, { type: "PICK", opId: 1, payload: stalePayload });
  eq("fsm: PICK stale (opId 1) ignorado", afterStale.state, "armed");
  eq("fsm: PICK stale não setou payload", afterStale.payload, null);

  // PICK corrente (op 2) é aceito → confirming.
  const fresh = grabReducer(m, { type: "PICK", opId: 2, payload: stalePayload });
  eq("fsm: PICK corrente → confirming", fresh.state, "confirming");
  check("fsm: PICK corrente setou payload", fresh.payload !== null);

  // TIMEOUT stale ignorado; corrente → error.
  const tStale = grabReducer(m, { type: "TIMEOUT", opId: 1 });
  eq("fsm: TIMEOUT stale ignorado", tStale.state, "armed");
  const tFresh = grabReducer(m, { type: "TIMEOUT", opId: 2 });
  eq("fsm: TIMEOUT corrente → error", tFresh.state, "error");
  check("fsm: TIMEOUT setou mensagem", !!tFresh.error);

  // CANCEL corrente → idle.
  const cancelled = grabReducer(m, { type: "CANCEL", opId: 2 });
  eq("fsm: CANCEL → idle", cancelled.state, "idle");

  // RESET sempre volta a idle.
  eq("fsm: RESET → idle", grabReducer(fresh, { type: "RESET" }).state, "idle");
}

// ── relatório ───────────────────────────────────────────────────────────────
console.log(`\nGrab tests: ${passed} passed, ${failed} failed`);
if (failed > 0) {
  console.error(fails.join("\n"));
  process.exit(1);
}
