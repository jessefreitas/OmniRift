// src/lib/dev-tools.ts
//
// Conversores estilo DevToys — funções puras, sem backend. Cada operação é
// (string) => string | Promise<string>. Erros viram throw e a UI mostra.

import { parse as yamlParse, stringify as yamlStringify } from "yaml";

const enc = new TextEncoder();
const dec = new TextDecoder();

/** Base64 unicode-safe (passa pelos bytes UTF-8). */
function b64encode(s: string): string {
  return btoa(String.fromCharCode(...enc.encode(s)));
}
function b64decode(s: string): string {
  return dec.decode(Uint8Array.from(atob(s.trim()), (c) => c.charCodeAt(0)));
}

/** base64url (JWT) → bytes → string. */
function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + pad;
  return dec.decode(Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)));
}

function jwtDecode(token: string): string {
  const parts = token.trim().split(".");
  if (parts.length < 2) throw new Error("JWT inválido: precisa de header.payload[.signature]");
  const header = JSON.parse(b64urlDecode(parts[0]));
  const payload = JSON.parse(b64urlDecode(parts[1]));
  const out: Record<string, unknown> = { header, payload };
  // expande exp/iat/nbf pra data legível
  for (const k of ["exp", "iat", "nbf"] as const) {
    if (typeof payload[k] === "number") {
      (out as Record<string, unknown>)[`${k}_iso`] = new Date(payload[k] * 1000).toISOString();
    }
  }
  return JSON.stringify(out, null, 2);
}

async function sha(algo: "SHA-1" | "SHA-256" | "SHA-512", s: string): Promise<string> {
  const buf = await crypto.subtle.digest(algo, enc.encode(s));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function tsToDate(input: string): string {
  const raw = input.trim();
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error("não é um timestamp numérico");
  // >= 1e12 assume milissegundos, senão segundos
  const ms = Math.abs(n) >= 1e12 ? n : n * 1000;
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) throw new Error("timestamp fora do intervalo");
  return `ISO:    ${d.toISOString()}\nLocal:  ${d.toString()}\nUnix s: ${Math.floor(ms / 1000)}\nUnix ms:${ms}`;
}

function dateToTs(input: string): string {
  const d = new Date(input.trim());
  if (Number.isNaN(d.getTime())) throw new Error("data não reconhecida (tente ISO 8601)");
  const ms = d.getTime();
  return `Unix s:  ${Math.floor(ms / 1000)}\nUnix ms: ${ms}\nISO:     ${d.toISOString()}`;
}

export interface DevTool {
  id: string;
  label: string;
  /** Texto de placeholder pro input. */
  hint: string;
  run: (input: string) => string | Promise<string>;
}

export const DEV_TOOLS: DevTool[] = [
  { id: "b64enc", label: "Base64 Encode", hint: "texto pra codificar", run: b64encode },
  { id: "b64dec", label: "Base64 Decode", hint: "base64 pra decodificar", run: b64decode },
  { id: "urlenc", label: "URL Encode", hint: "texto com espaços & símbolos", run: (s) => encodeURIComponent(s) },
  { id: "urldec", label: "URL Decode", hint: "%20%21 …", run: (s) => decodeURIComponent(s) },
  { id: "jwt", label: "JWT Decode", hint: "eyJhbGciOi…", run: jwtDecode },
  { id: "sha256", label: "SHA-256", hint: "texto pra hashear", run: (s) => sha("SHA-256", s) },
  { id: "sha1", label: "SHA-1", hint: "texto pra hashear", run: (s) => sha("SHA-1", s) },
  { id: "sha512", label: "SHA-512", hint: "texto pra hashear", run: (s) => sha("SHA-512", s) },
  { id: "json2yaml", label: "JSON → YAML", hint: '{ "a": 1 }', run: (s) => yamlStringify(JSON.parse(s)) },
  { id: "yaml2json", label: "YAML → JSON", hint: "a: 1", run: (s) => JSON.stringify(yamlParse(s), null, 2) },
  { id: "jsonfmt", label: "JSON Format", hint: '{"a":1}', run: (s) => JSON.stringify(JSON.parse(s), null, 2) },
  { id: "jsonmin", label: "JSON Minify", hint: "{ ... }", run: (s) => JSON.stringify(JSON.parse(s)) },
  { id: "ts2date", label: "Timestamp → Data", hint: "1700000000", run: tsToDate },
  { id: "date2ts", label: "Data → Timestamp", hint: "2024-01-01T00:00:00Z", run: dateToTs },
  { id: "uuid", label: "UUID v4 (gerar)", hint: "(clica Run)", run: () => crypto.randomUUID() },
];

export function findTool(id: string): DevTool {
  return DEV_TOOLS.find((t) => t.id === id) ?? DEV_TOOLS[0];
}
