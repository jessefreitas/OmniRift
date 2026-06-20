#!/usr/bin/env node
// scripts/beta-renew.mjs — renova/lista os beta testers do OmniRift via endpoints
// admin do license-worker. Operação deliberada do dono (não passa pelo anti-abuso).
//
// Uso:
//   OMNIRIFT_ADMIN_TOKEN=... node scripts/beta-renew.mjs --list
//   OMNIRIFT_ADMIN_TOKEN=... node scripts/beta-renew.mjs <email|lic_key> +30
//
// Env:
//   OMNIRIFT_ADMIN_TOKEN  (obrigatório) — secret ADMIN_TOKEN do worker (pegar no cofre).
//   OMNIRIFT_WORKER_URL   (opcional)    — default: produção.

const WORKER =
  process.env.OMNIRIFT_WORKER_URL || "https://omnirift-license-worker.jesse-vieira-freitas.workers.dev";
const TOKEN = process.env.OMNIRIFT_ADMIN_TOKEN;

function die(msg) {
  console.error("erro:", msg);
  process.exit(1);
}

if (!TOKEN) die("defina OMNIRIFT_ADMIN_TOKEN (secret ADMIN_TOKEN do worker)");

const headers = { Authorization: `token ${TOKEN}`, "Content-Type": "application/json" };
const args = process.argv.slice(2);

async function list() {
  const res = await fetch(`${WORKER}/admin/beta/list`, { headers });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status}: ${data.error || "falha"}`);
  const betas = data.betas || [];
  if (!betas.length) {
    console.log("(nenhum beta)");
    return;
  }
  console.log(`${betas.length} beta(s):`);
  for (const b of betas) {
    console.log(`  ${String(b.email).padEnd(32)} ${String(b.daysLeft).padStart(4)}d  ${b.status}  ${b.licenseKey}`);
  }
}

async function renew(target, days) {
  const body = target.startsWith("lic_") ? { key: target, days } : { email: target, days };
  const res = await fetch(`${WORKER}/admin/beta/renew`, { method: "POST", headers, body: JSON.stringify(body) });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) die(`${res.status}: ${data.error || "falha"}`);
  const ends = new Date(data.betaEndsAt * 1000).toISOString().slice(0, 10);
  console.log(`✓ renovado: ${data.licenseKey} → expira ${ends} (+${days}d)`);
}

if (args[0] === "--list") {
  await list();
} else if (args.length === 2 && /^\+?\d+$/.test(args[1])) {
  await renew(args[0], parseInt(args[1].replace("+", ""), 10));
} else {
  console.log("uso:\n  node scripts/beta-renew.mjs --list\n  node scripts/beta-renew.mjs <email|lic_key> +<dias>");
  process.exit(args.length ? 1 : 0);
}
