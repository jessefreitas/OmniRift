// src/components/CompressorsModal.tsx
//
// Gerência dos compressores de token (RTK + Headroom). BYO: lista o catálogo com
// estado de detecção e INSTALA pelo app (roda o comando num terminal do canvas,
// igual ao instalador de CLIs). Ligar/escolher por node entra na sub-fase de wiring.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Gauge, RefreshCw, Download, X } from "lucide-react";

import { compressorList, type CompressorInfo } from "@/lib/compress-client";
import { useCanvasStore } from "@/store/canvas-store";

export function CompressorsModal({ onClose }: { onClose: () => void }) {
  const [list, setList] = useState<CompressorInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const addTerminal = useCanvasStore((s) => s.addTerminal);

  const refresh = () => {
    setLoading(true);
    compressorList()
      .then(setList)
      .catch(() => setList([]))
      .finally(() => setLoading(false));
  };
  useEffect(refresh, []);

  function install(c: CompressorInfo) {
    // Roda o comando de instalação num terminal do canvas (BYO instalável pelo app).
    addTerminal({
      command: "bash",
      args: [
        "-lc",
        `${c.installHint}; rc=$?; echo; echo "--- instalação de ${c.label} (código $rc) — feche este terminal e clique em ↻ ---"`,
      ],
      role: "shell",
      label: `instalar ${c.label}`,
    });
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[560px] max-w-[94vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Gauge size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">Compressores de Token</span>
          <div className="flex-1" />
          <button onClick={refresh} title="Re-detectar" className="text-textMuted hover:text-brand p-1">
            <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title="Fechar"><X size={16} /></button>
        </header>

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
                <button
                  onClick={() => install(c)}
                  className="shrink-0 flex items-center gap-1 px-2.5 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover"
                >
                  <Download size={13} /> Instalar
                </button>
              )}
            </div>
          ))}
          {!loading && list.length === 0 && (
            <p className="px-4 py-4 text-[12px] text-textMuted">Nenhum compressor no catálogo.</p>
          )}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          BYO (bring-your-own): nada embutido no app. Instale aqui pelo terminal; depois clique ↻ pra re-detectar.
          Ligar/escolher o compressor por agente entra na próxima sub-fase.
        </footer>
      </div>
    </div>,
    document.body,
  );
}
