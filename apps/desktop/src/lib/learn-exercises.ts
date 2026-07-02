// src/lib/learn-exercises.ts
//
// Catálogo de trilhas do OmniPartner Aprender (Fase 9, fatia A0+) — hardcoded no
// front por enquanto; a trilha compilada em Rust chega na fatia A2 (learn/tracks.rs).
// Cada exercício é VERIFICÁVEL: `condition` é um comando shell POSIX rodado no cwd
// do projeto via `run_check` (exit 0 = passou) — mesma máquina do 🎯 Goal/TURBO.
// Se a ferramenta da trilha faltar (python3/node), o output do check já traz o
// "command not found" e o tutor explica (comportamento A0).
//
// Trilha 4 = HTML/CSS (e NÃO Rust script-style): `rustc` one-file exigiria toolchain
// completa (~600MB, iniciante nunca tem), binário temporário e output de erro que é
// uma parede de diagnóstico — frágil demais pra um check de aprendiz. HTML/CSS é
// zero-toolchain (só grep, garantido em POSIX) e determinístico.

export interface LearnExercise {
  id: string;
  /** Título curto (aparece no card do exercício). */
  title: string;
  /** Enunciado completo — o que a pessoa deve fazer, em linguagem de aprendiz. */
  statement: string;
  /** O que deve existir no cwd do projeto ao final (objetivo verificável). */
  goal: string;
  /** Comando shell POSIX rodado no cwd — exit 0 = exercício concluído. */
  condition: string;
  /** Dicas internas por nível (1..3). Nível 3 = pode revelar a solução. */
  hints: [string, string, string];
}

/** Uma trilha = linguagem escolhida pelo aprendiz, com progressão de exercícios. */
export interface LearnTrack {
  id: string;
  /** Nome da linguagem (vai pro seletor e pro system-prompt do tutor). */
  label: string;
  emoji: string;
  /** Exercícios em ordem de progressão (1º = mais básico). */
  exercises: LearnExercise[];
}

/** Nível máximo de dica — no nível máximo (e SÓ nele) o tutor pode dar a solução. */
export const MAX_HINT_LEVEL = 3;

/** Exercício universal do A0: shell script de soma — funciona em qualquer projeto
 *  (Linux/mac; só precisa de bash), sem depender de stack ou dependências. */
export const HELLO_SUM_EXERCISE: LearnExercise = {
  id: "hello-sum-sh",
  title: "Script de soma em shell",
  statement:
    "Crie um script `scripts/hello.sh` no projeto atual que receba DOIS números " +
    "como argumentos e imprima a soma deles (só o número, numa linha). " +
    "Ex.: `bash scripts/hello.sh 2 3` deve imprimir `5`.",
  goal: "Arquivo scripts/hello.sh que imprime a soma de dois argumentos numéricos.",
  // Dois casos pra soma de verdade (não passa com `echo 5` fixo).
  condition: "bash scripts/hello.sh 2 3 | grep -q '^5$' && bash scripts/hello.sh 10 32 | grep -q '^42$'",
  hints: [
    // Nível 1 — só conceito/pergunta, zero código.
    "Pense: como um script shell enxerga o que foi digitado depois do nome dele? E que operador do shell faz aritmética com inteiros?",
    // Nível 2 — caminho apontado, fragmento de no máximo 1 linha, sem solução inteira.
    "Os argumentos chegam como $1 e $2; aritmética se faz com $(( … )). Falta juntar isso num echo dentro de scripts/hello.sh.",
    // Nível 3 — pode revelar a solução completa.
    "Solução: crie scripts/hello.sh com as linhas `#!/usr/bin/env bash` e `echo $(( $1 + $2 ))` (crie a pasta scripts/ antes, se não existir).",
  ],
};

const COUNT_LINES_EXERCISE: LearnExercise = {
  id: "count-lines-sh",
  title: "Contar linhas de um arquivo",
  statement:
    "Crie um script `scripts/count.sh` que receba o CAMINHO de um arquivo como " +
    "argumento e imprima quantas linhas ele tem (só o número). " +
    "Ex.: para um arquivo de 3 linhas, `bash scripts/count.sh arquivo.txt` deve imprimir `3`.",
  goal: "Arquivo scripts/count.sh que imprime o número de linhas do arquivo passado como argumento.",
  // Cria um arquivo temporário com 3 linhas e confere a saída (tolerante a padding do wc).
  condition:
    "f=$(mktemp); printf 'a\\nb\\nc\\n' > \"$f\"; bash scripts/count.sh \"$f\" | grep -q '^[[:space:]]*3$'; rc=$?; rm -f \"$f\"; exit $rc",
  hints: [
    "Que comando clássico do Unix conta linhas, palavras e caracteres de um arquivo? E como o script enxerga o caminho digitado depois do nome dele?",
    "O caminho chega em $1, e `wc -l < \"$1\"` imprime só o número (o `<` evita que o nome do arquivo apareça junto). Falta colocar isso em scripts/count.sh.",
    "Solução: crie scripts/count.sh com as linhas `#!/usr/bin/env bash` e `wc -l < \"$1\"` — redirecionar com `<` faz o wc ler o conteúdo sem imprimir o nome do arquivo.",
  ],
};

const SUM_ARGS_PY_EXERCISE: LearnExercise = {
  id: "sum-args-py",
  title: "Somar dois números em Python",
  statement:
    "Crie `scripts/soma.py` que receba DOIS números como argumentos de linha de comando " +
    "e imprima a soma (só o número, numa linha). " +
    "Ex.: `python3 scripts/soma.py 2 3` deve imprimir `5`.",
  goal: "Arquivo scripts/soma.py que imprime a soma de dois argumentos numéricos.",
  condition:
    "python3 scripts/soma.py 2 3 | grep -q '^5$' && python3 scripts/soma.py 10 32 | grep -q '^42$'",
  hints: [
    "Como um programa Python enxerga o que foi digitado depois do nome dele? Procure pelo módulo `sys`. E: os argumentos chegam como número ou como texto?",
    "`sys.argv[1]` e `sys.argv[2]` são strings — converta com `int(...)` antes de somar, e use `print` no resultado.",
    "Solução: crie scripts/soma.py com `import sys` e `print(int(sys.argv[1]) + int(sys.argv[2]))`.",
  ],
};

const JSON_FIELD_PY_EXERCISE: LearnExercise = {
  id: "json-field-py",
  title: "Ler um campo de um JSON",
  statement:
    "Crie `scripts/campo.py` que receba o caminho de um arquivo JSON e imprima o valor " +
    "do campo `nome`. Ex.: para `{\"nome\": \"OmniRift\"}`, " +
    "`python3 scripts/campo.py dados.json` deve imprimir `OmniRift`.",
  goal: "Arquivo scripts/campo.py que imprime o campo `nome` do JSON passado como argumento.",
  // Escreve um JSON temporário e confere que o campo `nome` sai sozinho na linha.
  condition:
    "f=$(mktemp); printf '{\"nome\": \"OmniRift\", \"versao\": 1}' > \"$f\"; python3 scripts/campo.py \"$f\" | grep -q '^OmniRift$'; rc=$?; rm -f \"$f\"; exit $rc",
  hints: [
    "Que módulo da biblioteca padrão do Python transforma texto JSON em dicionário? E como se abre um arquivo cujo caminho veio em sys.argv[1]?",
    "`json.load(open(sys.argv[1]))` devolve um dicionário — pegue a chave com `dados[\"nome\"]` e imprima com print.",
    "Solução: crie scripts/campo.py com `import json, sys`, depois `dados = json.load(open(sys.argv[1]))` e `print(dados[\"nome\"])`.",
  ],
};

const SUM_ARGS_JS_EXERCISE: LearnExercise = {
  id: "sum-args-js",
  title: "Somar dois números em JavaScript",
  statement:
    "Crie `scripts/soma.js` que receba DOIS números como argumentos de linha de comando " +
    "e imprima a soma (só o número, numa linha). " +
    "Ex.: `node scripts/soma.js 2 3` deve imprimir `5`.",
  goal: "Arquivo scripts/soma.js que imprime a soma de dois argumentos numéricos.",
  condition:
    "node scripts/soma.js 2 3 | grep -q '^5$' && node scripts/soma.js 10 32 | grep -q '^42$'",
  hints: [
    "Onde o Node guarda o que foi digitado depois do nome do script? (é um array global do `process`.) Em que posição os SEUS argumentos começam nesse array?",
    "`process.argv[2]` e `process.argv[3]` são strings — converta com `Number(...)` e use `console.log` na soma.",
    "Solução: crie scripts/soma.js com `console.log(Number(process.argv[2]) + Number(process.argv[3]))`.",
  ],
};

const JSON_FIELD_JS_EXERCISE: LearnExercise = {
  id: "json-field-js",
  title: "Ler um campo de um JSON",
  statement:
    "Crie `scripts/campo.js` que receba o caminho de um arquivo JSON e imprima o valor " +
    "do campo `nome`. Ex.: para `{\"nome\": \"OmniRift\"}`, " +
    "`node scripts/campo.js dados.json` deve imprimir `OmniRift`.",
  goal: "Arquivo scripts/campo.js que imprime o campo `nome` do JSON passado como argumento.",
  condition:
    "f=$(mktemp); printf '{\"nome\": \"OmniRift\", \"versao\": 1}' > \"$f\"; node scripts/campo.js \"$f\" | grep -q '^OmniRift$'; rc=$?; rm -f \"$f\"; exit $rc",
  hints: [
    "Como se lê um arquivo em Node com a biblioteca padrão (módulo `fs`)? E que função nativa transforma texto JSON em objeto?",
    "`fs.readFileSync(process.argv[2], \"utf8\")` devolve o texto; `JSON.parse(...)` vira objeto — imprima o campo `nome` dele.",
    "Solução: crie scripts/campo.js com `const fs = require(\"fs\");` e `console.log(JSON.parse(fs.readFileSync(process.argv[2], \"utf8\")).nome);`.",
  ],
};

const FIRST_PAGE_HTML_EXERCISE: LearnExercise = {
  id: "first-page-html",
  title: "Primeira página HTML",
  statement:
    "Crie `site/index.html` com a estrutura básica de uma página e um título `<h1>` " +
    "com exatamente o texto `Meu primeiro site`.",
  goal: "Arquivo site/index.html contendo <h1>Meu primeiro site</h1>.",
  condition: "grep -qi '<h1>[[:space:]]*Meu primeiro site[[:space:]]*</h1>' site/index.html",
  hints: [
    "Toda página HTML tem um esqueleto: html, head e body. Em qual deles fica o conteúdo VISÍVEL? E qual tag marca o título mais importante da página?",
    "Dentro do `<body>`, use `<h1>…</h1>` com o texto pedido. O arquivo precisa se chamar site/index.html (crie a pasta site/ antes).",
    "Solução: crie site/index.html com `<!DOCTYPE html><html><head><title>Meu site</title></head><body><h1>Meu primeiro site</h1></body></html>`.",
  ],
};

const CSS_LINK_EXERCISE: LearnExercise = {
  id: "css-link-web",
  title: "Estilizar com CSS externo",
  statement:
    "Crie `site/style.css` com uma regra que mude a cor (`color`) do `h1`, e ligue o " +
    "arquivo na sua `site/index.html` usando a tag `<link>` dentro do `<head>`.",
  goal: "site/index.html com <link> para style.css + site/style.css com uma regra de color.",
  condition:
    "grep -qi '<link[^>]*style\\.css' site/index.html && grep -qi 'color[[:space:]]*:' site/style.css",
  hints: [
    "Como o HTML descobre que existe um arquivo de estilo separado? Existe uma tag no <head> só pra isso. E em CSS, como se escolhe QUAL elemento a regra afeta?",
    "No <head>: `<link rel=\"stylesheet\" href=\"style.css\">`. No CSS: seletor `h1 { … }` com a propriedade `color` dentro.",
    "Solução: adicione `<link rel=\"stylesheet\" href=\"style.css\">` no <head> de site/index.html e crie site/style.css com `h1 { color: rebeccapurple; }`.",
  ],
};

/** Trilhas disponíveis — a escolhida vai pro seletor da aba Aprender e contextualiza
 *  o system-prompt Socrático (lib/learn.ts). Progressão: exercises[0] → exercises[N]. */
export const LEARN_TRACKS: LearnTrack[] = [
  { id: "shell", label: "Shell", emoji: "🐚", exercises: [HELLO_SUM_EXERCISE, COUNT_LINES_EXERCISE] },
  { id: "python", label: "Python", emoji: "🐍", exercises: [SUM_ARGS_PY_EXERCISE, JSON_FIELD_PY_EXERCISE] },
  { id: "node", label: "JavaScript", emoji: "🟨", exercises: [SUM_ARGS_JS_EXERCISE, JSON_FIELD_JS_EXERCISE] },
  { id: "web", label: "HTML/CSS", emoji: "🌐", exercises: [FIRST_PAGE_HTML_EXERCISE, CSS_LINK_EXERCISE] },
];
