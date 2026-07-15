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

// ── Watchdog de main thread bloqueada ───────────────────────────────────────
// WebKitGTK (Linux) não implementa PerformanceObserver com entryType "longtask",
// então usamos deriva de timer: se o setInterval acordou atrasado, a main thread
// esteve bloqueada durante o tick. Detecta QUE travou e por quanto, mas não QUEM travou.

const TICK_MS = 500;
const BLOCK_WARN_MS = 250;
const BLOCK_SEVERE_MS = 1000;
const BLOCK_COOLDOWN_MS = 2000;

let mainThreadWatchdogHandle: number | null = null;
let mainThreadWatchdogCleanup: (() => void) | null = null;
// -BLOCK_COOLDOWN_MS (e não 0): performance.now() começa perto de zero, então com 0 o
// cooldown engoliria os bloqueios dos 2 primeiros segundos — justo o boot. Mesmo
// padrão do `alertedAt` no detector de render acima.
let lastMainBlockLog = -BLOCK_COOLDOWN_MS;

/** Liga o watchdog. `getContext` (opcional) devolve contexto curto pra linha do log. */
export function startMainThreadWatchdog(getContext?: () => string): () => void {
  if (mainThreadWatchdogCleanup !== null) {
    return mainThreadWatchdogCleanup;
  }

  let expected = performance.now() + TICK_MS;

  mainThreadWatchdogHandle = window.setInterval(() => {
    const now = performance.now();
    const drift = now - expected;

    if (drift >= BLOCK_WARN_MS && now - lastMainBlockLog >= BLOCK_COOLDOWN_MS) {
      lastMainBlockLog = now;

      let context: string;
      try {
        context = getContext?.() ?? "";
      } catch {
        context = ""; // getContext nunca derruba o watchdog
      }

      const severity = drift >= BLOCK_SEVERE_MS ? "severo" : "jank";
      const roundedDrift = Math.round(drift);
      const contextPart = context ? ` ${context}` : "";
      logToDisk(
        `[${new Date().toISOString()}] [⏱ MAIN-BLOCK] main thread parada ~${roundedDrift}ms (${severity})${contextPart}`,
      );
    }

    expected = now + TICK_MS;
  }, TICK_MS);

  mainThreadWatchdogCleanup = () => {
    if (mainThreadWatchdogHandle !== null) {
      clearInterval(mainThreadWatchdogHandle);
      mainThreadWatchdogHandle = null;
    }
    mainThreadWatchdogCleanup = null;
  };

  return mainThreadWatchdogCleanup;
}
