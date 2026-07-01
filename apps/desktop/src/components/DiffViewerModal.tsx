// src/components/DiffViewerModal.tsx
//
// Visualizador de diff de um floor (= branch git num worktree) vs sua base.
// Lista de arquivos à esquerda, patch unificado colorido à direita. Read-only.

import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { FileDiff as FileDiffIcon, RefreshCw, X } from "lucide-react";

import { parallelGitDiff, type FileDiff, type ParallelDiff } from "@/lib/git-client";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import type { Parallel } from "@/types/workspace";

interface Props {
  floor: Parallel;
  onClose: () => void;
}

/** Cor + rótulo da letra de status do arquivo. */
function statusBadge(s: string): { cls: string; label: string } {
  switch (s[0]) {
    case "A": return { cls: "text-green-400", label: "novo" };
    case "D": return { cls: "text-danger", label: "removido" };
    case "R": return { cls: "text-blue-400", label: "renomeado" };
    case "C": return { cls: "text-purple-400", label: "copiado" };
    default: return { cls: "text-yellow-400", label: "modificado" };
  }
}

/** Renderiza um patch unificado com linhas coloridas. */
export function DiffLines({ patch }: { patch: string }) {
  const lines = patch.split("\n");
  return (
    <pre className="text-[11px] font-mono leading-[1.45]">
      {lines.map((ln, i) => {
        let cls = "text-text";
        let bg = "";
        if (ln.startsWith("@@")) cls = "text-brand";
        else if (ln.startsWith("+++") || ln.startsWith("---") || ln.startsWith("diff --git") || ln.startsWith("index ") || ln.startsWith("new file") || ln.startsWith("deleted file") || ln.startsWith("rename ")) cls = "text-textMuted opacity-50";
        else if (ln.startsWith("+")) { cls = "text-green-300"; bg = "bg-green-500/10"; }
        else if (ln.startsWith("-")) { cls = "text-red-300"; bg = "bg-red-500/10"; }
        return (
          <div key={i} className={cn("px-2 whitespace-pre-wrap break-all", cls, bg)}>
            {ln || " "}
          </div>
        );
      })}
    </pre>
  );
}

export function DiffViewerModal({ floor, onClose }: Props) {
  const t = useT();
  const [diff, setDiff] = useState<ParallelDiff | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const base = floor.baseBranch ?? "main";

  async function load() {
    if (!floor.worktreePath) return;
    setLoading(true);
    setError(null);
    try {
      const d = await parallelGitDiff(floor.worktreePath, base);
      setDiff(d);
      setSelected((cur) => cur ?? d.files[0]?.path ?? null);
    } catch (e) {
      setError(String(e));
      setDiff(null);
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [floor.worktreePath, base]);

  const current: FileDiff | undefined = useMemo(
    () => diff?.files.find((f) => f.path === selected),
    [diff, selected],
  );

  const totals = useMemo(() => {
    const add = diff?.files.reduce((a, f) => a + f.additions, 0) ?? 0;
    const del = diff?.files.reduce((a, f) => a + f.deletions, 0) ?? 0;
    return { add, del };
  }, [diff]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[960px] h-[680px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <FileDiffIcon size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("diffViewer.title", "Diff do paralelo")}</span>
          <span className="text-xs text-textMuted font-mono">
            {floor.branch ?? floor.name} <span className="opacity-50">vs</span> {base}
          </span>
          {diff && (
            <span className="text-[11px] font-mono ml-1">
              <span className="text-green-400">+{totals.add}</span>{" "}
              <span className="text-danger">−{totals.del}</span>
            </span>
          )}
          <div className="flex-1" />
          <button onClick={() => void load()} title={t("diffViewer.reload", "Recarregar")} className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("diffViewer.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {error ? (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-[12px] text-danger font-mono whitespace-pre-wrap text-center">{error}</p>
          </div>
        ) : (
          <div className="flex-1 flex min-h-0">
            {/* Lista de arquivos */}
            <div className="w-72 shrink-0 border-r border-border overflow-auto bg-bg/40">
              {loading && !diff ? (
                <p className="px-3 py-3 text-[11px] text-textMuted opacity-60">{t("diffViewer.loading", "Carregando diff…")}</p>
              ) : diff && (diff.files.length > 0 || diff.untracked.length > 0) ? (
                <>
                  {diff.files.map((f) => {
                    const b = statusBadge(f.status);
                    const label = t("diffStatus." + b.label, b.label);
                    return (
                      <button
                        key={f.path}
                        onClick={() => setSelected(f.path)}
                        title={f.path}
                        className={cn(
                          "w-full flex items-center gap-1.5 px-2.5 py-1.5 text-left border-b border-border/40",
                          selected === f.path ? "bg-surface2" : "hover:bg-surface2/50",
                        )}
                      >
                        <span className={cn("text-[10px] font-bold w-3 shrink-0", b.cls)} title={label}>{f.status[0]}</span>
                        <span className="text-[11px] text-text truncate flex-1 font-mono">{f.path}</span>
                        <span className="text-[10px] font-mono shrink-0">
                          <span className="text-green-400">+{f.additions}</span>
                          <span className="text-danger ml-1">−{f.deletions}</span>
                        </span>
                      </button>
                    );
                  })}
                  {diff.untracked.length > 0 && (
                    <div className="px-2.5 py-1.5">
                      <p className="text-[9px] uppercase tracking-wide text-textMuted opacity-50 mb-1">{t("diffViewer.untracked", "Não rastreados")} ({diff.untracked.length})</p>
                      {diff.untracked.map((u) => (
                        <p key={u} className="text-[11px] text-green-400/80 truncate font-mono" title={u}>+ {u}</p>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <p className="px-3 py-3 text-[11px] text-textMuted opacity-60">{t("diffViewer.noChanges", "Sem mudanças vs")} {base}.</p>
              )}
            </div>

            {/* Patch do arquivo selecionado */}
            <div className="flex-1 overflow-auto bg-bg min-w-0">
              {current ? (
                <DiffLines patch={current.patch} />
              ) : (
                <p className="px-3 py-3 text-[11px] text-textMuted opacity-50">{t("diffViewer.selectFile", "Selecione um arquivo à esquerda.")}</p>
              )}
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
