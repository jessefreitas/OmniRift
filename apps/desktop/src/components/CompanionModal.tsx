// src/components/CompanionModal.tsx
//
// Painel do Companheiro: analisa o canvas (agentes + estado + memória) via LLM
// BYOK e devolve resumo + próximos passos. Equivalente ao "Ombro" do Maestri,
// mas plugável e ciente da memória.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Sparkles, RefreshCw, X } from "lucide-react";

import { analyzeCanvas } from "@/lib/companion";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

export function CompanionModal({ onClose }: Props) {
  const t = useT();
  const [out, setOut] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      setOut(await analyzeCanvas());
    } catch (e) {
      setOut(`${t("companion.error", "Erro")}: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[600px] max-w-[92vw] h-[540px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Sparkles size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">OmniPartner</span>
          <button
            onClick={() => void run()}
            disabled={loading}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> {loading ? t("companion.analyzing", "Analisando…") : t("companion.analyzeCanvas", "Analisar canvas")}
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 overflow-auto p-4">
          {out ? (
            <pre className="text-[12px] text-text whitespace-pre-wrap break-words font-sans leading-relaxed">{out}</pre>
          ) : (
            <p className="text-[12px] text-textMuted opacity-70">
              {t("companion.emptyHint", "Clique em \"Analisar canvas\" — o OmniPartner lê seus agentes, o estado deles e a memória do projeto, e sugere os próximos passos. Usa o LLM BYOK (qualquer provider), não fica preso a nuvem.")}
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
