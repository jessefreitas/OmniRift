// src/components/CompressorsModal.tsx
//
// Gerência dos compressores de token. Lista o catálogo (RTK + Headroom) com estado
// de detecção + INSTALA pelo app (roda o comando num terminal do canvas). Também
// permite adicionar compressores PERSONALIZADOS (nome + comando de instalação).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { nanoid } from "nanoid";
import { Gauge, RefreshCw, Download, Plus, Trash2, X } from "lucide-react";

import { compressorList, loadDefaultCompressor, saveDefaultCompressor, type CompressorInfo } from "@/lib/compress-client";
import {
  loadCustomCompressors,
  saveCustomCompressors,
  type CustomCompressor,
} from "@/lib/custom-compressors";
import { useCanvasStore } from "@/store/canvas-store";

export function CompressorsModal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<CompressorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [custom, setCustom] = useState<CustomCompressor[]>(() => loadCustomCompressors());
  const [adding, setAdding] = useState(false);
  const [newComp, setNewComp] = useState({ label: "", installCmd: "" });
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const [defaultComp, setDefaultComp] = useState<string>(() => loadDefaultCompressor());

  const refresh = () => {
    setLoading(true);
    compressorList()
      .then(setList)
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  // Roda o comando de instalação num terminal do canvas (BYO instalável pelo app).
  function runInstall(label: string, cmd: string) {
    addTerminal({
      command: "bash",
      args: [
        "-lc",
        `${cmd}; rc=$?; echo; echo "--- instalação de ${label} (código $rc) — feche este terminal e clique em ↻ ---"`,
      ],
      role: "shell",
      label: `instalar ${label}`,
    });
    onClose();
  }

  function saveNewComp() {
    const label = newComp.label.trim();
    const installCmd = newComp.installCmd.trim();
    if (!label || !installCmd) return;
    const next = [...custom, { id: nanoid(), label, installCmd }];
    setCustom(next);
    saveCustomCompressors(next);
    setNewComp({ label: "", installCmd: "" });
    setAdding(false);
  }
  function removeCustom(id: string) {
    const next = custom.filter((c) => c.id !== id);
    setCustom(next);
    saveCustomCompressors(next);
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[580px] max-w-[94vw] max-h-[85vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Gauge size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">Compressores de Token</span>
          <div className="flex-1" />
          <button onClick={() => setAdding((a) => !a)} title="Adicionar compressor personalizado" className="text-textMuted hover:text-brand p-1">
            <Plus size={15} />
          </button>
          <button onClick={refresh} title="Re-detectar" className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar"><X size={16} /></button>
        </header>

        <div className="flex items-center gap-2 px-4 py-2 border-b border-border bg-surface2/30 shrink-0">
          <span className="text-[11px] text-textMuted">Padrão p/ novos agentes:</span>
          <select
            value={defaultComp}
            onChange={(e) => { setDefaultComp(e.target.value); saveDefaultCompressor(e.target.value); }}
            className="px-2 py-1 text-[11px] rounded bg-bg border border-border text-text focus:outline-none focus:border-brand"
          >
            <option value="none">Nenhum</option>
            {list.map((c) => (<option key={c.kind} value={c.kind}>{c.label}</option>))}
          </select>
          <span className="text-[10px] text-textMuted opacity-50">cada role pode sobrescrever no editor</span>
        </div>

        {adding && (
          <div className="px-4 py-3 border-b border-border bg-surface2 space-y-1.5">
            <div className="text-[10px] uppercase tracking-wide text-textMuted">Compressor personalizado</div>
            <input
              value={newComp.label}
              onChange={(e) => setNewComp((s) => ({ ...s, label: e.target.value }))}
              placeholder="Nome (ex: MeuCompressor)"
              className="w-full px-2 py-1 text-xs rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none"
            />
            <input
              value={newComp.installCmd}
              onChange={(e) => setNewComp((s) => ({ ...s, installCmd: e.target.value }))}
              placeholder="Comando de instalação (ex: pip install … / cargo install --git …)"
              className="w-full px-2 py-1 text-xs rounded bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none font-mono"
            />
            <div className="flex items-center justify-end gap-1.5 pt-0.5">
              <button onClick={() => { setAdding(false); setNewComp({ label: "", installCmd: "" }); }} className="px-2 py-1 text-[11px] text-textMuted hover:text-text">Cancelar</button>
              <button onClick={saveNewComp} disabled={!newComp.label.trim() || !newComp.installCmd.trim()} className="px-2 py-1 text-[11px] rounded bg-brand text-bg hover:bg-brand-hover disabled:opacity-40">Adicionar</button>
            </div>
          </div>
        )}

        <div className="flex-1 overflow-auto">
          {list.map((c) => (
            <div key={c.kind} className="flex items-start gap-3 px-4 py-3 border-b border-border/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text font-medium">{c.label}</span>
                  <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-surface2 text-textMuted">
                    {c.layer === "shell" ? "saída de comando" : "chamada ao LLM"}
                  </span>
                </div>
                <div className="text-[11px] mt-0.5">
                  {c.installed ? (
                    <span className="text-green-400">✓ instalado{c.version ? ` · ${c.version}` : ""}</span>
                  ) : (
                    <span className="text-textMuted">✗ não encontrado · <code className="text-[10px]">{c.installHint}</code></span>
                  )}
                </div>
              </div>
              {!c.installed && (
                <button onClick={() => runInstall(c.label, c.installHint)} className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">
                  <Download size={13} /> Instalar
                </button>
              )}
            </div>
          ))}

          {custom.map((c) => (
            <div key={c.id} className="flex items-start gap-3 px-4 py-3 border-b border-border/40">
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-sm text-text font-medium">{c.label}</span>
                  <span className="text-[9px] uppercase tracking-wide px-1 py-0.5 rounded bg-surface2 text-textMuted">personalizado</span>
                </div>
                <div className="text-[11px] mt-0.5 text-textMuted">
                  <code className="text-[10px]">{c.installCmd}</code>
                </div>
              </div>
              <button onClick={() => runInstall(c.label, c.installCmd)} className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover">
                <Download size={13} /> Instalar
              </button>
              <button onClick={() => removeCustom(c.id)} title="Remover" className="shrink-0 text-textMuted hover:text-danger px-1 py-1.5">
                <Trash2 size={14} />
              </button>
            </div>
          ))}

          {!loading && list.length === 0 && custom.length === 0 && (
            <p className="px-4 py-4 text-[12px] text-textMuted">Nenhum compressor. Use o + pra adicionar um personalizado.</p>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          BYO: nada embutido. Instale aqui pelo terminal; depois ↻ pra re-detectar. Use o + pra um compressor próprio.
          Ligar/escolher por agente entra na próxima sub-fase.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
