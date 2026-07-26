/**
 * OrchestrationDoctorPanel — M4: “por que o agente não ativou?”
 * Modal leve com checklist ✅/❌ (só diagnóstico, sem healers).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, CircleX, Loader2, RefreshCw, Stethoscope, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  orchestrationDoctor,
  type DoctorCheck,
  type DoctorReport,
} from "@/lib/orchestration-doctor-client";

interface Props {
  onClose: () => void;
}

function CheckRow({ c }: { c: DoctorCheck }) {
  return (
    <li
      className={cn(
        "rounded-md border px-3 py-2 text-[12px]",
        c.ok ? "border-border bg-surface2/40" : "border-red-500/30 bg-red-500/5",
      )}
    >
      <div className="flex items-start gap-2">
        {c.ok ? (
          <CheckCircle2 className="mt-0.5 size-3.5 shrink-0 text-emerald-500" aria-hidden />
        ) : (
          <CircleX className="mt-0.5 size-3.5 shrink-0 text-red-500" aria-hidden />
        )}
        <div className="min-w-0 flex-1">
          <div className="font-medium text-text">{c.label}</div>
          <div className="mt-0.5 font-mono text-[11px] text-textMuted break-words">{c.detail}</div>
          {!c.ok && c.hint && (
            <div className="mt-1 text-[11px] text-amber-600 dark:text-amber-400">→ {c.hint}</div>
          )}
        </div>
      </div>
    </li>
  );
}

export function OrchestrationDoctorPanel({ onClose }: Props) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const [report, setReport] = useState<DoctorReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const runGen = useRef(0);

  const run = useCallback(async () => {
    const gen = ++runGen.current;
    setBusy(true);
    setError(null);
    try {
      const r = await orchestrationDoctor(currentCwd || null);
      if (gen !== runGen.current) return; // resposta stale (cwd mudou / re-run)
      setReport(r);
    } catch (e) {
      if (gen !== runGen.current) return;
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (gen === runGen.current) setBusy(false);
    }
  }, [currentCwd]);

  useEffect(() => {
    const id = window.setTimeout(() => { void run(); }, 0);
    return () => window.clearTimeout(id);
  }, [run]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
      aria-labelledby="orch-doctor-title"
    >
      <div
        className="flex w-[520px] max-w-[94vw] max-h-[88vh] flex-col overflow-hidden rounded-lg border border-border bg-surface1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 border-b border-border px-4 py-3">
          <Stethoscope className="size-4 text-textMuted" aria-hidden />
          <h2 id="orch-doctor-title" className="flex-1 text-sm font-semibold text-text">
            {t("doctor.title", "Doctor da orquestração")}
          </h2>
          <button
            type="button"
            className="rounded p-1 text-textMuted hover:bg-surface2 hover:text-text"
            onClick={() => void run()}
            disabled={busy}
            title={t("doctor.refresh", "Rodar de novo")}
          >
            {busy ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
          </button>
          <button
            type="button"
            className="rounded p-1 text-textMuted hover:bg-surface2 hover:text-text"
            onClick={onClose}
            aria-label={t("common.close", "Fechar")}
          >
            <X className="size-4" />
          </button>
        </header>

        <div className="border-b border-border px-4 py-2 text-[11px] text-textMuted">
          {t(
            "doctor.subtitle",
            "Por que o agente não ativou? Só diagnóstico — sem correções automáticas.",
          )}
          {currentCwd && (
            <div className="mt-1 truncate font-mono text-[10px]" title={currentCwd}>
              cwd: {currentCwd}
            </div>
          )}
        </div>

        <div className="flex-1 overflow-y-auto px-4 py-3">
          {error && (
            <p className="mb-3 rounded border border-red-500/30 bg-red-500/5 px-3 py-2 text-[12px] text-red-600">
              {error}
            </p>
          )}
          {busy && !report && (
            <div className="flex items-center gap-2 py-8 text-[12px] text-textMuted">
              <Loader2 className="size-4 animate-spin" />
              {t("doctor.scanning", "Rodando checks…")}
            </div>
          )}
          {report && (
            <>
              <div
                className={cn(
                  "mb-3 rounded-md px-3 py-2 text-[12px] font-medium",
                  report.ok
                    ? "bg-emerald-500/10 text-emerald-700 dark:text-emerald-400"
                    : "bg-amber-500/10 text-amber-800 dark:text-amber-300",
                )}
              >
                {report.ok
                  ? t("doctor.allOk", "Tudo ok — a frota deveria ativar.")
                  : t(
                      "doctor.hasFails",
                      `${report.checks.filter((c) => !c.ok).length} check(s) falharam — veja os hints abaixo.`,
                    )}
              </div>
              <ul className="flex flex-col gap-2">
                {report.checks.map((c) => (
                  <CheckRow key={c.id} c={c} />
                ))}
              </ul>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}

export default OrchestrationDoctorPanel;
