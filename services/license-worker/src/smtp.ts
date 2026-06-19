// Cliente SMTP mínimo sobre TCP do Cloudflare Workers (`cloudflare:sockets`).
// Conecta no omnimail (porta 465, TLS implícito), faz AUTH LOGIN e envia 1 email.
// Workers SÃO capazes de TCP — não precisa de relay/n8n.
import { connect } from "cloudflare:sockets";

export interface SmtpConfig {
  host: string;
  port: number;
  user: string;
  pass: string;
}

const b64utf8 = (s: string) => btoa(String.fromCharCode(...new TextEncoder().encode(s)));

/** Envia 1 email HTML. Lança em erro de protocolo (o chamador trata best-effort). */
export async function smtpSend(
  cfg: SmtpConfig,
  from: string,
  to: string,
  subject: string,
  html: string,
): Promise<void> {
  // Defesa em profundidade: CR/LF em from/to injetaria comandos/headers SMTP.
  if (/[\r\n]/.test(from) || /[\r\n]/.test(to)) throw new Error("SMTP: endereço com CR/LF (injeção bloqueada)");
  const socket = connect({ hostname: cfg.host, port: cfg.port }, { secureTransport: "on", allowHalfOpen: false });
  const writer = socket.writable.getWriter();
  const reader = socket.readable.getReader();
  const enc = new TextEncoder();
  const dec = new TextDecoder();
  let buf = "";

  // Última linha de status "final" (código seguido de espaço, não de hífen).
  const finalCode = (s: string): number | null => {
    for (const line of s.split(/\r?\n/).filter(Boolean).reverse()) {
      const m = line.match(/^(\d{3}) /);
      if (m) return Number(m[1]);
    }
    return null;
  };
  const read = async (expect: number): Promise<void> => {
    for (;;) {
      const code = finalCode(buf);
      if (code !== null) {
        if (code !== expect) throw new Error(`SMTP esperava ${expect}, veio ${buf.trim().slice(0, 120)}`);
        buf = "";
        return;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("SMTP: conexão fechada");
      buf += dec.decode(value);
    }
  };
  const cmd = async (line: string, expect: number): Promise<void> => {
    await writer.write(enc.encode(line + "\r\n"));
    await read(expect);
  };

  try {
    await read(220); // greeting
    await cmd("EHLO omnirift-license-worker", 250);
    await cmd("AUTH LOGIN", 334);
    await cmd(b64utf8(cfg.user), 334);
    await cmd(b64utf8(cfg.pass), 235);
    await cmd(`MAIL FROM:<${from}>`, 250);
    await cmd(`RCPT TO:<${to}>`, 250);
    await cmd("DATA", 354);

    const headers = [
      `From: ${from}`,
      `To: ${to}`,
      `Subject: =?UTF-8?B?${b64utf8(subject)}?=`,
      "MIME-Version: 1.0",
      "Content-Type: text/html; charset=utf-8",
      "Content-Transfer-Encoding: 8bit",
    ].join("\r\n");
    // Normaliza quebras + dot-stuffing (linha que começa com "." vira "..").
    const body = html.replace(/\r?\n/g, "\r\n").replace(/^\./gm, "..");
    await writer.write(enc.encode(headers + "\r\n\r\n" + body + "\r\n.\r\n"));
    await read(250);
    await cmd("QUIT", 221);
  } finally {
    try {
      await writer.close();
    } catch {
      /* ignore */
    }
  }
}
