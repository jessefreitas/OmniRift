// src/lib/routines.ts
//
// Routines (Fase 6): ações automatizadas — rodar um comando shell — com trigger
// manual, por intervalo (a cada X min) ou por horário fixo diário (HH:MM).
// Frontend-only: roda num terminal no floor ativo (reusa addTerminal), agenda
// no useRoutines, persiste em localStorage.

import { invoke } from "@tauri-apps/api/core";

import { useCanvasStore } from "@/store/canvas-store";

/** Tipo de disparo de uma routine (Fase 2). `interval`/`atTime` = MVP;
 *  `floor-created`/`floor-deleted` = ciclo-de-vida de floor (worktree git). */
export type RoutineTrigger = "interval" | "atTime" | "floor-created" | "floor-deleted";

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
  /** Floor onde a routine roda (null/undefined = floor ativo). Backend: target_floor. */
  targetFloor?: string | null;
  /** Tipo de disparo (Fase 2). undefined/null = retrocompat: deriva por intervalMin/atTime
   *  (ver effectiveTrigger). Backend: coluna `trigger`. */
  trigger?: RoutineTrigger | null;
  /** Epoch (segundos) — preenchido pelo backend (ignorado na entrada). */
  createdAt?: number;
  updatedAt?: number;
}

/** Disparo efetivo de uma routine: usa `trigger` explícito; senão DERIVA (retrocompat)
 *  — atTime → "atTime", caso contrário "interval". Nunca deriva floor-* (precisa ser explícito). */
export function effectiveTrigger(
  r: Pick<Routine, "trigger" | "atTime" | "intervalMin">,
): RoutineTrigger {
  if (r.trigger) return r.trigger;
  if (r.atTime) return "atTime";
  return "interval";
}

/** True só quando o trigger EXPLÍCITO é de ciclo-de-vida de floor. Routines legadas
 *  (sem trigger) retornam false → seguem agendando por intervalo/horário (zero regressão). */
export function isFloorTrigger(r: Pick<Routine, "trigger">): boolean {
  return r.trigger === "floor-created" || r.trigger === "floor-deleted";
}

/** Uma linha do histórico de execução (espelha RunRow do backend). */
export interface RunRow {
  id: string;
  routineId: string;
  /** Epoch (segundos) do disparo. */
  startedAt: number;
  exitCode?: number | null;
  status: string;
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
    targetFloor: r.targetFloor ?? null,
    trigger: r.trigger ?? null,
    createdAt: r.createdAt ?? undefined,
    updatedAt: r.updatedAt ?? undefined,
  };
}

// ── Persistência: SQLite via Tauri (com cache em memória) ────────────────────
// O backend (commands/routines.rs) é a fonte de verdade. Mantemos um cache
// SÍNCRONO pro scheduler (useRoutines) e pro init do modal lerem sem await.
// Sem Tauri (browser/dev/test) cai pro localStorage — comportamento original.

let _cache: Routine[] = [];
let _migrationDone = false;

function hasTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function readLegacyLocalStorage(): Routine[] {
  try {
    const arr = JSON.parse(localStorage.getItem(KEY) || "[]");
    return Array.isArray(arr) ? arr.map(normalize) : [];
  } catch {
    return [];
  }
}

function sameRoutine(a: Routine, b: Routine): boolean {
  return (
    a.name === b.name &&
    a.command === b.command &&
    a.intervalMin === b.intervalMin &&
    a.atTime === b.atTime &&
    a.enabled === b.enabled &&
    (a.targetFloor ?? null) === (b.targetFloor ?? null) &&
    (a.trigger ?? null) === (b.trigger ?? null)
  );
}

/** Lê a lista de forma SÍNCRONA (cache em memória). Sem Tauri, lê o localStorage
 *  direto (fonte original). O cache é populado por refreshRoutines(). */
export function loadRoutines(): Routine[] {
  if (!hasTauri()) {
    _cache = readLegacyLocalStorage();
    return _cache;
  }
  return _cache;
}

/** Carrega do backend pro cache (async) + migração one-shot do localStorage.
 *  Dispara ROUTINES_CHANGED pro scheduler re-armar. Chamar no boot (useRoutines)
 *  e ao abrir o modal. Sem Tauri, devolve o localStorage (sem migrar). */
export async function refreshRoutines(): Promise<Routine[]> {
  if (!hasTauri()) return loadRoutines();
  try {
    let rows = (await invoke<Routine[]>("routines_list")).map(normalize);
    // Migração one-shot: backend vazio + localStorage com routines legadas → importa 1x.
    if (rows.length === 0 && !_migrationDone) {
      _migrationDone = true;
      const legacy = readLegacyLocalStorage();
      if (legacy.length > 0) {
        let allOk = true;
        for (const r of legacy) {
          try {
            await invoke<Routine>("routines_upsert", { routine: r });
          } catch (e) {
            // [GLM-audit] NÃO engole: se uma routine legada falhar, NÃO apaga o localStorage
            // (senão perde o dado) — loga e marca p/ retentar a migração na próxima subida.
            allOk = false;
            console.error("[routines] migração falhou p/", r.id, e);
          }
        }
        if (allOk) {
          localStorage.removeItem(KEY); // só remove se TUDO migrou (1x)
        } else {
          _migrationDone = false; // mantém o localStorage + retenta no próximo boot
        }
        rows = (await invoke<Routine[]>("routines_list")).map(normalize);
      }
    }
    _cache = rows;
    window.dispatchEvent(new Event(ROUTINES_CHANGED));
    return _cache;
  } catch {
    // Backend indisponível → mantém o cache atual (não derruba o scheduler).
    return _cache;
  }
}

/** Persiste a lista. Atualiza o cache (síncrono) e propaga pro backend por diff:
 *  upsert dos novos/alterados + delete dos removidos. Sem Tauri, localStorage.
 *  Fire-and-forget (não bloqueia a UI); ROUTINES_CHANGED re-arma o scheduler. */
export function saveRoutines(next: Routine[]): void {
  const prev = _cache;
  _cache = next.map(normalize);
  window.dispatchEvent(new Event(ROUTINES_CHANGED));
  if (!hasTauri()) {
    localStorage.setItem(KEY, JSON.stringify(_cache));
    return;
  }
  const nextIds = new Set(_cache.map((r) => r.id));
  const prevById = new Map(prev.map((r) => [r.id, r]));
  for (const r of prev) {
    // [GLM-audit] loga em vez de engolir — falha de persistência some no refresh; ao menos fica no log.
    if (!nextIds.has(r.id))
      void invoke("routines_delete", { id: r.id }).catch((e) => console.error("[routines] delete falhou", r.id, e));
  }
  for (const r of _cache) {
    const before = prevById.get(r.id);
    if (!before || !sameRoutine(before, r)) {
      void invoke<Routine>("routines_upsert", { routine: r }).catch((e) => console.error("[routines] upsert falhou", r.id, e));
    }
  }
}

function detectShell(): string {
  if (typeof navigator !== "undefined" && /Windows/i.test(navigator.userAgent)) {
    return "powershell.exe";
  }
  return "bash";
}

/** Roda a routine: abre um terminal no floor alvo (targetFloor) ou no ativo,
 *  executando o comando, e registra o disparo no histórico (status "started"). */
export function runRoutine(r: Routine): void {
  const sh = detectShell();
  useCanvasStore.getState().addTerminal({
    command: sh,
    args: ["-lc", `${r.command}; exec ${sh}`],
    role: "shell",
    label: `routine: ${r.name}`,
    targetFloorId: r.targetFloor ?? undefined, // undefined = floor ativo (default)
  });
  // Histórico (MVP): o exit do terminal não é capturável fácil daqui, então
  // "started" basta. Fire-and-forget — não bloqueia o run nem quebra sem Tauri.
  if (hasTauri() && r.id) {
    void invoke<RunRow>("routines_record_run", {
      routineId: r.id,
      exitCode: null,
      status: "started",
    }).catch(() => {});
  }
}

/** Histórico de uma routine (mais recentes primeiro; default 50). [] sem Tauri/erro. */
export async function routineRuns(routineId: string, limit = 50): Promise<RunRow[]> {
  if (!hasTauri() || !routineId) return [];
  try {
    return await invoke<RunRow[]>("routines_runs", { routineId, limit });
  } catch {
    return [];
  }
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
  // Specs — auditoria de specs/planos vs código (anti-regressão). A auditoria IA usa o
  // comando /audit do projeto (Claude Code); o status é só shell (sem IA).
  { category: "Specs", name: "Auditar specs vs código (IA)", desc: "Re-audita specs+planos contra o código e reescreve docs/STATUS.md (usa o comando /audit)", command: 'claude -p "/audit" --dangerously-skip-permissions || echo "precisa do claude-code + comando /audit neste projeto"' },
  { category: "Specs", name: "Status das specs", desc: "Lista specs ATIVAS vs ARQUIVADAS (sem IA)", command: 'echo "── ATIVAS ──"; ls docs/superpowers/specs/*.md 2>/dev/null | xargs -n1 basename 2>/dev/null; echo; echo "ARQUIVADAS: $(ls docs/superpowers/specs/archive/*.md 2>/dev/null | wc -l)"' },
];

/** Categorias na ordem de inserção dos templates. */
export const ROUTINE_CATEGORIES: string[] = [...new Set(ROUTINE_TEMPLATES.map((t) => t.category))];

/** Resumo legível do agendamento (pra chips na UI). */
export function scheduleLabel(t: {
  intervalMin?: number | null;
  atTime?: string | null;
  trigger?: RoutineTrigger | null;
}): string {
  if (t.trigger === "floor-created") return "ao criar floor";
  if (t.trigger === "floor-deleted") return "ao deletar floor";
  if (t.atTime) return `às ${t.atTime}`;
  if (t.intervalMin) return `a cada ${t.intervalMin} min`;
  return "manual";
}
