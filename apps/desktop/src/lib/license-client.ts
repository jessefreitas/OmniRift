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

export async function licenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_status");
}

export async function licenseActivate(key: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_activate", { key });
}

/** `count` ainda cabe no limite? (0 = ilimitado). */
export function withinLimit(limit: number, count: number): boolean {
  return limit === 0 || count < limit;
}
