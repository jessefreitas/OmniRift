// src/components/RoutinesModal.tsx
//
// CRUD das Routines + rodar manualmente. Ações automatizadas (comando shell)
// com trigger manual ou por intervalo. Persiste em localStorage.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { nanoid } from "nanoid";
import { CalendarClock, Clock, LayoutTemplate, Play, Plus, Repeat, Trash2, X } from "lucide-react";

import {
  loadRoutines,
  saveRoutines,
  refreshRoutines,
  routineRuns,
  runRoutine,
  effectiveTrigger,
  ROUTINE_TEMPLATES,
  ROUTINE_CATEGORIES,
  type Routine,
  type RoutineTemplate,
  type RoutineTrigger,
} from "@/lib/routines";
import { osSlug, schedulerInstall, schedulerUninstall, schedulerList } from "@/lib/scheduler-client";
import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";

/** "HH:MM" local a partir de epoch (segundos) — pro chip "última: HH:MM". */
function fmtHHMM(secs: number): string {
  const d = new Date(secs * 1000);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

interface Props {
  onClose: () => void;
  /** cwd do projeto ativo — usado ao agendar a routine no SO. */
  cwd?: string | null;
}

export function RoutinesModal({ onClose, cwd }: Props) {
  const t = useT();

  // Versão localizada do scheduleLabel da lib (que devolve PT fixo). Reconstrói
  // o mesmo formato usando as chaves i18n — não toca na lib (fonte PT/fallback).
  function localScheduleLabel(s: { intervalMin?: number | null; atTime?: string | null; trigger?: RoutineTrigger | null }): string {
    if (s.trigger === "floor-created") return t("routines.onFloorCreated", "ao criar floor");
    if (s.trigger === "floor-deleted") return t("routines.onFloorDeleted", "ao deletar floor");
    if (s.atTime) return `${t("routines.at", "às")} ${s.atTime}`;
    if (s.intervalMin) return `${t("routines.every", "a cada")} ${s.intervalMin} ${t("routines.min", "min")}`;
    return t("routines.manual", "manual");
  }
  const [routines, setRoutines] = useState<Routine[]>(() => loadRoutines());
  const [showTemplates, setShowTemplates] = useState(false);
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [schedErr, setSchedErr] = useState<string | null>(null);
  /** routineId → epoch (segundos) do último disparo (chip "última: HH:MM"). */
  const [lastRuns, setLastRuns] = useState<Record<string, number>>({});

  // Floors do projeto ativo (alvo "Rodar em"). Seleciona arrays crus e deriva com
  // useMemo (selector com .filter retornaria ref nova a cada render → loop no zustand).
  const floors = useCanvasStore((s) => s.parallels);
  const activeProjectId = useCanvasStore((s) => s.activeProjectId);
  const projectFloors = useMemo(
    () => floors.filter((f) => f.projectId === activeProjectId),
    [floors, activeProjectId],
  );

  async function refreshLastRuns(list: Routine[]) {
    const entries = await Promise.all(
      list.map(async (r) => {
        const runs = await routineRuns(r.id, 1);
        return [r.id, runs[0]?.startedAt ?? 0] as const;
      }),
    );
    setLastRuns((prev) => {
      const nextMap = { ...prev };
      for (const [rid, ts] of entries) if (ts > 0) nextMap[rid] = ts;
      return nextMap;
    });
  }

  // Carrega do backend (SQLite) ao abrir + migração one-shot do localStorage.
  useEffect(() => {
    let alive = true;
    void refreshRoutines().then((rs) => {
      if (!alive) return;
      setRoutines(rs);
      void refreshLastRuns(rs);
    });
    return () => {
      alive = false;
    };
  }, []);

  function persist(next: Routine[]) {
    setRoutines(next);
    saveRoutines(next);
  }

  /** Roda e atualiza o chip de histórico (otimista + reconcilia com o backend). */
  function run(r: Routine) {
    runRoutine(r);
    setLastRuns((prev) => ({ ...prev, [r.id]: Math.floor(Date.now() / 1000) }));
    setTimeout(() => void refreshLastRuns([r]), 300);
  }

  function add() {
    persist([
      ...routines,
      { id: nanoid(), name: t("routines.newRoutineName", "Nova routine"), command: "", intervalMin: null, atTime: null, enabled: false, targetFloor: null },
    ]);
  }

  function addFromTemplate(t: RoutineTemplate) {
    persist([
      ...routines,
      {
        id: nanoid(),
        name: t.name,
        command: t.command,
        intervalMin: t.intervalMin ?? null,
        atTime: t.atTime ?? null,
        targetFloor: null, // floor ativo por padrão
        enabled: false, // entra desativada: revise o comando e ligue o "ativa"
      },
    ]);
    setShowTemplates(false);
  }

  function patch(id: string, p: Partial<Routine>) {
    persist(routines.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }

  function del(id: string) {
    persist(routines.filter((r) => r.id !== id));
  }

  async function reloadInstalled() {
    try { setInstalled(new Set(await schedulerList())); } catch { /* ignore */ }
  }
  useEffect(() => { void reloadInstalled(); }, []);

  async function toggleOsSchedule(r: Routine) {
    setSchedErr(null);
    const slug = osSlug(r.name);
    try {
      if (installed.has(slug)) {
        await schedulerUninstall(r.name);
      } else {
        if (!cwd) { setSchedErr(t("routines.errNoProject", "Abra um projeto (pasta) antes de agendar no SO.")); return; }
        if (!r.atTime && !r.intervalMin) { setSchedErr(t("routines.errNoSchedule", "Defina horário (às HH:MM) ou intervalo antes de agendar no SO.")); return; }
        if (!r.command.trim()) { setSchedErr(t("routines.errNoCommand", "A routine precisa de um comando.")); return; }
        await schedulerInstall(r.name, r.command, cwd, r.atTime, r.intervalMin);
      }
      await reloadInstalled();
    } catch (e) {
      setSchedErr(String(e));
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[680px] max-w-[94vw] h-[560px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Repeat size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">Routines</span>
          <button
            onClick={() => setShowTemplates((s) => !s)}
            className={`flex items-center gap-1 px-2.5 py-1 rounded text-[12px] border transition-colors ${showTemplates ? "border-brand text-brand bg-brand/10" : "border-border text-textMuted hover:text-text"}`}
          >
            <LayoutTemplate size={13} /> {t("routines.templates", "Modelos")}
          </button>
          <button
            onClick={add}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors"
          >
            <Plus size={13} /> {t("routines.new", "Nova")}
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {schedErr && (
          <p className="px-4 py-1.5 text-[11px] text-danger border-b border-border break-words shrink-0">{schedErr}</p>
        )}

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {showTemplates && (
            <div className="rounded-md border border-brand/40 bg-brand/5 p-2.5 space-y-2.5">
              <div className="flex items-center justify-between">
                <span className="text-[12px] font-medium text-text">{t("routines.readyTemplates", "Modelos prontos")}</span>
                <span className="text-[10px] text-textMuted opacity-60">{t("routines.clickToAdd", "clique pra adicionar — entra desativada")}</span>
              </div>
              {ROUTINE_CATEGORIES.map((cat) => (
                <div key={cat} className="space-y-1">
                  <div className="text-[9px] uppercase tracking-wider text-textMuted opacity-60">{t("routineCat." + cat, cat)}</div>
                  <div className="grid grid-cols-2 gap-1.5">
                    {ROUTINE_TEMPLATES.filter((tpl) => tpl.category === cat).map((tpl) => (
                      <button
                        key={tpl.name}
                        onClick={() => addFromTemplate(tpl)}
                        title={tpl.command}
                        className="text-left rounded border border-border bg-bg/60 hover:border-brand hover:bg-surface2 px-2 py-1.5 transition-colors"
                      >
                        <div className="text-[11px] text-text font-medium truncate">{t("routineTpl." + tpl.name, tpl.name)}</div>
                        <div className="text-[10px] text-textMuted opacity-70 truncate">{t("routineTplDesc." + tpl.name, tpl.desc)}</div>
                        <div className="text-[9px] text-brand mt-0.5">{localScheduleLabel(tpl)}</div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
          {routines.length === 0 && !showTemplates ? (
            <p className="px-1 py-3 text-[12px] text-textMuted opacity-60">
              {t("routines.empty", "Sem routines. Crie uma ação (comando shell) com trigger manual ou por intervalo.")}
            </p>
          ) : (
            routines.map((r) => (
              <div key={r.id} className="rounded-md border border-border bg-bg/40 p-2.5 space-y-2">
                <div className="flex items-center gap-2">
                  <input
                    value={r.name}
                    onChange={(e) => patch(r.id, { name: e.target.value })}
                    className="flex-1 px-2 py-1 rounded text-[12px] bg-bg border border-border text-text focus:outline-none focus:border-brand"
                  />
                  <button
                    onClick={() => run(r)}
                    disabled={!r.command.trim()}
                    title={t("routines.runNow", "Rodar agora")}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40"
                  >
                    <Play size={11} /> {t("routines.run", "Rodar")}
                  </button>
                  <button
                    onClick={() => void toggleOsSchedule(r)}
                    title={installed.has(osSlug(r.name)) ? t("routines.scheduledOs", "Agendado no SO (clique p/ remover)") : t("routines.scheduleOs", "Agendar no SO — roda com o app fechado")}
                    className={`flex items-center gap-1 px-2 py-1 rounded text-[11px] border transition-colors ${installed.has(osSlug(r.name)) ? "border-brand text-brand bg-brand/10" : "bg-surface2 text-text hover:text-brand border-border"}`}
                  >
                    <CalendarClock size={11} /> {installed.has(osSlug(r.name)) ? t("routines.onOs", "no SO ✓") : t("routines.os", "SO")}
                  </button>
                  <button onClick={() => del(r.id)} title={t("common.delete", "Apagar")} className="text-textMuted hover:text-danger p-1">
                    <Trash2 size={13} />
                  </button>
                </div>
                <input
                  value={r.command}
                  onChange={(e) => patch(r.id, { command: e.target.value })}
                  placeholder={t("routines.commandPh", "comando shell (ex: git fetch --all)")}
                  className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
                />
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-[11px] text-textMuted">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                    />
                    {t("routines.enabled", "ativa")}
                  </label>
                  <label className="flex items-center gap-1.5">
                    {t("routines.trigger", "disparo")}
                    <select
                      value={effectiveTrigger(r)}
                      onChange={(e) => patch(r.id, { trigger: e.target.value as RoutineTrigger })}
                      className="px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand"
                    >
                      <option value="interval">{t("routines.trigInterval", "Intervalo")}</option>
                      <option value="atTime">{t("routines.trigAtTime", "Diário HH:MM")}</option>
                      <option value="floor-created">{t("routines.trigFloorCreated", "Ao criar floor")}</option>
                      <option value="floor-deleted">{t("routines.trigFloorDeleted", "Ao deletar floor")}</option>
                    </select>
                  </label>
                  {effectiveTrigger(r) === "interval" && (
                    <label className="flex items-center gap-1.5">
                      {t("routines.every", "a cada")}
                      <input
                        type="number"
                        min={0}
                        value={r.intervalMin ?? ""}
                        onChange={(e) => patch(r.id, { intervalMin: e.target.value ? Number(e.target.value) : null })}
                        placeholder="—"
                        className="w-14 px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand"
                      />
                      {t("routines.min", "min")}
                    </label>
                  )}
                  {effectiveTrigger(r) === "atTime" && (
                    <label className="flex items-center gap-1.5">
                      <Clock size={11} className="opacity-70" /> {t("routines.at", "às")}
                      <input
                        type="time"
                        value={r.atTime ?? ""}
                        onChange={(e) => patch(r.id, { atTime: e.target.value || null })}
                        className="px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand"
                      />
                    </label>
                  )}
                  <label className="flex items-center gap-1.5">
                    {t("routines.runIn", "rodar em")}
                    <select
                      value={r.targetFloor ?? ""}
                      onChange={(e) => patch(r.id, { targetFloor: e.target.value || null })}
                      className="px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand"
                    >
                      <option value="">{t("routines.activeFloor", "floor ativo")}</option>
                      {projectFloors.map((f) => (
                        <option key={f.id} value={f.id}>{f.name}</option>
                      ))}
                    </select>
                  </label>
                  {lastRuns[r.id] ? (
                    <span className="text-[10px] text-textMuted opacity-70">
                      {t("routines.last", "última")}: {fmtHHMM(lastRuns[r.id])}
                    </span>
                  ) : null}
                  <span className="ml-auto text-[10px] text-brand opacity-80">{localScheduleLabel(r)}</span>
                </div>
              </div>
            ))
          )}
        </div>
        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("routines.footer1", "Routines ativas rodam em background enquanto o app está aberto.")} <b>{t("routines.footerScheduleOs", "Agendar no SO")}</b> {t("routines.footer2", "(🗓) cria um timer do sistema (systemd/Task Scheduler) que roda o comando mesmo com o app fechado.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
