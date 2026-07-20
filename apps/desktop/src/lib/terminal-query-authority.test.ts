import {
  backendOwnedColorQueries,
  consumeExpectedXtermColorReply,
  installTerminalQueryAuthority,
  type BackendOwnedColorCode,
} from "./terminal-query-authority";

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

{
  const handlers = new Map<number, (data: string) => boolean | Promise<boolean>>();
  let onData: ((data: string) => void) | null = null;
  const forwarded: string[] = [];
  let disposed = 0;
  const authority = installTerminalQueryAuthority({
    parser: {
      registerOscHandler(ident, callback) {
        handlers.set(ident, callback);
        return { dispose: () => disposed++ };
      },
    },
    onData(callback) {
      onData = callback;
      return { dispose: () => disposed++ };
    },
  });
  authority.setForwarder((data) => forwarded.push(data));

  eq(
    handlers.get(10)?.("#fff;?"),
    false,
    "handler misto faz fallthrough para o builtin aplicar o SET de foreground",
  );
  onData?.("\x1b]11;rgb:0000/1111/2222\x1b\\");
  eq(forwarded, [], "resposta de background da forma 10;#fff;? não chega ao PTY");

  eq(
    handlers.get(10)?.("?;#000"),
    false,
    "handler também preserva o SET posterior à query",
  );
  onData?.("\x1b]10;rgb:0000/1111/2222\x1b\\");
  onData?.("input comum");
  eq(forwarded, ["input comum"], "somente a resposta automática esperada é consumida");

  authority.dispose();
  eq(disposed, 3, "dispose remove onData e os dois handlers OSC");
}

eq(backendOwnedColorQueries(10, "?"), [10], "OSC 10 puro consulta foreground");
eq(backendOwnedColorQueries(11, "?"), [11], "OSC 11 puro consulta background");
eq(backendOwnedColorQueries(10, "#fff;?"), [11], "10;#fff;? consulta só background");
eq(
  backendOwnedColorQueries(10, "?;#000"),
  [10],
  "10;?;#000 consulta foreground e preserva o SET posterior",
);
eq(backendOwnedColorQueries(10, "?;?"), [10, 11], "duas posições de query são mantidas");
eq(
  backendOwnedColorQueries(10, "#fff;#000;?"),
  [],
  "query na posição do cursor é OSC 12 e não pertence ao backend",
);
eq(
  backendOwnedColorQueries(11, "?;?"),
  [11],
  "OSC 11 empilhado deixa a posição OSC 12 com o xterm",
);
eq(backendOwnedColorQueries(10, " ? "), [], "o parser segue a semântica exata do xterm");

{
  const pending: BackendOwnedColorCode[] = [11];
  eq(
    consumeExpectedXtermColorReply(pending, "\x1b]11;rgb:0000/1111/2222\x1b\\"),
    true,
    "descarta a resposta automática esperada do xterm",
  );
  eq(pending, [], "a resposta esperada é drenada uma única vez");
  eq(
    consumeExpectedXtermColorReply(pending, "\x1b]11;rgb:0000/1111/2222\x1b\\"),
    false,
    "a mesma sequência sem query pendente passa como input comum",
  );
}

{
  const pending: BackendOwnedColorCode[] = [10];
  eq(
    consumeExpectedXtermColorReply(pending, "\x1b]12;rgb:0000/1111/2222\x1b\\"),
    false,
    "OSC 12 não é engolido pelo gate de OSC 10/11",
  );
  eq(
    consumeExpectedXtermColorReply(pending, "texto comum"),
    false,
    "texto comum nunca é consumido",
  );
}

console.log(`\n${pass} passaram, ${fail} falharam`);
if (fail > 0) process.exit(1);
