// src/components/HelpModal.tsx
//
// Manual interno do OmniRift: lista de tópicos (esquerda) + markdown renderizado
// (direita) + busca. Conteúdo bundlado em help-content.ts.

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { BookOpen, Search, X } from "lucide-react";

import { HELP_TOPICS } from "@/lib/help-content";
import { renderMarkdown } from "@/lib/preview-client";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

export function HelpModal({ onClose }: Props) {
  const t = useT();
  const [activeId, setActiveId] = useState(HELP_TOPICS[0]?.id ?? "");
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      !q
        ? HELP_TOPICS
        : HELP_TOPICS.filter(
            (t) => t.title.toLowerCase().includes(q) || t.body.toLowerCase().includes(q),
          ),
    [q],
  );

  const active = HELP_TOPICS.find((t) => t.id === activeId) ?? filtered[0] ?? HELP_TOPICS[0];
  const html = useMemo(() => (active ? renderMarkdown(active.body) : ""), [active]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[860px] max-w-[95vw] h-[620px] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <BookOpen size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("help.title", "Manual do OmniRift")}</span>
          <div className="flex-1" />
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-textMuted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("help.searchPh", "buscar…")}
              className="w-44 pl-6 pr-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
            />
          </div>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        <div className="flex-1 flex min-h-0">
          {/* Lista de tópicos */}
          <nav className="w-52 shrink-0 border-r border-border overflow-auto py-2 bg-bg/30">
            {filtered.length === 0 ? (
              <p className="px-3 py-2 text-[11px] text-textMuted opacity-60">{t("help.notFound", "nada encontrado")}</p>
            ) : (
              filtered.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setActiveId(t.id)}
                  className={cn(
                    "w-full text-left px-3 py-1.5 text-[12px] truncate transition-colors",
                    active?.id === t.id
                      ? "text-brand bg-brand/10 border-l-2 border-brand"
                      : "text-textMuted hover:text-text hover:bg-surface2 border-l-2 border-transparent",
                  )}
                >
                  {t.title}
                </button>
              ))
            )}
          </nav>

          {/* Conteúdo */}
          <div className="flex-1 overflow-auto px-5 py-4">
            <div
              className="md-preview text-text text-[13px] leading-relaxed"
              dangerouslySetInnerHTML={{ __html: html }}
            />
          </div>
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t("help.footer1", "Cada node também tem um ícone")} <b>?</b> {t("help.footer2", "no cabeçalho com ajuda contextual.")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
