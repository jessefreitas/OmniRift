// src/lib/code-thresholds.ts
//
// Thresholds de complexidade configuráveis (sub-fase 9e). O backend (9c) calcula
// as métricas cruas; AQUI mora a política de cor/severidade — para que o badge
// "cx N" e o painel de complexidade derivem o nível (ok/warn/high) de uma config
// editável e persistida, em vez de números hardcoded espalhados pela UI.
//
// MVP: thresholds GLOBAIS. A forma do storage já comporta override por linguagem
// (campo opcional `byLanguage`) sem migração futura.
//
// Limites canônicos (spec §5): Cyclomatic ≤ 10 (warn>10, high>20);
// Cognitive ≤ 15 (warn>15, high>30).

const STORAGE_KEY = "omnirift-code-thresholds";

/** Métricas com threshold de severidade configurável. */
export type ThresholdMetric = "cyclomatic" | "cognitive";

/** Nível de severidade derivado dos limites. */
export type ThresholdLevel = "ok" | "warn" | "high";

/** Par warn/high de uma métrica. `value > warn` → warn; `value > high` → high. */
export interface MetricThreshold {
  warn: number;
  high: number;
}

/** Configuração completa dos limites, com override opcional por linguagem. */
export interface CodeThresholds {
  cyclomatic: MetricThreshold;
  cognitive: MetricThreshold;
  /**
   * Override por linguagem (id Monaco: "rust"/"typescript"/…). Não usado pela UI
   * do MVP, mas respeitado por `levelFor`/`thresholdFor` quando presente. Mantém
   * a porta aberta sem quebrar o storage.
   */
  byLanguage?: Record<string, Partial<Pick<CodeThresholds, "cyclomatic" | "cognitive">>>;
}

/** Defaults canônicos da spec (§5). */
export const DEFAULT_THRESHOLDS: CodeThresholds = {
  cyclomatic: { warn: 10, high: 20 },
  cognitive: { warn: 15, high: 30 },
};

/** True se `value` é um objeto plano (não null, não array). */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Garante warn/high numéricos não negativos e high >= warn (senão "high" seria inalcançável). */
function sanitizePair(raw: unknown, fallback: MetricThreshold): MetricThreshold {
  const c = isPlainObject(raw) ? raw : {};
  const warn = typeof c.warn === "number" && Number.isFinite(c.warn) ? Math.max(0, c.warn) : fallback.warn;
  const high = typeof c.high === "number" && Number.isFinite(c.high) ? Math.max(0, c.high) : fallback.high;
  return { warn, high: Math.max(high, warn) };
}

/** Sanea a config inteira aplicando defaults e validação por campo. */
function sanitizeThresholds(raw: unknown): CodeThresholds {
  const incoming = isPlainObject(raw) ? raw : {};
  const cyclomatic = sanitizePair(incoming.cyclomatic, DEFAULT_THRESHOLDS.cyclomatic);
  const cognitive = sanitizePair(incoming.cognitive, DEFAULT_THRESHOLDS.cognitive);

  const byLanguage: NonNullable<CodeThresholds["byLanguage"]> = {};
  if (isPlainObject(incoming.byLanguage)) {
    for (const [language, overrides] of Object.entries(incoming.byLanguage)) {
      if (!isPlainObject(overrides)) continue;
      const entry: Partial<Pick<CodeThresholds, "cyclomatic" | "cognitive">> = {};
      if ("cyclomatic" in overrides) entry.cyclomatic = sanitizePair(overrides.cyclomatic, cyclomatic);
      if ("cognitive" in overrides) entry.cognitive = sanitizePair(overrides.cognitive, cognitive);
      if (Object.keys(entry).length > 0) byLanguage[language] = entry;
    }
  }

  return {
    cyclomatic,
    cognitive,
    ...(Object.keys(byLanguage).length > 0 ? { byLanguage } : {}),
  };
}

/** Carrega os thresholds de localStorage, mesclados com os defaults. */
export function loadThresholds(): CodeThresholds {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (!stored) return sanitizeThresholds({}); // clone dos defaults (nunca a ref compartilhada)
    return sanitizeThresholds(JSON.parse(stored) as unknown);
  } catch {
    return sanitizeThresholds({});
  }
}

/** Persiste os thresholds (saneados). No-op silencioso se localStorage estiver off. */
export function saveThresholds(t: CodeThresholds): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeThresholds(t)));
  } catch {
    /* off → ignora */
  }
}

/** O par warn/high efetivo de `metric`, aplicando override de linguagem se houver. */
export function thresholdFor(
  thresholds: CodeThresholds,
  metric: ThresholdMetric,
  language?: string,
): MetricThreshold {
  const base = sanitizePair(thresholds[metric], DEFAULT_THRESHOLDS[metric]);
  const override = language ? thresholds.byLanguage?.[language]?.[metric] : undefined;
  if (!override) return base;
  return sanitizePair({ warn: override.warn ?? base.warn, high: override.high ?? base.high }, base);
}

/**
 * Nível de severidade de `value` para `metric`. `> high` → "high"; `> warn` →
 * "warn"; caso contrário "ok".
 */
export function levelFor(
  thresholds: CodeThresholds,
  metric: ThresholdMetric,
  value: number,
  language?: string,
): ThresholdLevel {
  const { warn, high } = thresholdFor(thresholds, metric, language);
  if (value > high) return "high";
  if (value > warn) return "warn";
  return "ok";
}

/** O pior (mais severo) nível entre dois — helper p/ badge/linha. */
export function worstLevel(a: ThresholdLevel, b: ThresholdLevel): ThresholdLevel {
  const rank: Record<ThresholdLevel, number> = { ok: 0, warn: 1, high: 2 };
  return rank[a] >= rank[b] ? a : b;
}
