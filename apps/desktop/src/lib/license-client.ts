// src/lib/license-client.ts
//
// Gate de licença do beta. Verificação é toda no Rust (offline, Ed25519); aqui
// só a ponte. Em build debug o backend devolve activated:true (dev não trava).

import { invoke } from "@tauri-apps/api/core";

export interface LicenseStatus {
  activated: boolean;
  fingerprint: string;
  holder: string | null;
  detail: string | null;
}

export async function licenseStatus(): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_status");
}

export async function licenseActivate(key: string): Promise<LicenseStatus> {
  return invoke<LicenseStatus>("license_activate", { key });
}
