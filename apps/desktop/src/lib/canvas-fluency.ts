// src/lib/canvas-fluency.ts
//
// Gate de fluidez do canvas — lógica PURA + bus de alertas em memória.
// Reusa os limiares do watchdog de main thread / render-loop (`debug-log.ts`) e
// acrescenta churn de remount (F3 virtualização: nó entra/sai do viewport demais).
// Sem telemetria: só disco local (via debug-log) + chip na UI.

/** Limiares canônicos — gate + runtime compartilham a mesma fonte. */
export const FLUENCY = {
  TICK_MS: 500,
  BLOCK_WARN_MS: 250,
  BLOCK_SEVERE_MS: 1000,
  BLOCK_COOLDOWN_MS: 2000,
  RENDER_WINDOW_MS: 1000,
  RENDER_LIMIT: 60,
  RENDER_COOLDOWN_MS: 3000,
  /** Mesmo nó montando N vezes nesta janela = churn de virtualização/pan. */
  REMOUNT_WINDOW_MS: 2000,
  REMOUNT_LIMIT: 8,
  REMOUNT_COOLDOWN_MS: 3000,
  /** Alertas recentes mantidos pro chip / inspeção. */
  ALERT_RING_SIZE: 24,
  /** Chip some após este tempo sem novo alerta. */
  CHIP_TTL_MS: 30_000,
} as const;

export type FluencyKind = "MAIN-BLOCK" | "RENDER-LOOP" | "REMOUNT-CHURN";
export type FluencySeverity = "jank" | "severo" | "churn";

export type FluencyAlert = {
  kind: FluencyKind;
  severity: FluencySeverity;
  /** epoch ms (Date.now) — estável pra UI/TTL. */
  atMs: number;
  detail: string;
  context?: string;
};

/** Tags estruturadas no debug.log — o gate/scripts podem greppar. */
export const FLUENCY_LOG_TAGS = {
  MAIN_BLOCK: "⏱ MAIN-BLOCK",
  RENDER_LOOP: "🔁 RENDER-LOOP",
  REMOUNT_CHURN: "🔄 REMOUNT-CHURN",
} as const;

export function classifyMainThreadDrift(driftMs: number): FluencySeverity | null {
  if (driftMs >= FLUENCY.BLOCK_SEVERE_MS) return "severo";
  if (driftMs >= FLUENCY.BLOCK_WARN_MS) return "jank";
  return null;
}

/** Cooldown inclusivo: `now - lastAt >= cooldown` libera o próximo alerta. */
export function shouldEmitCooldown(now: number, lastAt: number, cooldownMs: number): boolean {
  return now - lastAt >= cooldownMs;
}

export function isRenderLoop(count: number, limit: number = FLUENCY.RENDER_LIMIT): boolean {
  return count > limit;
}

export function isRemountChurn(count: number, limit: number = FLUENCY.REMOUNT_LIMIT): boolean {
  return count > limit;
}

/**
 * Avalia um tick do watchdog de timer-drift (WebKitGTK sem longtask).
 * `expected` = instante em que o tick deveria ter acordado; `now` = performance.now().
 */
export function evaluateMainThreadTick(args: {
  now: number;
  expected: number;
  lastLogAt: number;
  cooldownMs?: number;
}): { drift: number; severity: FluencySeverity | null; shouldAlert: boolean } {
  const drift = args.now - args.expected;
  const severity = classifyMainThreadDrift(drift);
  const cooldown = args.cooldownMs ?? FLUENCY.BLOCK_COOLDOWN_MS;
  const shouldAlert =
    severity !== null && shouldEmitCooldown(args.now, args.lastLogAt, cooldown);
  return { drift, severity, shouldAlert };
}

export function evaluateRenderWindow(args: {
  count: number;
  now: number;
  alertedAt: number;
  limit?: number;
  cooldownMs?: number;
}): { shouldAlert: boolean } {
  const limit = args.limit ?? FLUENCY.RENDER_LIMIT;
  const cooldown = args.cooldownMs ?? FLUENCY.RENDER_COOLDOWN_MS;
  return {
    shouldAlert:
      isRenderLoop(args.count, limit) &&
      shouldEmitCooldown(args.now, args.alertedAt, cooldown),
  };
}

export function evaluateRemountWindow(args: {
  count: number;
  now: number;
  alertedAt: number;
  limit?: number;
  cooldownMs?: number;
}): { shouldAlert: boolean } {
  const limit = args.limit ?? FLUENCY.REMOUNT_LIMIT;
  const cooldown = args.cooldownMs ?? FLUENCY.REMOUNT_COOLDOWN_MS;
  return {
    shouldAlert:
      isRemountChurn(args.count, limit) &&
      shouldEmitCooldown(args.now, args.alertedAt, cooldown),
  };
}

export function formatFluencyLogLine(alert: FluencyAlert, iso?: string): string {
  const stamp = iso ?? new Date(alert.atMs).toISOString();
  const ctx = alert.context ? ` ${alert.context}` : "";
  switch (alert.kind) {
    case "MAIN-BLOCK":
      return `[${stamp}] [${FLUENCY_LOG_TAGS.MAIN_BLOCK}] ${alert.detail} (${alert.severity})${ctx}`;
    case "RENDER-LOOP":
      return `[${stamp}] [${FLUENCY_LOG_TAGS.RENDER_LOOP}] ${alert.detail}${ctx}`;
    case "REMOUNT-CHURN":
      return `[${stamp}] [${FLUENCY_LOG_TAGS.REMOUNT_CHURN}] ${alert.detail}${ctx}`;
  }
}

/** Parseia tags de fluidez numa linha de debug.log (gate / smoke). */
export function parseFluencyLogTag(line: string): FluencyKind | null {
  if (line.includes(`[${FLUENCY_LOG_TAGS.MAIN_BLOCK}]`)) return "MAIN-BLOCK";
  if (line.includes(`[${FLUENCY_LOG_TAGS.RENDER_LOOP}]`)) return "RENDER-LOOP";
  if (line.includes(`[${FLUENCY_LOG_TAGS.REMOUNT_CHURN}]`)) return "REMOUNT-CHURN";
  return null;
}

// ── Bus em memória (chip + inspeção; sem telemetria) ─────────────────────────

const alertRing: FluencyAlert[] = [];
const listeners = new Set<(alert: FluencyAlert) => void>();

export function pushFluencyAlert(alert: FluencyAlert): void {
  alertRing.push(alert);
  while (alertRing.length > FLUENCY.ALERT_RING_SIZE) alertRing.shift();
  for (const cb of listeners) {
    try {
      cb(alert);
    } catch {
      /* listener nunca derruba o detector */
    }
  }
}

export function getRecentFluencyAlerts(nowMs: number = Date.now()): FluencyAlert[] {
  const cutoff = nowMs - FLUENCY.CHIP_TTL_MS;
  return alertRing.filter((a) => a.atMs >= cutoff);
}

export function subscribeFluencyAlerts(cb: (alert: FluencyAlert) => void): () => void {
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

/** Só testes — zera ring + listeners. */
export function resetFluencyStateForTests(): void {
  alertRing.length = 0;
  listeners.clear();
}
