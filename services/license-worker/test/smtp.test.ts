import { describe, it, expect } from "vitest";
import { finalCode, readChunk } from "../src/smtp";

describe("finalCode", () => {
  it("ignora linha incompleta (sem CRLF)", () => {
    expect(finalCode("220 omni")).toBeNull();
    expect(finalCode("250-PIPELINING\r\n250 OK")).toBeNull();
  });

  it("aceita resposta terminada em CRLF", () => {
    expect(finalCode("220 omnimail ESMTP Postfix\r\n")).toBe(220);
  });

  it("usa o código da linha final em resposta multi-linha", () => {
    expect(finalCode("250-PIPELINING\r\n250-8BITMIME\r\n250 OK\r\n")).toBe(250);
  });

  it("devolve null quando só há continuações ou buffer vazio", () => {
    expect(finalCode("250-PIPELINING\r\n250-8BITMIME\r\n")).toBeNull();
    expect(finalCode("")).toBeNull();
  });
});

describe("readChunk", () => {
  it("estoura timeout quando o servidor não responde", async () => {
    const neverReader = {
      read: () => new Promise<ReadableStreamReadResult<Uint8Array>>(() => {}),
    } as ReadableStreamDefaultReader<Uint8Array>;

    await expect(readChunk(neverReader, 30)).rejects.toThrow(/timeout|esgotado/i);
  });

  it("falha quando a conexão fecha", async () => {
    const closedReader = {
      read: async () => ({ value: undefined, done: true } as ReadableStreamReadResult<Uint8Array>),
    } as ReadableStreamDefaultReader<Uint8Array>;

    await expect(readChunk(closedReader, 1000)).rejects.toThrow(/fechada/i);
  });

  it("devolve os bytes lidos", async () => {
    const okReader = {
      read: async () => ({
        value: new TextEncoder().encode("220 ok\r\n"),
        done: false,
      } as ReadableStreamReadResult<Uint8Array>),
    } as ReadableStreamDefaultReader<Uint8Array>;

    expect(new TextDecoder().decode(await readChunk(okReader, 1000))).toBe("220 ok\r\n");
  });
});