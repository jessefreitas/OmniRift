// src/components/SymbolBodyModal.tsx
//
// OmniGraph F2 — corpo do símbolo sob demanda. Clicar num símbolo (god node / top membro) de
// uma comunidade abre este painel: chama graph_node_body(sourceFile, symbol) e mostra o CÓDIGO
// da função/classe, read-only. null → "corpo indisponível". Reusa o shell do DiffViewerModal.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileCode, Loader2, X } from "lucide-react";

import { graphNodeBody, type SymbolBody } from "@/lib/pipeline-client";
import { useT } from "@/lib/i18n";

interface Props {
  sourceFile: string;
  symbol: string;
  onClose: () => void;
}

export function SymbolBodyModal({ sourceFile, symbol, onClose }: Props) {
  const t = useT();
  const [body, setBody] = useState<SymbolBody | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    graphNodeBody(sourceFile, symbol)
      .then((b) => { if (alive) setBody(b); })
      .catch(() => { if (alive) setBody(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sourceFile, symbol]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[820px] h-[600px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <FileCode size={15} className="text-brand" />
          <span className="text-sm font-medium text-text font-mono truncate" title={symbol}>{symbol}</span>
          {body && (
            <span className="text-[11px] text-textMuted font-mono shrink-0">
              {t("symbolBody.lines", "linhas")} {body.startLine}–{body.endLine} · {body.kind}
            </span>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("symbolBody.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={18} className="animate-spin text-textMuted" />
          </div>
        ) : body ? (
          <div className="flex-1 overflow-auto bg-bg min-w-0">
            <pre className="px-3 py-2 text-[11px] font-mono leading-[1.5] text-text whitespace-pre">{body.text}</pre>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-[12px] text-textMuted text-center">
              {t("symbolBody.unavailable", "Corpo indisponível para este nó (arquivo sumiu, linguagem não suportada, ou símbolo não localizado).")}
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
