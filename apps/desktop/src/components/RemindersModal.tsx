// src/components/RemindersModal.tsx
//
// Lembretes salvos a partir de notas do canvas. Lista persistente (SQLite):
// marcar feito, abrir a nota no canvas (troca projeto/floor) e excluir.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Bookmark, ExternalLink, Trash2, X } from "lucide-react";

import { remindersList, reminderSetDone, reminderDelete, type Reminder } from "@/lib/reminder-client";
import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

function fmt(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function RemindersModal({ onClose }: Props) {
  const t = useT();
  const [items, setItems] = useState<Reminder[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await remindersList());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    let mounted = true;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const items = await remindersList();
        if (!mounted) return;
        setItems(items);
      } catch (e) {
        if (!mounted) return;
        setError(String(e));
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }
    void run();
    return () => { mounted = false; };
  }, []);

  async function toggle(r: Reminder) {
    await reminderSetDone(r.id, !r.done);
    setItems((xs) => xs.map((x) => (x.id === r.id ? { ...x, done: !x.done } : x)));
  }
  async function del(id: number) {
    await reminderDelete(id);
    setItems((xs) => xs.filter((x) => x.id !== id));
  }
  function openOnCanvas(r: Reminder) {
    const s = useCanvasStore.getState();
    if (r.projectId && r.projectId !== s.activeProjectId) s.setActiveProject(r.projectId);
    if (r.floorId) useCanvasStore.getState().switchParallel(r.floorId);
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[600px] max-w-[92vw] h-[560px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Bookmark size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("reminders.title", "Lembretes")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto">
          {error ? (
            <p className="px-4 py-3 text-[12px] text-danger font-mono whitespace-pre-wrap">{error}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-textMuted opacity-60">
              {loading
                ? t("common.loading", "Carregando…")
                : t("reminders.empty", "Nenhum lembrete. Numa nota do canvas, clique no 📌 pra salvar aqui.")}
            </p>
          ) : (
            items.map((r) => (
              <div key={r.id} className="group flex items-start gap-2 px-4 py-2 border-b border-border/40">
                <input
                  type="checkbox"
                  checked={r.done}
                  onChange={() => void toggle(r)}
                  title={r.done ? t("reminders.reopen", "Reabrir") : t("reminders.markDone", "Marcar como feito")}
                  className="mt-0.5 accent-brand shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <p className={cn("text-[12px] whitespace-pre-wrap break-words", r.done ? "text-textMuted line-through opacity-60" : "text-text")}>
                    {r.content}
                  </p>
                  <div className="text-[10px] text-textMuted opacity-60 mt-0.5">
                    {fmt(r.createdAt)}
                    {r.remindAt ? ` · ⏰ ${r.remindAt}` : ""}
                  </div>
                </div>
                {r.floorId && (
                  <button
                    onClick={() => openOnCanvas(r)}
                    title={t("reminders.openNoteTitle", "Abrir a nota no canvas")}
                    className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-2 py-1 rounded text-[11px] text-textMuted hover:text-brand border border-border hover:border-brand transition-colors shrink-0"
                  >
                    <ExternalLink size={12} /> {t("common.open", "Abrir")}
                  </button>
                )}
                <button
                  onClick={() => void del(r.id)}
                  title={t("reminders.deleteTitle", "Excluir lembrete")}
                  className="opacity-0 group-hover:opacity-100 text-textMuted hover:text-danger p-1 shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
