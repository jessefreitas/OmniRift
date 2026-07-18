import { invoke } from "@tauri-apps/api/core";

// Contrato de cada sonda da sequência de boot
export type BootProbe = { label: string; run: () => Promise<string> };

// Estado retornado por uma sonda executada
export type ProbeResult = { label: string; status: string; ok: boolean };

// Sondas executadas durante a introdução estilo FRIDAY
export const BOOT_PROBES: BootProbe[] = [
  // Núcleo do aplicativo — presume-se ok, pois o frontend montou
  { label: "NÚCLEO OMNIRIFT", run: async () => "ONLINE" },

  // Interface renderizada
  { label: "INTERFACE", run: async () => "PRONTA" },

  // Provedores LLM configurados
  {
    label: "PROVEDORES LLM",
    run: async () => {
      const r = await invoke<any[]>("providers_list");
      return `${Array.isArray(r) ? r.length : 0} REGISTRADOS`;
    },
  },

  // Sessões de terminal PTY em execução
  {
    label: "SESSÕES PTY",
    run: async () => {
      const r = await invoke<any[]>("pty_list");
      return `${Array.isArray(r) ? r.length : 0} ATIVAS`;
    },
  },

  // Snapshots salvos do OmniGraph
  {
    label: "SNAPSHOTS OMNIGRAPH",
    run: async () => {
      const r = await invoke<any[]>("omnigraph_list_snapshots");
      return `${Array.isArray(r) ? r.length : 0}`;
    },
  },
];

// Executor individual: converte sucesso/erro em resultado uniforme
export async function runBootProbe(p: BootProbe): Promise<ProbeResult> {
  try {
    const status = await p.run();
    return { label: p.label, status, ok: true };
  } catch {
    return { label: p.label, status: "— indisponível", ok: false };
  }
}