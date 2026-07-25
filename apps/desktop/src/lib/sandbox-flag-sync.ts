// Espelha a feature flag `sandbox-workspace` pro backend Rust.
// O envelope bwrap vive em src-tauri (`sandbox::maybe_wrap`); a UI só liga/desliga
// via `sandbox_set_enabled`. Chamado no boot e sempre que a flag muda.

import { invoke } from "@tauri-apps/api/core";

const FLAG_KEY = "sandbox-workspace";

export async function syncSandboxFlag(enabled: boolean): Promise<void> {
  try {
    await invoke("sandbox_set_enabled", { enabled });
  } catch {
    /* best-effort — sem backend (web/dev) a flag local ainda persiste */
  }
}

export function isSandboxFlagKey(key: string): boolean {
  return key === FLAG_KEY;
}
