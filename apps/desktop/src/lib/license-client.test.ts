// Teste regressivo para normalizePastedKey.
// Originou-se de um incidente real: 20 licenças beta foram distribuídas numa
// LISTA NUMERADA (ex: "04 lic_o5FhbM4PwpuFO4pE"). Quem copiava a linha inteira
// colava o prefixo "04 " junto com a chave, e o worker respondia 404
// "licença inválida" — um erro que parecia licença furada, mas era apenas
// texto extra ao redor da chave. normalizePastedKey deve extrair a chave
// de dentro de textos colados.

import { normalizePastedKey } from "./license-client";

let pass = 0;
let fail = 0;

function eq(actual: unknown, expected: unknown, msg: string) {
  if (JSON.stringify(actual) === JSON.stringify(expected)) {
    pass++;
  } else {
    fail++;
    console.log(`❌ ${msg}`);
    console.log('   esperado:', JSON.stringify(expected));
    console.log('   obtido:', JSON.stringify(actual));
  }
}

// o caso que quebrou de verdade
eq(normalizePastedKey("04 lic_o5FhbM4PwpuFO4pE"), "lic_o5FhbM4PwpuFO4pE", "lista numerada: tira o '04 '");
eq(normalizePastedKey("01 lic_wN_SuIlaAWpSjRBG"), "lic_wN_SuIlaAWpSjRBG", "lista numerada: primeiro item");

// caminho feliz não pode regredir
eq(normalizePastedKey("lic_wN_SuIlaAWpSjRBG"), "lic_wN_SuIlaAWpSjRBG", "chave limpa passa intacta");
eq(normalizePastedKey("  lic_wN_SuIlaAWpSjRBG \n"), "lic_wN_SuIlaAWpSjRBG", "espaço e quebra de linha do copiar/colar");

// outros formatos em que a chave circula
eq(normalizePastedKey("Sua licença: lic_Fst7nBL9oZdany4l — válida por 60 dias"), "lic_Fst7nBL9oZdany4l", "extrai de frase de e-mail/WhatsApp");
eq(normalizePastedKey("lic_-QaZYBzul9wHN8gS"), "lic_-QaZYBzul9wHN8gS", "chave com hífen (b64url) não é truncada");
eq(normalizePastedKey("lic_0B-NQ-nFVKl-_er-"), "lic_0B-NQ-nFVKl-_er-", "chave terminando em hífen");

// entitlement colado direto (compat offline)
{
  const ent = "eyJmcCI6ImZmZmZmZmZmZGVhZGJlZWYiLCJob2xkZXIiOiJiZXRhLTIwQG9tbmlyaWZ0LmxvY2FsIn0" + ".97yRNAC0mpkSEEyuzs9MOoJZpPUc0oEhTT71g58fjoA_mxf7As5vXM1OGZBHgB5rk8WTilxfKSJkBQULAH3MBw";
  eq(normalizePastedKey(` ${ent} `), ent, "entitlement payload.sig preservado inteiro");
}

// fail-open: sem chave reconhecível, o servidor é quem decide
eq(normalizePastedKey("  nada aqui  "), "nada aqui", "texto sem chave volta como trim");
eq(normalizePastedKey(""), "", "string vazia não quebra");

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) {
  process.exit(1);
}