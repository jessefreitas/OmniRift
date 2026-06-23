// src/lib/review-policy.ts
//
// Política de review configurável pelo usuário (por projeto + default global):
// métricas (categorias/pesos/blocking), gates (thresholds), coverage, contratos,
// limites de PR. Persistida em localStorage.

export interface ReviewCategory {
  key: string;
  label: string;
  /** Peso na pontuação agregada. */
  weight: number;
  /** Se um CRITICAL nesta categoria sozinho já reprova. */
  blocking: boolean;
}

export interface ReviewPolicy {
  enabled: boolean;
  /** block = gateia o Land; warn = só confirma; off = não interfere. */
  gate: "block" | "warn" | "off";
  categories: ReviewCategory[];
  thresholds: { maxCritical: number; maxWarning: number };
  /** Profundidade alvo do review (0-100), entra no prompt. */
  coverage: number;
  /** Regras/contratos extras em texto livre (entram no prompt). */
  contracts: string;
  /** Limites de tamanho de PR — pré-flight determinístico (antes do LLM). */
  prLimits: { maxFiles?: number; maxLines?: number; maxFileLines?: number };
}

/** Default = as 6 categorias + thresholds do code-review-ai global. */
export const DEFAULT_POLICY: ReviewPolicy = {
  enabled: true,
  gate: "warn",
  categories: [
    { key: "security", label: "Segurança", weight: 10, blocking: true },
    { key: "quality", label: "Qualidade", weight: 7, blocking: false },
    { key: "performance", label: "Performance", weight: 6, blocking: false },
    { key: "testing", label: "Testes", weight: 5, blocking: false },
    { key: "architecture", label: "Arquitetura", weight: 4, blocking: false },
    { key: "style", label: "Estilo", weight: 2, blocking: false },
  ],
  thresholds: { maxCritical: 0, maxWarning: 1 },
  coverage: 80,
  contracts: "",
  prLimits: { maxFiles: 40, maxLines: 800, maxFileLines: 500 },
};

const KEY = "omnirift-review-policy-v1";

function readAll(): Record<string, ReviewPolicy> {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "{}");
  } catch {
    return {};
  }
}

/** Política do escopo (projeto) ou o default global. Mescla com DEFAULT. */
export function loadPolicy(scope?: string): ReviewPolicy {
  const all = readAll();
  const stored = all[scope || "__global"] ?? all["__global"];
  return stored ? { ...DEFAULT_POLICY, ...stored } : DEFAULT_POLICY;
}

export function savePolicy(policy: ReviewPolicy, scope?: string): void {
  const all = readAll();
  all[scope || "__global"] = policy;
  localStorage.setItem(KEY, JSON.stringify(all));
}
