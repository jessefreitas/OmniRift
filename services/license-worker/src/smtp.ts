import { connect } from "cloudflare:sockets";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
  timeoutMs?: number;
}

/**
 * Analisa o buffer acumulado de resposta SMTP e devolve o código da última
 * linha final COMPLETA (terminada em CRLF). Linhas de continuação (`^\d{3}-`)
 * são ignoradas. Se não houver resposta final completa, devolve `null`.
 */
export function finalCode(buf: string): number | null {
  // Cada linha SMTP deve terminar em \r\n.
  const lines = buf.split("\r\n");

  // Se o buffer não termina em CRLF, o último pedaço é incompleto e deve ser descartado.
  let i = lines.length - 1;
  if (!buf.endsWith("\r\n")) {
    i--;
  }

  for (; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;

    const match = line.match(/^(\d{3})([ -])/);
    if (!match) continue;

    // `^\d{3} ` é uma linha final; `^\d{3}-` é continuação.
    if (match[2] === " ") {
      return parseInt(match[1], 10);
    }
  }

  return null;
}

/**
 * Lê UM chunk do reader com timeout. Se a conexão for fechada, lança erro.
 * Se `value` vier undefined sem `done`, trata como array vazio.
 */
export async function readChunk(
  reader: { read(): Promise<{ value?: Uint8Array; done: boolean }> },
  timeoutMs: number
): Promise<Uint8Array> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`SMTP: timeout de leitura (${timeoutMs}ms)`));
    }, timeoutMs);
  });

  try {
    const result = await Promise.race([reader.read(), timeout]);
    if (result.done) {
      throw new Error("SMTP: conexão fechada");
    }
    return result.value ?? new Uint8Array(0);
  } finally {
    if (timer !== undefined) {
      clearTimeout(timer);
    }
  }
}

/** Codifica uma string UTF-8 em Base64, sem quebras de linha. */
function base64utf8(str: string): string {
  const bytes = new TextEncoder().encode(str);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

/**
 * Normaliza o HTML para quebras CRLF e aplica dot-stuffing.
 * Linhas começando com "." viram "..". O resultado já inclui o terminador
 * final `\r\n.\r\n`.
 */
function buildBody(html: string): string {
  const normalized = html.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const stuffed = lines.map((line) => (line.startsWith(".") ? `.${line}` : line));
  return `${stuffed.join("\r\n")}\r\n.\r\n`;
}

/**
 * Envia um e-mail HTML através de um servidor SMTP usando TLS implícito
 * (porta 465) sobre `cloudflare:sockets`.
 */
export async function smtpSend(
  cfg: SmtpConfig,
  from: string,
  to: string,
  subject: string,
  html: string
): Promise<void> {
  // Defesa contra command/header injection nos endereços.
  if (from.includes("\r") || from.includes("\n") || to.includes("\r") || to.includes("\n")) {
    throw new Error("SMTP: endereço com CR/LF (injeção bloqueada)");
  }

  const effectiveTimeout = cfg.timeoutMs ?? 10000;
  const decoder = new TextDecoder();

  let writer: WritableStreamDefaultWriter<Uint8Array> | undefined;
  let responseBuffer = "";

  try {
    // TLS implícito: secureTransport "on".
    const socket = connect(
      { hostname: cfg.host, port: cfg.port },
      { secureTransport: "on", allowHalfOpen: false }
    );

    const reader = socket.readable.getReader();
    writer = socket.writable.getWriter();

    const encodeLine = (line: string): Uint8Array =>
      new TextEncoder().encode(`${line}\r\n`);

    async function expectCode(expected: number): Promise<void> {
      while (true) {
        const chunk = await readChunk(reader, effectiveTimeout);
        responseBuffer += decoder.decode(chunk, { stream: true });

        const code = finalCode(responseBuffer);
        if (code === null) {
          continue; // resposta ainda incompleta
        }

        if (code !== expected) {
          throw new Error(
            `SMTP esperava ${expected}, veio ${responseBuffer.slice(0, 120)}`
          );
        }

        responseBuffer = "";
        return;
      }
    }

    async function sendLine(line: string): Promise<void> {
      await writer!.write(encodeLine(line));
    }

    // 1) Saudação do servidor.
    await expectCode(220);

    // 2) EHLO.
    await sendLine("EHLO omnirift-license-worker");
    await expectCode(250);

    // 3) Autenticação LOGIN.
    await sendLine("AUTH LOGIN");
    await expectCode(334);
    await sendLine(base64utf8(cfg.user));
    await expectCode(334);
    await sendLine(base64utf8(cfg.pass));
    await expectCode(235);

    // 4) Envelope.
    await sendLine(`MAIL FROM:<${from}>`);
    await expectCode(250);
    await sendLine(`RCPT TO:<${to}>`);
    await expectCode(250);

    // 5) DATA.
    await sendLine("DATA");
    await expectCode(354);

    // Cabeçalhos na ordem exigida.
    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${base64utf8(subject)}?=`,
      `Date: ${new Date().toUTCString().replace("GMT", "+0000")}`,
      `Message-ID: <${crypto.randomUUID()}@omnirift.local>`,
      `MIME-Version: 1.0`,
      `Content-Type: text/html; charset=utf-8`,
      `Content-Transfer-Encoding: 8bit`,
    ].join("\r\n");

    const message = `${headers}\r\n\r\n${buildBody(html)}`;
    await writer!.write(new TextEncoder().encode(message));
    await expectCode(250);

    // 6) Encerramento.
    await sendLine("QUIT");
    await expectCode(221);
  } finally {
    // Fecha o writer ignorando qualquer erro.
    if (writer) {
      try {
        await writer.close();
      } catch {
        // propositalmente ignorado
      }
    }
  }
}
