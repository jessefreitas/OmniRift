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

// Flags que o BACKEND precisa conhecer no BOOT — antes de o frontend existir. São as que
// decidem se um serviço de rede sobe: relay 4G (disca um Worker externo), servidor LAN do
// mobile e o roteador OmniSwitch. Sem este espelho em disco, ligar a flag no painel não
// tinha efeito nenhum no que já subiu (ou deixou de subir) no boot.
const MIRRORED_FLAGS = new Set(["remote-4g-relay", "omniswitch", "mobile-relay-lan"]);

export function isMirroredFlagKey(key: string): boolean {
  return MIRRORED_FLAGS.has(key);
}

export async function syncMirroredFlag(key: string, enabled: boolean): Promise<void> {
  if (!MIRRORED_FLAGS.has(key)) return;
  try {
    await invoke("flag_mirror_set", { name: key, enabled });
  } catch {
    /* best-effort: sem backend (web/dev) a flag local ainda persiste */
  }
}
