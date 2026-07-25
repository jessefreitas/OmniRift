// src/lib/first-value.ts
//
// M1 — first-value pós-spawn: bloco estruturado curto (5–8 linhas) injetado quando
// o agente fica ready. Absorve o padrão de ativação do AIOX sem o framework.
// Puro: sem I/O, sem emoji de teatro.

export type FirstValueKind = "orchestrator" | "worker" | "agent";

export type FirstValueCtx = {
  /** Nome visível do nó / papel. */
  label: string;
  /** Papel declarado (pode coincidir com label). */
  role?: string;
  kind?: FirstValueKind;
  floor?: string;
  /** Default: "pronto". */
  status?: string;
  missionId?: string;
  capability?: string;
  /** Override; senão defaultKeyCommands(kind). */
  keyCommands?: string[];
  /** Default depende do kind. */
  nextStep?: string;
};

const THEATER_RE = /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u;

/** Comandos chave por kind — o que o agente deve lembrar no boot. */
export function defaultKeyCommands(kind: FirstValueKind): string[] {
  switch (kind) {
    case "orchestrator":
      return [
        "capability_search",
        "mission_create",
        "mission_run",
        "mission_handoff_read",
        "orchestrator_dispatch",
        "orchestrator_status",
      ];
    case "worker":
      return [
        "memory_recall",
        "mission_handoff_read",
        "claim_acquire",
        "review_current",
        "memory_remember",
      ];
    default:
      return ["memory_recall", "orchestrator_status"];
  }
}

function defaultNextStep(kind: FirstValueKind, ctx: FirstValueCtx): string {
  if (ctx.nextStep?.trim()) return ctx.nextStep.trim();
  if (ctx.missionId?.trim()) {
    return kind === "orchestrator"
      ? `rodar mission_run / acompanhar ${ctx.missionId.trim()}`
      : `aguardar dispatch da missão ${ctx.missionId.trim()}`;
  }
  switch (kind) {
    case "orchestrator":
      return "aguardar brief do humano; capability_search antes de spawnar frota";
    case "worker":
      return "aguardar dispatch do Orquestrador";
    default:
      return "aguardar instrução";
  }
}

/**
 * Monta o greeting estruturado (5–8 linhas). Host injeta — o LLM não precisa
 * inventar persona-cosplay.
 */
export function buildFirstValueGreeting(ctx: FirstValueCtx): string {
  const kind: FirstValueKind = ctx.kind ?? "agent";
  const label = (ctx.label || "agente").trim() || "agente";
  const role = (ctx.role ?? label).trim();
  const status = (ctx.status ?? "pronto").trim() || "pronto";
  const cmds = (ctx.keyCommands?.length ? ctx.keyCommands : defaultKeyCommands(kind))
    .map((c) => c.trim())
    .filter(Boolean);
  const lines: string[] = [];

  lines.push(`OmniRift · ${label}`);
  if (role && role !== label) lines.push(`Papel: ${role}`);
  const statusBits = [status];
  if (ctx.floor?.trim()) statusBits.push(`floor ${ctx.floor.trim()}`);
  lines.push(`Status: ${statusBits.join(" · ")}`);
  if (cmds.length) lines.push(`Comandos: ${cmds.join(" · ")}`);
  if (ctx.missionId?.trim() || ctx.capability?.trim()) {
    const parts: string[] = [];
    if (ctx.missionId?.trim()) parts.push(`missão ${ctx.missionId.trim()}`);
    if (ctx.capability?.trim()) parts.push(`capability ${ctx.capability.trim()}`);
    lines.push(`Contexto: ${parts.join(" · ")}`);
  }
  lines.push(`Próximo: ${defaultNextStep(kind, ctx)}`);
  lines.push("Aguarde input. Não invente tarefa.");

  // Clamp 5–8 linhas (preenche/corta sem teatro).
  while (lines.length < 5) lines.push("Aguarde input.");
  const out = lines.slice(0, 8).join("\n");
  if (THEATER_RE.test(out)) {
    // Defesa: builder não deve emitir pictogramas.
    return out.replace(THEATER_RE, "").replace(/[ \t]+\n/g, "\n");
  }
  return out;
}

/** Prepende o greeting a um body (persona / firstMessage). Body vazio → só greeting. */
export function withFirstValueGreeting(
  body: string | undefined,
  ctx: FirstValueCtx,
): string {
  const g = buildFirstValueGreeting(ctx);
  const b = (body ?? "").trim();
  if (!b) return g;
  return `${g}\n\n${b}`;
}

/** Conta linhas não-vazias — útil nos testes e asserts de UI. */
export function firstValueLineCount(text: string): number {
  return text.split("\n").filter((l) => l.trim().length > 0).length;
}
