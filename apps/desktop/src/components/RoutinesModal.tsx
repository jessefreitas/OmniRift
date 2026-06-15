// src/components/RoutinesModal.tsx
//
// CRUD das Routines + rodar manualmente. Ações automatizadas (comando shell)
// com trigger manual ou por intervalo. Persiste em localStorage.

import { useState } from "react";
import { createPortal } from "react-dom";
import { nanoid } from "nanoid";
import { Play, Plus, Repeat, Trash2, X } from "lucide-react";

import { loadRoutines, saveRoutines, runRoutine, type Routine } from "@/lib/routines";

interface Props {
  onClose: () => void;
}

export function RoutinesModal({ onClose }: Props) {
  const [routines, setRoutines] = useState<Routine[]>(() => loadRoutines());

  function persist(next: Routine[]) {
    setRoutines(next);
    saveRoutines(next);
  }

  function add() {
    persist([
      ...routines,
      { id: nanoid(), name: "Nova routine", command: "", intervalMin: null, enabled: false },
    ]);
  }

  function patch(id: string, p: Partial<Routine>) {
    persist(routines.map((r) => (r.id === id ? { ...r, ...p } : r)));
  }

  function del(id: string) {
    persist(routines.filter((r) => r.id !== id));
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
            onClick={add}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors"
          >
            <Plus size={13} /> Nova
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {routines.length === 0 ? (
            <p className="px-1 py-3 text-[12px] text-textMuted opacity-60">
              Sem routines. Crie uma ação (comando shell) com trigger manual ou por intervalo.
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
                    onClick={() => runRoutine(r)}
                    disabled={!r.command.trim()}
                    title="Rodar agora"
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:text-brand border border-border disabled:opacity-40"
                  >
                    <Play size={11} /> Rodar
                  </button>
                  <button onClick={() => del(r.id)} title="Apagar" className="text-textMuted hover:text-danger p-1">
                    <Trash2 size={13} />
                  </button>
                </div>
                <input
                  value={r.command}
                  onChange={(e) => patch(r.id, { command: e.target.value })}
                  placeholder="comando shell (ex: git fetch --all)"
                  className="w-full px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
                />
                <div className="flex items-center gap-3 text-[11px] text-textMuted">
                  <label className="flex items-center gap-1.5">
                    <input
                      type="checkbox"
                      checked={r.enabled}
                      onChange={(e) => patch(r.id, { enabled: e.target.checked })}
                    />
                    ativa
                  </label>
                  <label className="flex items-center gap-1.5">
                    a cada
                    <input
                      type="number"
                      min={0}
                      value={r.intervalMin ?? ""}
                      onChange={(e) => patch(r.id, { intervalMin: e.target.value ? Number(e.target.value) : null })}
                      placeholder="—"
                      className="w-16 px-1.5 py-0.5 rounded text-[11px] bg-bg border border-border text-text focus:outline-none focus:border-brand"
                    />
                    min {r.intervalMin ? "" : "(manual)"}
                  </label>
                </div>
              </div>
            ))
          )}
        </div>
        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          Routines ativas com intervalo rodam em background enquanto o app está aberto, no floor ativo.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
