// src/components/PromptModal.tsx
//
// Modal de input de texto reutilizável. Substitui `window.prompt`, que é NO-OP
// no WebKitGTK (Linux) — quebrava import de skill via GitHub, motivo de "ignorar"
// no review e nome de spec/plano. O @tauri-apps/plugin-dialog não tem prompt de
// texto (só message/confirm/ask/file), então rolamos o nosso. Renderiza em portal
// (igual RoleEditModal/TerminalContextMenu). Enter=OK (textarea: Ctrl+Enter),
// Esc=cancela, foco automático no mount.

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { useT } from "@/lib/i18n";

export interface PromptModalProps {
  title: string;
  defaultValue?: string;
  placeholder?: string;
  multiline?: boolean;
  onSubmit: (value: string) => void;
  onCancel: () => void;
}

export function PromptModal({ title, defaultValue, placeholder, multiline, onSubmit, onCancel }: PromptModalProps) {
  const t = useT();
  const [value, setValue] = useState(defaultValue ?? "");
  const inputRef = useRef<HTMLInputElement | null>(null);
  const areaRef = useRef<HTMLTextAreaElement | null>(null);

  // Foco + seleção do conteúdo no mount (igual window.prompt fazia).
  useEffect(() => {
    const el = multiline ? areaRef.current : inputRef.current;
    el?.focus();
    el?.select();
  }, [multiline]);

  const submit = () => onSubmit(value);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    } else if (e.key === "Enter") {
      // Input simples: Enter envia. Textarea: só Ctrl/Cmd+Enter (Enter = nova linha).
      if (!multiline || e.ctrlKey || e.metaKey) {
        e.preventDefault();
        submit();
      }
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onCancel}>
      <div
        className="w-[460px] max-w-[92vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <span className="text-sm font-medium text-text flex-1 whitespace-pre-wrap">{title}</span>
          <button onClick={onCancel} className="text-textMuted hover:text-text" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>
        <div className="p-4">
          {multiline ? (
            <textarea
              ref={areaRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              rows={5}
              placeholder={placeholder}
              className="w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text resize-y focus:outline-none focus:border-brand"
            />
          ) : (
            <input
              ref={inputRef}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={onKeyDown}
              placeholder={placeholder}
              className="w-full px-2 py-1.5 rounded-md text-sm bg-bg border border-border text-text focus:outline-none focus:border-brand"
            />
          )}
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border shrink-0">
          <button
            onClick={onCancel}
            className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2 transition-colors"
          >
            {t("common.cancel", "Cancelar")}
          </button>
          <button
            onClick={submit}
            className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover transition-colors"
          >
            {t("common.ok", "OK")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
