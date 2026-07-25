// Helpers puros da convocação do Conselho — modo de start + resumo legível.

export type CouncilStartMode = "idle" | "brain" | "brain-branch";

export const COUNCIL_START_MODES: Array<{
  id: CouncilStartMode;
  label: string;
  hint: string;
}> = [
  {
    id: "idle",
    label: "Só cards",
    hint: "Materializa em espera — ninguém gasta recurso até você iniciar.",
  },
  {
    id: "brain",
    label: "Iniciar Cérebro",
    hint: "Sobe só o Cérebro; especialistas e Relator ficam em espera.",
  },
  {
    id: "brain-branch",
    label: "Cérebro + ramo",
    hint: "Sobe o Cérebro e os especialistas do ramo; Relator permanece em espera.",
  },
];

/** Quais keys do workflow devem receber start sob demanda. */
export function councilStartKeys(mode: CouncilStartMode, memberKeys: string[]): string[] {
  if (mode === "idle") return [];
  if (mode === "brain") return ["moderator"];
  return ["moderator", ...memberKeys];
}

export function councilConveneSummary(opts: {
  areaLabel: string;
  mode: CouncilStartMode;
  memberCount: number;
  totalAgents: number;
}): string {
  const waiting = Math.max(
    0,
    opts.totalAgents - (
      opts.mode === "idle" ? 0 : opts.mode === "brain" ? 1 : 1 + opts.memberCount
    ),
  );
  if (opts.mode === "idle") {
    return `${opts.areaLabel}: ${opts.totalAgents} cards em espera (Cérebro + especialistas + Relator). Sessões sob demanda.`;
  }
  if (opts.mode === "brain") {
    return `${opts.areaLabel}: inicia o Cérebro agora; ${waiting} card(s) ficam em espera.`;
  }
  return `${opts.areaLabel}: inicia Cérebro + ${opts.memberCount} especialista(s); Relator e demais ficam em espera (${waiting}).`;
}

/** Conta membros (exclui Cérebro e Relator) a partir das keys do workflow. */
export function countCouncilMembers(keys: string[]): number {
  return keys.filter((key) => key !== "moderator" && key !== "rapporteur").length;
}
