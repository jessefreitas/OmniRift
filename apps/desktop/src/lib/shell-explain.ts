// src/lib/shell-explain.ts
//
// explainshell offline: tokeniza um comando shell e classifica cada pedaço
// (comando, flag, operador, argumento), expandindo flags agrupadas (-xzvf →
// x z v f). O resumo do comando em si vem do man-db via whatis_lookup (Rust).

export type SegKind = "command" | "flag" | "operator" | "argument" | "string";

export interface Segment {
  text: string;
  kind: SegKind;
  explanation: string;
  /** Comando de contexto (pra enriquecer via whatis depois). */
  command?: string;
}

/** Operadores e redirects do shell. */
const OPERATORS: Record<string, string> = {
  "|": "pipe — manda o stdout do comando da esquerda pro stdin do da direita",
  "||": "OU lógico — roda o próximo só se o anterior falhar (exit ≠ 0)",
  "&&": "E lógico — roda o próximo só se o anterior tiver sucesso (exit 0)",
  ";": "separador — roda os comandos em sequência, sem depender do resultado",
  "&": "background — roda o comando de forma assíncrona (não bloqueia o shell)",
  ">": "redireciona stdout pra um arquivo (sobrescreve)",
  ">>": "redireciona stdout pra um arquivo (anexa no fim)",
  "<": "redireciona um arquivo pro stdin do comando",
  "2>": "redireciona stderr pra um arquivo",
  "2>&1": "junta o stderr no mesmo destino do stdout",
  "&>": "redireciona stdout e stderr pro mesmo arquivo",
};

/** Flags single-char por comando — pra expandir clusters tipo `tar -xzvf`. */
const CHAR_FLAGS: Record<string, Record<string, string>> = {
  tar: { x: "extrai arquivos", c: "cria um arquivo .tar", t: "lista o conteúdo", z: "gzip (.gz)", j: "bzip2 (.bz2)", v: "verboso (mostra os arquivos)", f: "próximo argumento é o nome do arquivo", a: "detecta compressão pela extensão" },
  ls: { l: "formato longo (permissões, dono, tamanho)", a: "mostra ocultos (dotfiles)", h: "tamanhos legíveis (K, M, G)", R: "recursivo", t: "ordena por data de modificação", r: "ordem reversa", S: "ordena por tamanho" },
  rm: { r: "recursivo (apaga diretórios e conteúdo)", f: "força — sem confirmação, ignora inexistentes", i: "pergunta antes de cada remoção", v: "verboso" },
  cp: { r: "recursivo", a: "preserva tudo (modo arquivo)", v: "verboso", f: "força", p: "preserva atributos" },
  grep: { i: "ignora maiúsc/minúsc", r: "recursivo nos diretórios", n: "mostra número da linha", v: "inverte (linhas que NÃO casam)", l: "só os nomes dos arquivos", E: "regex estendida", w: "casa palavra inteira", c: "conta as ocorrências" },
  ps: { a: "todos os processos com terminal", u: "formato com usuário", x: "inclui sem terminal controlador", e: "todos os processos", f: "formato completo (árvore)" },
  chmod: {},
};

/** Flags longas/curtas de alto valor por comando. */
const NAMED_FLAGS: Record<string, Record<string, string>> = {
  curl: { "-X": "método HTTP (GET/POST/…)", "-H": "header HTTP", "-d": "corpo da requisição (POST)", "-o": "salva a saída num arquivo", "-O": "salva com o nome remoto", "-L": "segue redirects", "-s": "silencioso", "-i": "inclui os headers da resposta", "-k": "ignora erro de certificado TLS", "-u": "credencial user:senha", "--json": "corpo JSON + headers de content-type" },
  git: { "-m": "mensagem do commit", "-a": "stage de tudo que já é rastreado", "-b": "cria/checa uma branch", "--amend": "reescreve o último commit", "-f": "força", "--hard": "reset destrutivo (descarta mudanças)" },
  docker: { "-d": "detached (background)", "-p": "mapeia porta host:container", "-v": "monta volume", "-e": "variável de ambiente", "-it": "interativo + TTY", "--rm": "remove o container ao sair", "--name": "nome do container" },
  ssh: { "-p": "porta", "-i": "chave privada", "-L": "túnel local", "-N": "não roda comando (só túnel)", "-v": "verboso/debug" },
  find: { "-name": "casa pelo nome (glob)", "-type": "tipo (f arquivo, d diretório)", "-exec": "roda um comando em cada achado", "-delete": "apaga os achados", "-mtime": "filtra por data de modificação", "-iname": "como -name mas case-insensitive" },
  npm: { "-g": "global", "--save-dev": "salva em devDependencies", "-D": "salva em devDependencies", "--save": "salva em dependencies" },
  chmod: { "+x": "adiciona permissão de execução", "-R": "recursivo" },
};

interface RawTok { text: string; }

/** Tokeniza respeitando aspas simples/duplas. */
function tokenize(cmd: string): RawTok[] {
  const toks: RawTok[] = [];
  const re = /\s*("[^"]*"|'[^']*'|\|\||&&|2>&1|2>|&>|>>|[|;&<>]|[^\s|;&<>]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cmd)) !== null) {
    if (m[1]) toks.push({ text: m[1] });
  }
  return toks;
}

const CMD_STARTERS = new Set(["|", "||", "&&", ";", "&"]);

/** Classifica os tokens em segmentos explicados. */
export function explainShell(cmd: string): Segment[] {
  const toks = tokenize(cmd);
  const segs: Segment[] = [];
  let curCmd = "";
  let expectCommand = true;

  for (const { text } of toks) {
    // Operador / redirect
    if (text in OPERATORS) {
      segs.push({ text, kind: "operator", explanation: OPERATORS[text] });
      if (CMD_STARTERS.has(text)) expectCommand = true;
      continue;
    }
    // String entre aspas
    if (/^["'].*["']$/.test(text)) {
      segs.push({ text, kind: "string", explanation: "literal entre aspas (não sofre split/glob)" });
      continue;
    }
    // Comando (primeira palavra de cada segmento)
    if (expectCommand && !text.startsWith("-")) {
      curCmd = text.split("/").pop() || text;
      segs.push({ text, kind: "command", explanation: "", command: curCmd });
      expectCommand = false;
      continue;
    }
    // Flag
    if (text.startsWith("-") && text.length > 1) {
      const named = NAMED_FLAGS[curCmd]?.[text];
      if (named) {
        segs.push({ text, kind: "flag", explanation: named, command: curCmd });
        continue;
      }
      // Cluster de flags curtas (-xzvf) → expande char a char
      if (/^-[a-zA-Z]{2,}$/.test(text) && CHAR_FLAGS[curCmd]) {
        const charMap = CHAR_FLAGS[curCmd];
        const parts = text
          .slice(1)
          .split("")
          .map((c) => (charMap[c] ? `-${c}: ${charMap[c]}` : `-${c}: opção`))
          .join("  ·  ");
        segs.push({ text, kind: "flag", explanation: parts, command: curCmd });
        continue;
      }
      // Flag única conhecida char-level
      const single = CHAR_FLAGS[curCmd]?.[text.slice(1)];
      segs.push({ text, kind: "flag", explanation: single ?? "opção/flag do comando", command: curCmd });
      continue;
    }
    // Argumento comum
    segs.push({ text, kind: "argument", explanation: "argumento", command: curCmd });
  }
  return segs;
}
