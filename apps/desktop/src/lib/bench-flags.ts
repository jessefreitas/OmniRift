/** Nome da env que liga o modo bench. Fora dela, NADA neste módulo tem efeito. */
export const BENCH_MODE_ENV = "OMNIRIFT_BENCH_MODE";
/** Env com os overrides, formato: "flag-a=1,flag-b=0". */
export const BENCH_FLAGS_ENV = "OMNIRIFT_BENCH_FLAGS";

const TRUE_VALUES = new Set(["1", "true", "on"]);
const FALSE_VALUES = new Set(["0", "false", "off"]);

/**
 * Parseia a lista de overrides. Entradas inválidas são ignoradas: convertê-las em
 * `false` faria o bench medir o oposto do pedido e ainda poderia reportar verde.
 */
export function parseBenchFlags(raw: string | undefined | null): Record<string, boolean> {
  const overrides: Record<string, boolean> = {};
  if (!raw) return overrides;

  for (const pair of raw.split(",")) {
    const parts = pair.split("=");
    if (parts.length !== 2) continue;

    const key = parts[0].trim();
    const value = parts[1].trim().toLowerCase();
    if (!key) continue;

    if (TRUE_VALUES.has(value)) {
      overrides[key] = true;
    } else if (FALSE_VALUES.has(value)) {
      overrides[key] = false;
    }
  }

  return overrides;
}

/** true só quando o valor da env de modo for `1|true|on`. */
export function isBenchModeEnabled(rawMode: string | undefined | null): boolean {
  return TRUE_VALUES.has(rawMode?.trim().toLowerCase() ?? "");
}

/** Resolve bench > usuário > default, sem deixar bench desligado influir no valor. */
export function resolveFlagValue(args: {
  key: string;
  benchEnabled: boolean;
  benchOverrides: Record<string, boolean>;
  userOverrides: Record<string, boolean>;
  fallback: boolean;
}): boolean {
  if (args.benchEnabled && args.key in args.benchOverrides) {
    return args.benchOverrides[args.key];
  }
  if (args.key in args.userOverrides) return args.userOverrides[args.key];
  return args.fallback;
}

/** Descrição estável para tornar cada rodada do bench auditável no debug.log. */
export function describeBenchOverrides(
  benchEnabled: boolean,
  benchOverrides: Record<string, boolean>,
): string {
  if (!benchEnabled) return "";

  const entries = Object.entries(benchOverrides).sort(([left], [right]) =>
    left.localeCompare(right),
  );
  if (entries.length === 0) return "bench: sem overrides";

  return `bench: ${entries.map(([key, value]) => `${key}=${value ? "1" : "0"}`).join(",")}`;
}
