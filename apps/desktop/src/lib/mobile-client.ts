// src/lib/mobile-client.ts
//
// Ponte frontend pros 4 comandos do relay mobile (Mobile steering #9). O backend
// Rust já está pronto — aqui só tipamos e chamamos via invoke. Espelha o padrão
// do providers-client.ts. O `deviceToken` do offer é SEGREDO: nunca logar.

import { invoke } from "@tauri-apps/api/core";

/** Offer estruturado que vira QR/deep-link. O `deviceToken` é segredo. */
export interface PairingOffer {
  v: number;
  endpoint: string;
  deviceToken: string;
  publicKeyB64: string;
}

/** Resposta de `mobile_pairing_offer`: o offer + o deep-link pronto + o device pendente. */
export interface PairingResult {
  offer: PairingOffer;
  /** `omnirift://pair?code=<base64url(JSON)>` — já montado pelo backend. */
  deepLink: string;
  deviceId: string;
}

/** Um device pareado (ou pendente). camelCase, vindo do backend. */
export interface MobileDevice {
  deviceId: string;
  name: string;
  scope: string;
  steer: boolean;
  /** epoch (ms ou s conforme backend) do pareamento; 0 = ainda não pareou. */
  pairedAt: number;
  /** epoch do último contato; 0 = pendente (ainda não conectou). */
  lastSeenAt: number;
  /** conveniência do backend: lastSeenAt === 0. */
  pending: boolean;
}

/** Gera um pairing offer (a UI mostra como QR). `name` opcional rotula o device. */
export async function mobilePairingOffer(name?: string): Promise<PairingResult> {
  return invoke<PairingResult>("mobile_pairing_offer", { name: name ?? null });
}

/** Lista os devices pareados/pendentes (nunca devolve o token). */
export async function mobileDevicesList(): Promise<MobileDevice[]> {
  const res = await invoke<{ devices: MobileDevice[] }>("mobile_devices_list");
  return res.devices ?? [];
}

/** Revoga um device (cai no próximo heartbeat). `removed: bool`. */
export async function mobileRevoke(deviceId: string): Promise<boolean> {
  const res = await invoke<{ removed: boolean }>("mobile_revoke", { deviceId });
  return res.removed;
}

/** Concede/revoga steering (controle) p/ um device. `applied: bool` = device existe. */
export async function mobileSetSteering(
  deviceId: string,
  enabled: boolean,
): Promise<{ applied: boolean; steer: boolean }> {
  return invoke<{ applied: boolean; steer: boolean }>("mobile_set_steering", {
    deviceId,
    enabled,
  });
}

/** "há 3 min", "agora", "pendente". Humaniza um epoch (auto-detecta s vs ms). */
export function humanizeLastSeen(epoch: number, t: (k: string, f?: string) => string): string {
  if (!epoch) return t("mobile.pending", "pendente");
  const ms = epoch < 1e12 ? epoch * 1000 : epoch; // s → ms se vier em segundos
  const diff = Date.now() - ms;
  if (diff < 0 || diff < 30_000) return t("mobile.now", "agora");
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return t("mobile.minsAgo", "há {n} min").replace("{n}", String(mins));
  const hours = Math.floor(mins / 60);
  if (hours < 24) return t("mobile.hoursAgo", "há {n} h").replace("{n}", String(hours));
  const days = Math.floor(hours / 24);
  return t("mobile.daysAgo", "há {n} d").replace("{n}", String(days));
}
