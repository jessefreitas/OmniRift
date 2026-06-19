// Assinatura Ed25519 do entitlement — usa Web Crypto (CF Workers suportam Ed25519),
// com a chave PRIVADA pkcs8 (a MESMA de tools/.omnirift-license.key). Produz o
// formato que o license.rs verifica offline: `payload_b64.sig_b64` (Ed25519 sobre
// os BYTES da string payload_b64). payload = { fp, holder, exp, tier, lim? }.

function b64urlFromBytes(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64.trim());
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function importSigningKey(pkcs8B64: string): Promise<CryptoKey> {
  // pkcs8B64 = conteúdo de tools/.omnirift-license.key (base64 do DER pkcs8 Ed25519).
  return crypto.subtle.importKey("pkcs8", bytesFromB64(pkcs8B64), { name: "Ed25519" }, false, ["sign"]);
}

export interface EntitlementPayload {
  fp: string; // fingerprint da máquina (device-bound)
  holder: string; // email/license id
  exp: number; // epoch s
  tier: "full"; // só full é emitido (community é o default sem token)
  lim?: { canvas: number; agents: number; floors: number };
}

/** Assina o entitlement → string `payload_b64.sig_b64` (formato do license.rs). */
export async function signEntitlement(pkcs8B64: string, payload: EntitlementPayload): Promise<string> {
  const payloadB64 = b64urlFromBytes(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importSigningKey(pkcs8B64);
  const sig = new Uint8Array(await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(payloadB64)));
  return `${payloadB64}.${b64urlFromBytes(sig)}`;
}

/** Id aleatório curto (license/device). */
export function randomId(prefix: string): string {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${b64urlFromBytes(b)}`;
}
