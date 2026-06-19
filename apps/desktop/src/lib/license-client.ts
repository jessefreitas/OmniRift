// src/lib/license-client.ts
//
// Entitlement de tier (community/full). Verificação é toda no Rust (offline,
// Ed25519); aqui só a ponte + os limites efetivos. O app SEMPRE roda: sem
// entitlement full → community (limitado). Em debug o backend devolve full.

import { invoke } from "@tauri-apps/api/core";

/** Limites efetivos (0 = ilimitado). */
export interface Limits {
  canvas: number;
  agents: number;
  floors: number;
}

export interface LicenseStatus {
  /** true = entitlement full válido (ilimitado). */
  activated: boolean;
  tier: "community" | "full";
  fingerprint: string;
  holder: string | null;
  limits: Limits;
  exp: number | null;
  detail: string | null;
}

/** Limites da edição community (espelha COMMUNITY_* do license.rs). Gate só no
 *  nº de workspaces (canvas) = 1; agentes e paralelos ilimitados (0). */
export const COMMUNITY_LIMITS: Limits = { canvas: 1, agents: 0, floors: 0 };

/** License worker (server-authoritative): troca license key → entitlement device-bound. */
const LICENSE_WORKER_URL = "https://omnirift-license-worker.jesse-vieira-freitas.workers.dev";

export async function licenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_status");
}

/** Um entitlement é `payload.sig` (dois segmentos b64url). License key = `lic_…`. */
function isEntitlement(k: string): boolean {
  return k.includes(".") && !k.startsWith("lic_");
}

/**
 * Ativa a licença:
 * - **license key** (`lic_…`) → troca por um entitlement device-bound no worker
 *   `/activate` (manda o fingerprint desta máquina) e grava o entitlement.
 * - **entitlement** colado direto (`payload.sig`) → grava/verifica offline (compat).
 * A verificação final é sempre no Rust (Ed25519 offline).
 */
export async function licenseActivate(key: string): Promise<LicenseStatus> {
  const k = key.trim();
  let entitlement = k;
  if (!isEntitlement(k)) {
    const { fingerprint } = await licenseStatus();
    const res = await fetch(`${LICENSE_WORKER_URL}/activate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: k, fingerprint }),
    });
    const data = await res.json().catch(() => ({}) as { entitlement?: string; error?: string });
    if (!res.ok) throw new Error(data.error || `falha ao ativar (${res.status})`);
    if (!data.entitlement) throw new Error("o servidor não retornou um entitlement");
    entitlement = data.entitlement;
  }
  return invoke<LicenseStatus>("license_activate", { key: entitlement });
}

/** `count` ainda cabe no limite? (0 = ilimitado). */
export function withinLimit(limit: number, count: number): boolean {
  return limit === 0 || count < limit;
}
