// src/lib/debug-log.ts
//
// Grava logs em DISCO na hora (~/.omnirift/debug.log via comando Rust) — sobrevive ao WebView
// travado (tela preta), diferente do ring buffer só-memória do diagnostics.ts. Mais um detector
// de LOOP DE RENDER: se um componente re-renderiza demais num piscar, grava QUAL foi ANTES de a
// UI congelar de vez. Loop de render é a causa nº1 de tela preta neste app (WebKitGTK).
//
// Gate de fluidez: limiares e classificação vivem em `canvas-fluency.ts` (testáveis sem GUI).

import { classifyTick, currentPhase, perfContextLine, perfSnapshot } from "@/lib/perf-probe";
import { invoke } from "@tauri-apps/api/core";
import {
  FLUENCY,
  evaluateMainThreadTick,
  evaluateRemountWindow,
  evaluateRenderWindow,
  formatFluencyLogLine,
  pushFluencyAlert,
  type FluencyAlert,
} from "@/lib/canvas-fluency";

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

function emitFluency(alert: FluencyAlert): void {
  pushFluencyAlert(alert);
  logToDisk(formatFluencyLogLine(alert));
}

// ── Detector de loop de render ──────────────────────────────────────────────
// Conta renders por chave numa janela de 1s. Acima do teto, grava UM alerta (com cooldown, pra
// não inundar o disco) apontando o componente culpado. O normal é <5 renders/s por nó.
const counters = new Map<string, { count: number; windowStart: number; alertedAt: number }>();

/** Chame no CORPO do componente (a cada render). Detecta e grava loops de render. */
export function trackRender(key: string): void {
  const now = performance.now();
  let c = counters.get(key);
  if (!c) {
    c = { count: 0, windowStart: now, alertedAt: -FLUENCY.RENDER_COOLDOWN_MS };
    counters.set(key, c);
  }
  if (now - c.windowStart > FLUENCY.RENDER_WINDOW_MS) {
    c.count = 0;
    c.windowStart = now;
  }
  c.count++;
  if (evaluateRenderWindow({ count: c.count, now, alertedAt: c.alertedAt }).shouldAlert) {
    c.alertedAt = now;
    emitFluency({
      kind: "RENDER-LOOP",
      severity: "churn",
      atMs: Date.now(),
      detail: `${key} — ${c.count} renders em <1s (provável causa de tela preta)`,
    });
  }
}

// ── Detector de churn de remount (F3 virtualização) ─────────────────────────
// Conta mounts por chave numa janela. Pan agressivo + onlyRenderVisibleElements pode
// remountar o mesmo nó dezenas de vezes — isso é mensurável (não só "feeling").
const remountCounters = new Map<
  string,
  { count: number; windowStart: number; alertedAt: number }
>();

/**
 * Chame no mount do nó (useEffect vazio). Só observa — NÃO altera virtualização F3.
 * Excesso no floor ativo → alerta estruturado + chip.
 */
export function trackNodeMount(key: string, context?: string): void {
  const now = performance.now();
  let c = remountCounters.get(key);
  if (!c) {
    c = { count: 0, windowStart: now, alertedAt: -FLUENCY.REMOUNT_COOLDOWN_MS };
    remountCounters.set(key, c);
  }
  if (now - c.windowStart > FLUENCY.REMOUNT_WINDOW_MS) {
    c.count = 0;
    c.windowStart = now;
  }
  c.count++;
  if (evaluateRemountWindow({ count: c.count, now, alertedAt: c.alertedAt }).shouldAlert) {
    c.alertedAt = now;
    emitFluency({
      kind: "REMOUNT-CHURN",
      severity: "churn",
      atMs: Date.now(),
      detail: `${key} — ${c.count} mounts em <${FLUENCY.REMOUNT_WINDOW_MS}ms`,
      context,
    });
  }
}

// ── Watchdog de main thread bloqueada ───────────────────────────────────────
// WebKitGTK (Linux) não implementa PerformanceObserver com entryType "longtask",
// então usamos deriva de timer: se o setInterval acordou atrasado, a main thread
// esteve bloqueada durante o tick. Detecta QUE travou e por quanto, mas não QUEM travou.

let mainThreadWatchdogHandle: number | null = null;
let mainThreadWatchdogCleanup: (() => void) | null = null;
// -BLOCK_COOLDOWN_MS (e não 0): performance.now() começa perto de zero, então com 0 o
// cooldown engoliria os bloqueios dos 2 primeiros segundos — justo o boot. Mesmo
// padrão do `alertedAt` no detector de render acima.
let lastMainBlockLog = -FLUENCY.BLOCK_COOLDOWN_MS;

/** Liga o watchdog. `getContext` (opcional) devolve contexto curto pra linha do log. */
export function startMainThreadWatchdog(getContext?: () => string): () => void {
  if (mainThreadWatchdogCleanup !== null) {
    return mainThreadWatchdogCleanup;
  }

  let expected = performance.now() + FLUENCY.TICK_MS;

  mainThreadWatchdogHandle = window.setInterval(() => {
    const now = performance.now();
    const { drift, severity, shouldAlert } = evaluateMainThreadTick({
      now,
      expected,
      lastLogAt: lastMainBlockLog,
    });

    // Descarta o que não é congelamento REAL antes de gastar uma linha de log:
    // janela oculta (timer throttlado) e fase de boot (bloqueia por natureza).
    const verdict = classifyTick({
      driftMs: drift,
      hidden: typeof document !== "undefined" && document.hidden,
      phase: currentPhase(),
      warnMs: FLUENCY.BLOCK_WARN_MS,
    });

    if (verdict.kind !== "block") {
      expected = now + FLUENCY.TICK_MS;
      return;
    }

    if (shouldAlert && severity) {
      lastMainBlockLog = now;

      let context: string;
      try {
        context = getContext?.() ?? "";
      } catch {
        context = ""; // getContext nunca derruba o watchdog
      }

      const roundedDrift = Math.round(drift);
      // A linha de causa (fase, eventos/s, bytes/s, listeners, views) entra junto: sem
      // ela o log dizia QUE travou e nunca com QUANTA carga.
      const causa = perfContextLine(perfSnapshot());
      emitFluency({
        kind: "MAIN-BLOCK",
        severity,
        atMs: Date.now(),
        detail: `main thread parada ~${roundedDrift}ms`,
        context: [context, causa].filter(Boolean).join(" | ") || undefined,
      });
    }

    expected = now + FLUENCY.TICK_MS;
  }, FLUENCY.TICK_MS);

  mainThreadWatchdogCleanup = () => {
    if (mainThreadWatchdogHandle !== null) {
      clearInterval(mainThreadWatchdogHandle);
      mainThreadWatchdogHandle = null;
    }
    mainThreadWatchdogCleanup = null;
  };

  return mainThreadWatchdogCleanup;
}

/** Só testes — zera contadores internos do runtime (não o bus; use canvas-fluency). */
export function resetDebugLogDetectorsForTests(): void {
  counters.clear();
  remountCounters.clear();
  lastMainBlockLog = -FLUENCY.BLOCK_COOLDOWN_MS;
  if (mainThreadWatchdogCleanup) {
    mainThreadWatchdogCleanup();
  }
}
