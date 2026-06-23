// src/lib/routines.ts
//
// Routines (Fase 6): ações automatizadas — rodar um comando shell — com trigger
// manual, por intervalo (a cada X min) ou por horário fixo diário (HH:MM).
// Frontend-only: roda num terminal no floor ativo (reusa addTerminal), agenda
// no useRoutines, persiste em localStorage.

import { useCanvasStore } from "@/store/canvas-store";

export interface Routine {
  id: string;
  name: string;
  /** Comando shell a rodar (sh -lc). */
  command: string;
  /** Intervalo em minutos (null = não usa intervalo). */
  intervalMin: number | null;
  /** Horário diário "HH:MM" local — roda 1x/dia enquanto o app estiver aberto (null = não). */
  atTime: string | null;
  enabled: boolean;
}

const KEY = "omnirift-routines-v1";
/** Evento disparado quando a lista muda — o scheduler re-arma os timers. */
export const ROUTINES_CHANGED = "omnirift-routines-changed";

/** Normaliza routines antigas (sem atTime) ao carregar. */
function normalize(r: Partial<Routine>): Routine {
  return {
    id: String(r.id ?? ""),
    name: r.name ?? "Routine",
    command: r.command ?? "",
    intervalMin: r.intervalMin ?? null,
    atTime: r.atTime ?? null,
    enabled: Boolean(r.enabled),
  };
}

export function loadRoutines(): Routine[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr.map(normalize) : [];
  } catch {
    return [];
  }
}

export function saveRoutines(rs: Routine[]): void {
  localStorage.setItem(KEY, JSON.stringify(rs));
  window.dispatchEvent(new Event(ROUTINES_CHANGED));
}

function detectShell(): string {
  if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
    return "powershell.exe";
  }
  return "bash";
}

/** Roda a routine: abre um terminal no floor ativo executando o comando. */
export function runRoutine(r: Routine): void {
  const sh = detectShell();
  useCanvasStore.getState().addTerminal({
    command: sh,
    args: ["-lc", `${r.command}; exec ${sh}`],
    role: "shell",
    label: `routine: ${r.name}`,
  });
}

// ── Modelos prontos ─────────────────────────────────────────────────────────
// Presets clicáveis: entram DESATIVADOS (enabled:false) pro usuário revisar o
// comando e o agendamento antes de ligar. `--if-present` evita erro quando o
// script npm não existe no projeto.

export interface RoutineTemplate {
  category: string;
  name: string;
  desc: string;
  command: string;
  intervalMin?: number | null;
  atTime?: string | null;
}

export const ROUTINE_TEMPLATES: RoutineTemplate[] = [
  // Git
  { category: "Git", name: "Auto-commit (WIP)", desc: "Salva tudo num commit a cada 30 min", command: 'git add -A && git commit -m "wip $(date +%H:%M)" || true', intervalMin: 30 },
  { category: "Git", name: "Commit no fim do dia", desc: "Checkpoint diário às 18:00", command: 'git add -A && git commit -m "checkpoint $(date +%F)" || true', atTime: "18:00" },
  { category: "Git", name: "Push do branch", desc: "Sobe o branch atual a cada 1h", command: "git push || true", intervalMin: 60 },
  { category: "Git", name: "Fetch + prune", desc: "Atualiza refs remotas a cada 15 min", command: "git fetch --all --prune", intervalMin: 15 },
  { category: "Git", name: "Pull rebase (autostash)", desc: "Puxa o remoto sem perder o WIP a cada 30 min", command: "git pull --rebase --autostash || true", intervalMin: 30 },
  { category: "Git", name: "Resumo do repositório", desc: "status + últimos commits a cada 10 min", command: "git status -s && echo '---' && git log --oneline -5", intervalMin: 10 },
  { category: "Git", name: "Limpar branches merged", desc: "Apaga branches já mergeadas (manual)", command: "git branch --merged | grep -vE '^[*]|main|master' | xargs -r git branch -d", intervalMin: null },
  // Qualidade / Review
  { category: "Qualidade", name: "Code review (script do projeto)", desc: "Roda 'npm run review' às 9h, se existir", command: "npm run review --if-present || echo 'sem script de review'", atTime: "09:00" },
  { category: "Qualidade", name: "Rodar testes", desc: "npm test (manual)", command: "npm run test --if-present", intervalMin: null },
  { category: "Qualidade", name: "Typecheck", desc: "npm run typecheck (manual)", command: "npm run typecheck --if-present", intervalMin: null },
  { category: "Qualidade", name: "Lint", desc: "npm run lint (manual)", command: "npm run lint --if-present", intervalMin: null },
  // Sistema
  { category: "Sistema", name: "Backup do projeto", desc: "Compacta a pasta num .tgz ao meio-dia", command: 'tar czf "../backup-$(basename "$PWD")-$(date +%F-%H%M).tgz" --exclude=node_modules --exclude=.git . && echo "backup ok"', atTime: "12:00" },
  { category: "Sistema", name: "Espaço em disco", desc: "du do projeto + df a cada 1h", command: "du -sh . 2>/dev/null; df -h .", intervalMin: 60 },
];

/** Categorias na ordem de inserção dos templates. */
export const ROUTINE_CATEGORIES: string[] = [...new Set(ROUTINE_TEMPLATES.map((t) => t.category))];

/** Resumo legível do agendamento (pra chips na UI). */
export function scheduleLabel(t: { intervalMin?: number | null; atTime?: string | null }): string {
  if (t.atTime) return `às ${t.atTime}`;
  if (t.intervalMin) return `a cada ${t.intervalMin} min`;
  return "manual";
}
