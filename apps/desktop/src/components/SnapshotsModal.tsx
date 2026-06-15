// src/components/SnapshotsModal.tsx
//
// Backup/history do canvas: cria snapshots versionados do workspace e restaura
// de qualquer um. Read/restore via SQLite (snapshot_*).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Camera, RotateCcw, Trash2, X } from "lucide-react";

import { snapshotCreate, snapshotsList, snapshotGet, snapshotDelete, type SnapshotMeta } from "@/lib/snapshot-client";
import { dbSaveWorkspace } from "@/lib/db-client";
import { useCanvasStore } from "@/store/canvas-store";

interface Props {
  onClose: () => void;
}

function fmt(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

export function SnapshotsModal({ onClose }: Props) {
  const [items, setItems] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await snapshotsList());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { void load(); }, []);

  async function create() {
    const label = prompt("Rótulo do snapshot (opcional):") ?? undefined;
    const doc = JSON.stringify(useCanvasStore.getState().getWorkspaceSnapshot());
    await snapshotCreate(label?.trim() || undefined, doc);
    void load();
  }

  async function restore(id: number) {
    if (!confirm("Restaurar este snapshot? O canvas atual será substituído (salve um snapshot antes se quiser).")) return;
    const doc = await snapshotGet(id);
    if (!doc) return;
    try {
      useCanvasStore.getState().restoreWorkspace(JSON.parse(doc));
      await dbSaveWorkspace(doc);
      onClose();
    } catch (e) {
      alert("Falha ao restaurar:\n" + String(e));
    }
  }

  async function del(id: number) {
    await snapshotDelete(id);
    setItems((xs) => xs.filter((s) => s.id !== id));
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[620px] max-w-[92vw] h-[560px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Archive size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">Snapshots do canvas</span>
          <button
            onClick={() => void create()}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors"
          >
            <Camera size={13} /> Criar snapshot
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar">
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto">
          {error ? (
            <p className="px-4 py-3 text-[12px] text-danger font-mono whitespace-pre-wrap">{error}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-textMuted opacity-60">
              {loading ? "Carregando…" : "Nenhum snapshot. Crie um pra ter um ponto de restauração do canvas."}
            </p>
          ) : (
            items.map((s) => (
              <div key={s.id} className="group flex items-center gap-2 px-4 py-2 border-b border-border/40">
                <div className="min-w-0 flex-1">
                  <span className="text-[12px] text-text">{s.label || `Snapshot #${s.id}`}</span>
                  <div className="text-[10px] text-textMuted opacity-60">{fmt(s.createdAt)} · {kb(s.bytes)}</div>
                </div>
                <button
                  onClick={() => void restore(s.id)}
                  title="Restaurar"
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-textMuted hover:text-brand border border-border hover:border-brand transition-colors"
                >
                  <RotateCcw size={12} /> Restaurar
                </button>
                <button
                  onClick={() => void del(s.id)}
                  title="Apagar"
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
