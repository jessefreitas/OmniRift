// src/components/ReviewSettingsModal.tsx
//
// Painel unificado "Code Review IA": junta o LLM (BYOK) e a Política de review
// em abas, num lugar só. Reusa os modais existentes em modo `embedded` (sem
// backdrop/portal próprio) — cada aba mantém o seu próprio Salvar.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Cpu, ScanSearch, Sliders, X } from "lucide-react";

import { LlmConfigModal } from "@/components/LlmConfigModal";
import { ReviewPolicyModal } from "@/components/ReviewPolicyModal";
import { useT } from "@/lib/i18n";

type Tab = "llm" | "policy";

interface Props {
  /** cwd do projeto ativo — habilita as seções committed em .forgejo na Política. */
  cwd: string | null;
  onClose: () => void;
}

const TABS: { id: Tab; labelKey: string; labelPt: string; icon: typeof Cpu }[] = [
  { id: "llm", labelKey: "reviewSettings.tabLlm", labelPt: "LLM (BYOK)", icon: Cpu },
  { id: "policy", labelKey: "reviewSettings.tabPolicy", labelPt: "Política", icon: Sliders },
];

export function ReviewSettingsModal({ cwd, onClose }: Props) {
  const t = useT();
  const [tab, setTab] = useState<Tab>("llm");

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[700px] max-w-[94vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <ScanSearch size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("reviewSettings.title", "Code Review IA")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("reviewSettings.close", "Fechar")}><X size={16} /></button>
        </header>

        <div className="flex gap-1 px-3 pt-2 border-b border-border shrink-0">
          {TABS.map(({ id, labelKey, labelPt, icon: Icon }) => (
            <button
              key={id}
              onClick={() => setTab(id)}
              className={
                "flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-t-md border-b-2 -mb-px transition-colors " +
                (tab === id
                  ? "border-brand text-text bg-surface2/40"
                  : "border-transparent text-textMuted hover:text-text")
              }
            >
              <Icon size={13} /> {t(labelKey, labelPt)}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto">
          {tab === "llm" ? (
            <LlmConfigModal embedded onClose={onClose} />
          ) : (
            <ReviewPolicyModal embedded scopeLabel="global" cwd={cwd} onClose={onClose} />
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
