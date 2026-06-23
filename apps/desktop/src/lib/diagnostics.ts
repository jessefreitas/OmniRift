// Diagnóstico do OmniRift: captura logs de erro do frontend (console + eventos
// globais) e os envia, junto do bundle do backend (collect_diagnostics) + resumo
// do estado, pro endpoint privado /diag do worker — pra gente analisar bugs de
// testers que não conseguimos reproduzir. Gerado via dispatch Ollama + auditado.

import { invoke } from "@tauri-apps/api/core";
import { useCanvasStore } from "@/store/canvas-store";

const LICENSE_WORKER_URL = "https://omnirift-license-worker.jesse-vieira-freitas.workers.dev";

// Ring buffer dos logs de console do frontend (últimas N linhas).
const RING_CAPACITY = 400;
const ring: string[] = [];

let inited = false;
let originalError: typeof console.error;
let originalWarn: typeof console.warn;

function push(line: string) {
  ring.push(line);
  if (ring.length > RING_CAPACITY) {
    ring.splice(0, ring.length - RING_CAPACITY);
  }
}

/** Engata console.error/warn + erros globais no ring buffer. Idempotente. */
export function initDiagnosticsCapture(): void {
  if (inited) return;
  inited = true;

  originalError = console.error;
  originalWarn = console.warn;

  console.error = (...args: unknown[]) => {
    push(`[${new Date().toISOString()}] [error] ${args.map(String).join(" ")}`);
    originalError(...args);
  };

  console.warn = (...args: unknown[]) => {
    push(`[${new Date().toISOString()}] [warn] ${args.map(String).join(" ")}`);
    originalWarn(...args);
  };

  window.addEventListener("error", (e) => {
    push(`[error-event] ${e.message} @ ${e.filename}:${e.lineno}`);
  });

  window.addEventListener("unhandledrejection", (e) => {
    push(`[unhandledrejection] ${String(e.reason)}`);
  });
}

/** Coleta (backend + frontend + estado) e envia pro /diag. Retorna o id pra citar no suporte. */
export async function sendDiagnostics(note?: string): Promise<string> {
  let bundle = { appVersion: "", os: "", osVersion: "", logTail: "" };
  try {
    bundle = await invoke<typeof bundle>("collect_diagnostics");
  } catch {
    // Fallback: se o comando Tauri falhar, pelo menos manda o user agent.
    bundle.os = navigator.userAgent;
  }

  const s = useCanvasStore.getState();
  const stateSummary = JSON.stringify({
    projects: s.projects.length,
    floors: s.floors.length,
    terminals: s.allTerminalNodes().length,
    activeProjectId: s.activeProjectId,
    activeFloorId: s.activeFloorId,
  });

  const frontendLog = ring.join("\n");
  const logTail = bundle.logTail + "\n\n=== frontend console ===\n" + frontendLog;

  const res = await fetch(`${LICENSE_WORKER_URL}/diag`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      appVersion: bundle.appVersion,
      os: bundle.os,
      osVersion: bundle.osVersion,
      logTail,
      stateSummary,
      note: note ?? null,
    }),
  });

  if (!res.ok) {
    throw new Error(`diag HTTP ${res.status}`);
  }

  const data = await res.json();
  return String(data.id ?? "");
}
