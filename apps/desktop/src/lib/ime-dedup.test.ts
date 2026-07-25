// Testes puros do dedup IME (WebKitGTK/IBus) — self-running, sem vitest.

import {
  createCompositionChangeGate,
  createImeDedup,
  isCharKey,
  IME_COMPOSE_DEDUP_MS,
} from "./ime-dedup";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, message: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${message}`);
    console.log(`   esperado: ${JSON.stringify(expected)}`);
    console.log(`   obtido:   ${JSON.stringify(actual)}`);
  }
}

// --- isCharKey -------------------------------------------------------------
eq(isCharKey("ç"), true, "ç ABNT2 é tecla de 1 code point");
eq(isCharKey("á"), true, "á composto é 1 code point");
eq(isCharKey("Enter"), false, "Enter não conta como tecla-de-char");
eq(isCharKey("Dead"), false, "Dead key não conta");
eq(isCharKey("😀"), true, "emoji (1 code point, length JS 2) conta");

// --- dead-key: 1ª passa, 2ª dropa ------------------------------------------
{
  const t = 1_000;
  const dedup = createImeDedup({ now: () => t, windowMs: IME_COMPOSE_DEDUP_MS });
  dedup.noteCompositionEnd("á", t);
  eq(dedup.shouldForward("á", t), true, "1ª cópia do á composto passa");
  eq(dedup.shouldForward("á", t + 1), false, "2ª cópia idêntica na janela dropa");
  // 3ª na mesma janela ainda dropa (triplo-emit raro) — o par dedup já consumiu
  // via keySeq; composition.seen ainda segura. Após expirar, passa de novo.
  eq(dedup.shouldForward("á", t + 2), false, "3ª na janela ainda é tratada como eco");
}

// --- dead-key: janela expirada não dropa -----------------------------------
{
  let t = 2_000;
  const dedup = createImeDedup({ now: () => t, windowMs: 60 });
  dedup.noteCompositionEnd("ã", t);
  eq(dedup.shouldForward("ã", t), true, "1ª ã passa");
  t += 61;
  eq(dedup.shouldForward("ã", t), true, "após janela, 2º ã legítimo passa");
}

// --- duas composições seguidas do mesmo char (áá) --------------------------
{
  let t = 3_000;
  const dedup = createImeDedup({ now: () => t, windowMs: 60 });
  dedup.noteCharKeyDown(); // tecla base da 1ª composição
  dedup.noteCompositionEnd("á", t);
  eq(dedup.shouldForward("á", t), true, "1º á da 1ª composição");
  t += 5;
  dedup.noteCharKeyDown(); // tecla base da 2ª composição (keySeq avança)
  dedup.noteCompositionEnd("á", t);
  eq(dedup.shouldForward("á", t), true, "1º á da 2ª composição não é engolido");
}

// --- ordem input-first: onData antes do compositionend --------------------
{
  const t = 4_000;
  const dedup = createImeDedup({ now: () => t, windowMs: 60 });
  eq(dedup.shouldForward("á", t), true, "1ª emissão chega antes do compositionend");
  dedup.noteCompositionEnd("á", t); // NÃO pode apagar lastEmit / deve marcar seen
  eq(dedup.shouldForward("á", t + 1), false, "eco após compositionend tardio dropa");
}

// --- ABNT2 ç: keySeq (sem compositionend) ----------------------------------
{
  const dedup = createImeDedup();
  dedup.noteCharKeyDown(); // um keydown
  eq(dedup.shouldForward("ç"), true, "1ª emissão do ç passa");
  eq(dedup.shouldForward("ç"), false, "2ª emissão do mesmo keySeq dropa");
}

// --- çç legítimo: dois keydowns --------------------------------------------
{
  const dedup = createImeDedup();
  dedup.noteCharKeyDown();
  eq(dedup.shouldForward("ç"), true, "primeiro ç");
  dedup.noteCharKeyDown();
  eq(dedup.shouldForward("ç"), true, "segundo ç (keydown distinto) passa");
}

// --- motor sem bug: uma emissão só → no-op ---------------------------------
{
  const dedup = createImeDedup();
  dedup.noteCompositionEnd("é");
  eq(dedup.shouldForward("é"), true, "única emissão passa");
  dedup.noteCharKeyDown();
  eq(dedup.shouldForward("x"), true, "tecla seguinte distinta passa");
}

// --- CompositionChangeGate (SafeInput) -------------------------------------
{
  const gate = createCompositionChangeGate();
  eq(gate.allowChange(), true, "antes da composição propaga");
  gate.start();
  eq(gate.allowChange(), false, "durante preedit NÃO propaga onChange");
  gate.end();
  eq(gate.allowChange(), true, "após compositionend propaga de novo");
}

console.log(`ime-dedup: ${pass} ok, ${fail} falha(s)`);
if (fail > 0) process.exit(1);
