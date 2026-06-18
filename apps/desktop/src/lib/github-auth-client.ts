// src/lib/github-auth-client.ts
//
// Login no GitHub via OAuth Device Flow (sem servidor de redirect — ideal p/
// desktop). Precisa de um Client ID de um OAuth App "OmniRift" (com Device Flow
// habilitado) — registrado em github.com/settings/applications/new. O backend
// (github_auth.rs) fala com o GitHub via reqwest, fora do WebKit.

import { invoke } from "@tauri-apps/api/core";

export interface DeviceStart {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  interval: number;
  expiresIn: number;
}

export interface DevicePoll {
  /** "ok" (tem token) | "pending" | "slow_down" | "error". */
  status: string;
  token: string | null;
  error: string | null;
}

export async function githubDeviceStart(clientId: string): Promise<DeviceStart> {
  return invoke<DeviceStart>("github_device_start", { clientId });
}

export async function githubDevicePoll(clientId: string, deviceCode: string): Promise<DevicePoll> {
  return invoke<DevicePoll>("github_device_poll", { clientId, deviceCode });
}

const CID_KEY = "omnirift-github-client-id";

export function loadGithubClientId(): string {
  try { return localStorage.getItem(CID_KEY) || ""; } catch { return ""; }
}
export function saveGithubClientId(id: string): void {
  try { localStorage.setItem(CID_KEY, id); } catch { /* localStorage off */ }
}
