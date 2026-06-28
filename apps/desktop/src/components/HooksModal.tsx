// src/components/HooksModal.tsx
//
// Configura os hooks de ciclo de vida do floor (onCreate / onLand). Comandos
// shell rodados no worktree do floor. Salvos em localStorage.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Webhook, X } from "lucide-react";

import { loadHooks, saveHooks } from "@/lib/hooks-client";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

export function HooksModal({ onClose }: Props) {
  const t = useT();
  const init = loadHooks();
  const [onCreate, setOnCreate] = useState(init.onCreate ?? "");
  const [onLand, setOnLand] = useState(init.onLand ?? "");

  function save() {
    saveHooks({ onCreate: onCreate.trim() || undefined, onLand: onLand.trim() || undefined });
    onClose();
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[560px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <Webhook size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("hooks.title", "Hooks do paralelo")}</span>
          <button onClick={onClose} className="text-textMuted hover:text-text" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-4">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">onCreate</label>
            <input
              value={onCreate}
              onChange={(e) => setOnCreate(e.target.value)}
              placeholder={t("hooks.onCreatePh", "ex: npm install")}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono"
            />
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {t("hooks.onCreateDesc", "Roda num terminal no paralelo-branch recém-criado (worktree limpo).")}
            </p>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">onLand</label>
            <input
              value={onLand}
              onChange={(e) => setOnLand(e.target.value)}
              placeholder={t("hooks.onLandPh", "ex: npm test")}
              className="mt-1 w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand font-mono"
            />
            <p className="mt-1 text-[10px] text-textMuted opacity-60">
              {t("hooks.onLandDesc", "Roda (bloqueante) no worktree ANTES do merge — se falhar (exit ≠ 0), o Land é abortado.")}
            </p>
          </div>
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2 transition-colors">
            {t("common.cancel", "Cancelar")}
          </button>
          <button onClick={save} className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover transition-colors">
            {t("common.save", "Salvar")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
