// Prova o contrato que impede o loop do FileTree: `useT()` / `makeTranslator`
// deve devolver a MESMA referência de função enquanto o locale não muda.
// Se a referência muda a cada chamada, `useCallback(..., [t])` + `useEffect([load])`
// re-dispara `list_dir` em loop e congela o WebView (bug reportado no Windows).

import { makeTranslator, translate } from "./i18n";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, message: string) {
  if (Object.is(actual, expected) || JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${message}`);
    console.log(`   esperado: ${String(expected)}`);
    console.log(`   obtido:   ${String(actual)}`);
  }
}

function ok(cond: boolean, message: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log(`❌ ${message}`);
  }
}

// Mesmo locale → mesma referência (é o que estabiliza useCallback/useEffect).
ok(makeTranslator("pt") === makeTranslator("pt"), "makeTranslator('pt') é estável");
ok(makeTranslator("en") === makeTranslator("en"), "makeTranslator('en') é estável");

// Locales diferentes → referências diferentes (troca de idioma re-renderiza de verdade).
ok(makeTranslator("pt") !== makeTranslator("en"), "pt e en são tradutores distintos");

// Tradução continua correta.
eq(
  makeTranslator("pt")("fileTree.loading", "fallback"),
  translate("pt", "fileTree.loading", "fallback"),
  "tradutor pt resolve fileTree.loading",
);
eq(
  makeTranslator("en")("fileTree.loading", "fallback"),
  translate("en", "fileTree.loading", "fallback"),
  "tradutor en resolve fileTree.loading",
);

console.log(`i18n: ${pass} pass, ${fail} fail`);
if (fail > 0) process.exit(1);
