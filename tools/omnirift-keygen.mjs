#!/usr/bin/env node
// omnirift-keygen — gera uma chave de licença do beta vinculada a um fingerprint.
//
// Uso:  node tools/omnirift-keygen.mjs <fingerprint> [holder] [diasValidade]
//   ex: node tools/omnirift-keygen.mjs 9f3a1c0b77e2d4a1 "Fulano" 90
//
// Requer a chave PRIVADA em tools/.omnirift-license.key (gitignored — NÃO comitar
// e NÃO distribuir; só ela gera chaves válidas). A pública correspondente está
// embutida em src-tauri/src/commands/license.rs.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const KEYFILE = path.join(dir, ".omnirift-license.key");
const b64url = (b) => Buffer.from(b).toString("base64url");

const [, , fp, holder = "beta", days] = process.argv;
if (!fp) {
  console.error("uso: node tools/omnirift-keygen.mjs <fingerprint> [holder] [diasValidade]");
  process.exit(1);
}
if (!fs.existsSync(KEYFILE)) {
  console.error(`chave privada não encontrada em ${KEYFILE}`);
  process.exit(1);
}

const priv = crypto.createPrivateKey({
  key: Buffer.from(fs.readFileSync(KEYFILE, "utf8").trim(), "base64"),
  format: "der",
  type: "pkcs8",
});

// tier:"full" explícito = tudo liberado (o license.rs já assume full por default,
// mas explicitar evita depender do default). Beta de lançamento: days=60.
const payload = { fp, holder, tier: "full" };
if (days) payload.exp = Math.floor(Date.now() / 1000) + Number(days) * 86400;

const payloadB64 = b64url(JSON.stringify(payload));
const sig = crypto.sign(null, Buffer.from(payloadB64), priv);
console.log(`${payloadB64}.${b64url(sig)}`);
