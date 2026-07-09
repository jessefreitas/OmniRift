// lib/orchestration/parser.ts
//
// Parser determinístico do Modo Conductor. Resolve @mentions, pipes (|), e
// paralelo (||). ZERO LLM — só regex/estrutura. O Conductor LLM só entra quando
// o input é ambíguo ou não tem @ (precisa de interpretação).
//
// Gramática:
//   input     := stage ("||" stage)*
//   stage     := mention+ payload ("|" stage)?
//   mention   := "@" (name | "role:" role | "all" | "idle" | "worktree:" floor | "team:" group)
//   payload   := texto livre até próximo "|" ou "||" ou fim
//
// Exemplos:
//   "@backend fix X"                    → 1 stage, 1 mention, payload "fix X"
//   "@backend @frontend alinhem API"    → 1 stage, 2 mentions, mesmo payload
//   "@a X | @b Y"                       → 1 stage com pipe (b recebe output de a + Y)
//   "@a X || @b Y"                      → 2 stages independentes (paralelo)
//   "cria módulo email"                 → 1 stage, 0 mentions → vai pro Conductor LLM

export type MentionKind = "name" | "role" | "all" | "idle" | "worktree" | "team";

export interface Mention {
  kind: MentionKind;
  value: string;
  raw: string;
}

export interface Stage {
  mentions: Mention[];
  payload: string;
  pipeFromPrevious: boolean;
}

export interface ParsedCommand {
  stages: Stage[];
  hasMentions: boolean;
  needsConductor: boolean;
}

const MENTION_RE = /@(\w[\w:-]*\w|\w)/g;

function parseMentions(text: string): { mentions: Mention[]; remaining: string } {
  const mentions: Mention[] = [];
  const matches = [...text.matchAll(MENTION_RE)];

  let lastIdx = 0;
  for (const m of matches) {
    const full = m[0];
    const inner = m[1];

    let kind: MentionKind = "name";
    let value = inner;

    if (inner === "all") {
      kind = "all";
      value = "";
    } else if (inner === "idle") {
      kind = "idle";
      value = "";
    } else if (inner.startsWith("role:")) {
      kind = "role";
      value = inner.slice(5);
    } else if (inner.startsWith("worktree:")) {
      kind = "worktree";
      value = inner.slice(9);
    } else if (inner.startsWith("team:")) {
      kind = "team";
      value = inner.slice(5);
    }

    mentions.push({ kind, value, raw: full });
    lastIdx = (m.index ?? 0) + full.length;
  }

  // O payload é o texto depois da última menção (strip leading spaces)
  const remaining = text.slice(lastIdx).trim();

  return { mentions, remaining };
}

export function parseConductorInput(raw: string): ParsedCommand {
  const input = raw.trim();
  if (!input) {
    return { stages: [], hasMentions: false, needsConductor: false };
  }

  // Split por "||" (paralelo — stages independentes)
  const parallelParts = input.split(/\s*\|\|\s*/);

  const stages: Stage[] = [];
  let hasMentions = false;

  for (let pi = 0; pi < parallelParts.length; pi++) {
    const part = parallelParts[pi].trim();
    if (!part) continue;

    // Split por "|" (pipe — output do anterior é input do próximo)
    const pipeParts = part.split(/\s*\|\s*/);

    for (let i = 0; i < pipeParts.length; i++) {
      const segment = pipeParts[i].trim();
      if (!segment) continue;

      const { mentions, remaining } = parseMentions(segment);
      if (mentions.length > 0) hasMentions = true;

      stages.push({
        mentions,
        payload: remaining || (mentions.length > 0 ? "" : segment),
        pipeFromPrevious: i > 0,
      });
    }
  }

  const needsConductor = !hasMentions || stages.some((s) => s.mentions.length > 1 && s.payload.length > 0);

  return {
    stages,
    hasMentions,
    needsConductor,
  };
}

/** Formata um ParsedCommand de volta pra string legível (pro display na stream). */
export function formatParsed(cmd: ParsedCommand): string {
  return cmd.stages
    .map((s) => {
      const targets = s.mentions.length > 0 ? s.mentions.map((m) => m.raw).join(" ") : "conductor";
      const arrow = s.pipeFromPrevious ? " ⤵ " : "";
      return `${arrow}${targets} ${s.payload}`.trim();
    })
    .join(" || ");
}
