// src/components/MemoryModal.tsx
//
// Navegador da memória dos agentes (agent_memory). Lista/filtra/apaga fatos do
// blackboard e erros registrados. Mesmas memórias das tools MCP memory_*.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Brain, Plus, RefreshCw, Trash2, X } from "lucide-react";

import { memoryQuery, memoryDelete, memoryAdd, type Memory } from "@/lib/memory-client";
import { cn } from "@/lib/cn";

interface Props {
  onClose: () => void;
}

const KINDS = [
  { id: "", label: "Tudo" },
  { id: "fact", label: "Fatos" },
  { id: "error", label: "Erros" },
  { id: "note", label: "Notas" },
];

function kindStyle(k: string): string {
  switch (k) {
    case "error": return "text-danger border-danger/40 bg-danger/10";
    case "note": return "text-blue-400 border-blue-400/40 bg-blue-400/10";
    default: return "text-green-400 border-green-400/40 bg-green-400/10"; // fact
  }
}

function fmt(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

export function MemoryModal({ onClose }: Props) {
  const [items, setItems] = useState<Memory[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [newFact, setNewFact] = useState("");

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await memoryQuery({ kind: kind || undefined, query: query || undefined }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [kind]);

  async function addFact() {
    const v = newFact.trim();
    if (!v) return;
    await memoryAdd(v, "fact");
    setNewFact("");
    void load();
  }

  async function del(id: number) {
    await memoryDelete(id);
    setItems((xs) => xs.filter((m) => m.id !== id));
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[760px] h-[640px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Brain size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">Memória dos agentes</span>
          <span className="text-[11px] text-textMuted opacity-60">{items.length}</span>
          <div className="flex-1" />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void load(); }}
            placeholder="buscar… (Enter)"
            className="w-48 px-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
          />
          <button onClick={() => void load()} title="Recarregar" className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar">
            <X size={16} />
          </button>
        </header>

        {/* Filtro por kind */}
        <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border shrink-0">
          {KINDS.map((k) => (
            <button
              key={k.id}
              onClick={() => setKind(k.id)}
              className={cn(
                "px-2 py-0.5 rounded text-[11px]",
                kind === k.id ? "bg-brand text-bg" : "bg-bg text-textMuted hover:text-text border border-border",
              )}
            >
              {k.label}
            </button>
          ))}
        </div>

        {/* Lista */}
        <div className="flex-1 overflow-auto">
          {error ? (
            <p className="px-4 py-3 text-[12px] text-danger font-mono whitespace-pre-wrap">{error}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-textMuted opacity-60">
              {loading ? "Carregando…" : "Nada na memória. Os agentes gravam aqui via memory_remember / memory_remember_error."}
            </p>
          ) : (
            items.map((m) => (
              <div key={m.id} className="group flex items-start gap-2 px-4 py-2 border-b border-border/40">
                <span className={cn("shrink-0 px-1.5 py-0.5 rounded border text-[10px] uppercase tracking-wide", kindStyle(m.kind))}>
                  {m.kind}
                </span>
                <div className="min-w-0 flex-1">
                  {m.memKey && <span className="text-[11px] text-brand font-mono mr-2">[{m.memKey}]</span>}
                  <span className="text-[12px] text-text whitespace-pre-wrap break-words">{m.value}</span>
                  <div className="flex items-center gap-2 mt-0.5 text-[10px] text-textMuted opacity-50">
                    <span>{fmt(m.createdAt)}</span>
                    {m.scope && <span>· {m.scope}</span>}
                    {m.tags && <span>· {m.tags}</span>}
                    <span>· #{m.id}</span>
                  </div>
                </div>
                <button
                  onClick={() => void del(m.id)}
                  title="Apagar"
                  className="opacity-0 group-hover:opacity-100 text-textMuted hover:text-danger p-1 shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              </div>
            ))
          )}
        </div>

        {/* Adicionar fato manual */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border shrink-0">
          <input
            value={newFact}
            onChange={(e) => setNewFact(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void addFact(); }}
            placeholder="adicionar um fato ao blackboard…"
            className="flex-1 px-2 py-1.5 rounded text-[12px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
          />
          <button
            onClick={() => void addFact()}
            disabled={!newFact.trim()}
            className="flex items-center gap-1 px-2.5 py-1.5 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 transition-colors"
          >
            <Plus size={13} /> Add
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
