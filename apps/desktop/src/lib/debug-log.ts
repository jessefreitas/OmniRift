// src/lib/debug-log.ts
//
// Grava logs em DISCO na hora (~/.omnirift/debug.log via comando Rust) — sobrevive ao WebView
// travado (tela preta), diferente do ring buffer só-memória do diagnostics.ts. Mais um detector
// de LOOP DE RENDER: se um componente re-renderiza demais num piscar, grava QUAL foi ANTES de a
// UI congelar de vez. Loop de render é a causa nº1 de tela preta neste app (WebKitGTK).

import { invoke } from "@tauri-apps/api/core";

/** Envia uma linha pro debug.log (fire-and-forget; erro engolido — logger nunca quebra o app). */
export function logToDisk(line: string): void {
  void invoke("debug_log_write", { line }).catch(() => {});
}

/** Marca uma nova sessão no log (boot) e devolve o path do arquivo (pro usuário achar). */
export async function markBoot(label: string): Promise<string> {
  try {
    await invoke("debug_log_mark", { label });
    return await invoke<string>("debug_log_path");
  } catch {
    return "";
  }
}

// ── Detector de loop de render ──────────────────────────────────────────────
// Conta renders por chave numa janela de 1s. Acima do teto, grava UM alerta (com cooldown, pra
// não inundar o disco) apontando o componente culpado. O normal é <5 renders/s por nó.
const RENDER_WINDOW_MS = 1000;
const RENDER_LIMIT = 60;
const ALERT_COOLDOWN_MS = 3000;
const counters = new Map<string, { count: number; windowStart: number; alertedAt: number }>();

/** Chame no CORPO do componente (a cada render). Detecta e grava loops de render. */
export function trackRender(key: string): void {
  const now = performance.now();
  let c = counters.get(key);
  if (!c) {
    c = { count: 0, windowStart: now, alertedAt: -ALERT_COOLDOWN_MS };
    counters.set(key, c);
  }
  if (now - c.windowStart > RENDER_WINDOW_MS) {
    c.count = 0;
    c.windowStart = now;
  }
  c.count++;
  if (c.count > RENDER_LIMIT && now - c.alertedAt > ALERT_COOLDOWN_MS) {
    c.alertedAt = now;
    logToDisk(
      `[${new Date().toISOString()}] [🔁 RENDER-LOOP] ${key} — ${c.count} renders em <1s (provável causa de tela preta)`,
    );
  }
}
