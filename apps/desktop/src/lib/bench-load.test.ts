// src/lib/bench-load.test.ts
//
// Testes unitários do gerador de carga sintética e validação de movimento de nós.
// Roda sem framework via:
//   npm run test:canvas-fluency --workspace=apps/desktop

import {
  assertNodesMoved,
  benchSummaryLine,
  makeSyntheticNodes,
  planDragGesture,
} from "./bench-load";

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

// ── T1: makeSyntheticNodes(300) devolve 300 nós, todos kind community, ids únicos ────
{
  const nodes = makeSyntheticNodes(300);
  eq(nodes.length, 300, "T1: makeSyntheticNodes(300) deve devolver 300 nós");
  const allCommunity = nodes.every((n) => n.kind === "community");
  assert(allCommunity, "T1: todos os nós devem ser do tipo 'community'");
  const uniqueIds = new Set(nodes.map((n) => n.id));
  eq(uniqueIds.size, 300, "T1: todos os 300 ids gerados devem ser únicos");
}

// ── T2: DETERMINISMO — duas chamadas com os mesmos argumentos produzem posições idênticas ──
{
  const runA = makeSyntheticNodes(100, { cols: 10, gapX: 280, gapY: 160, prefix: "bench-test-" });
  const runB = makeSyntheticNodes(100, { cols: 10, gapX: 280, gapY: 160, prefix: "bench-test-" });
  eq(runA, runB, "T2: chamadas repetidas com mesmos parâmetros devem produzir nós e posições idênticas");
}

// ── T3: count 0, -5, 1.5, NaN, Infinity => [] e não lança ───────────────────────────
{
  for (const c of [0, -5, 1.5, NaN, Infinity, -Infinity]) {
    let nodes: unknown;
    let threw = false;
    try {
      nodes = makeSyntheticNodes(c);
    } catch {
      threw = true;
    }
    assert(!threw, `T3: count=${String(c)} não deve lançar exceção`);
    eq(nodes, [], `T3: count=${String(c)} deve devolver array vazio`);
  }
}

// ── T4: grade — com cols:25, o nó 25 começa uma linha nova (y maior, x volta ao início) ─
{
  const nodes = makeSyntheticNodes(50, { cols: 25, gapX: 300, gapY: 200 });
  const node0 = nodes[0];
  const node24 = nodes[24];
  const node25 = nodes[25];

  // Nó 0: coluna 0, linha 0
  // Nó 24: coluna 24, linha 0
  // Nó 25: coluna 0, linha 1 (x volta ao início e y avança para a próxima linha)
  assert(node25.position.x === node0.position.x, "T4: nó 25 volta ao x inicial da grade");
  assert(node25.position.y > node0.position.y, "T4: nó 25 tem y maior que nó 0 (nova linha)");
  assert(node24.position.x > node0.position.x, "T4: nó 24 está no final da primeira linha");
  assert(node24.position.y === node0.position.y, "T4: nó 24 está na mesma linha que nó 0");
}

// ── T5: planDragGesture — o ÚLTIMO ponto é EXATAMENTE 'to' ───────────────────────────
{
  const from = { x: 0, y: 0 };
  const to = { x: 10, y: 10 };
  // steps: 3 geraria 10/3 = 3.3333333333333335, acumulando erro de float se mal implementado
  const path = planDragGesture({ from, to, steps: 3 });
  assert(path.length > 0, "T5: caminho gerado não deve ser vazio");
  const last = path[path.length - 1];
  assert(last.x === to.x, "T5: last.x === to.x exatamente (sem erro acumulado de float)");
  assert(last.y === to.y, "T5: last.y === to.y exatamente (sem erro acumulado de float)");
}

// ── T6: planDragGesture determinístico e steps<=0 => [to] ────────────────────────────
{
  const from = { x: 50, y: 100 };
  const to = { x: 500, y: 800 };
  const pathA = planDragGesture({ from, to, steps: 5 });
  const pathB = planDragGesture({ from, to, steps: 5 });
  eq(pathA, pathB, "T6: duas chamadas iguais produzem trajetórias idênticas");

  for (const s of [0, -1, -10]) {
    const p = planDragGesture({ from, to, steps: s });
    eq(p, [to], `T6: steps=${s} devolve apenas [to]`);
  }
}

// ── T7: FALSO POSITIVO — assertNodesMoved com 'after' IGUAL ao 'before' reporta TODOS como 'stuck' ──
{
  const before = new Map<string, { x: number; y: number }>([
    ["n1", { x: 10, y: 20 }],
    ["n2", { x: 30, y: 40 }],
    ["n3", { x: 50, y: 60 }],
  ]);
  const after = new Map<string, { x: number; y: number }>([
    ["n1", { x: 10, y: 20 }],
    ["n2", { x: 30, y: 40 }],
    ["n3", { x: 50, y: 60 }],
  ]);
  const result = assertNodesMoved(before, after, ["n1", "n2", "n3"]);
  eq(result.moved, [], "T7: moved deve ser vazio quando posições não mudam");
  eq(result.stuck, ["n1", "n2", "n3"], "T7: todos os nós não movidos devem ser reportados como stuck");
  assert(result.stuck.length === 3, "T7: anti-falso-positivo — gesto sem deslocamento real não pode passar");
}

// ── T8: assertNodesMoved com id ausente no 'after' => conta como stuck (não lança) ──
{
  const before = new Map<string, { x: number; y: number }>([
    ["n1", { x: 10, y: 20 }],
    ["n2", { x: 30, y: 40 }],
  ]);
  const after = new Map<string, { x: number; y: number }>([
    ["n1", { x: 15, y: 25 }],
    // n2 ausente no after
  ]);
  let result: { moved: string[]; stuck: string[] } | null = null;
  let threw = false;
  try {
    result = assertNodesMoved(before, after, ["n1", "n2"]);
  } catch {
    threw = true;
  }
  assert(!threw, "T8: nó ausente no after não deve lançar erro");
  assert(result !== null, "T8: resultado deve ser retornado");
  if (result) {
    eq(result.moved, ["n1"], "T8: n1 mudou de posição => moved");
    eq(result.stuck, ["n2"], "T8: n2 ausente no after => stuck");
  }
}

// ── T9: assertNodesMoved mistura movidos e parados corretamente ─────────────────────
{
  const before = new Map<string, { x: number; y: number }>([
    ["n1", { x: 10, y: 20 }],
    ["n2", { x: 30, y: 40 }],
    ["n3", { x: 50, y: 60 }],
    ["n4", { x: 70, y: 80 }],
  ]);
  const after = new Map<string, { x: number; y: number }>([
    ["n1", { x: 15, y: 20 }], // x mudou
    ["n2", { x: 30, y: 40 }], // igual
    ["n3", { x: 50, y: 65 }], // y mudou
    // n4 ausente
  ]);
  const result = assertNodesMoved(before, after, ["n1", "n2", "n3", "n4"]);
  eq(result.moved, ["n1", "n3"], "T9: n1 e n3 classificados como moved");
  eq(result.stuck, ["n2", "n4"], "T9: n2 e n4 classificados como stuck");
}

// ── T10: benchSummaryLine é determinística ──────────────────────────────────────────
{
  const lineA = benchSummaryLine({ nodes: 300, movedOk: 290, stuck: 10, flags: "bench: virtualize=1" });
  const lineB = benchSummaryLine({ nodes: 300, movedOk: 290, stuck: 10, flags: "bench: virtualize=1" });
  eq(lineA, lineB, "T10: duas chamadas iguais produzem linhas idênticas");
  assert(lineA.includes("300"), "T10: linha contém contagem total de nós");
  assert(lineA.includes("290"), "T10: linha contém contagem de nós movidos");
  assert(lineA.includes("10"), "T10: linha contém contagem de nós travados");
  assert(lineA.includes("flags="), "T10: linha contém parâmetro flags");
}

console.log(`\nbench-load: ${pass} passed, ${fail} failed`);
if (fail > 0) {
  process.exit(1);
}
