// src/components/ReleaseNotesModal.tsx
//
// Central de Releases — histórico COMPLETO de versões do OmniRift numa timeline
// vertical (mais recente no topo) + busca. Dados 100% estáticos (RELEASES de
// releases.ts), então sem zustand/IO — estado local só pra busca. Segue o padrão
// visual do HelpModal/OmniFsModal (createPortal, overlay bg-black/50, card
// bg-surface1, useT, cn, ícones lucide).

import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { Rocket, Search, X, Sparkles, Wrench, Cog } from "lucide-react";

import { RELEASES, type ReleaseEntry } from "@/lib/releases";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

/** Cor/rótulo/ícone sutil por tipo de versão (feature=verde, fix=amarelo, infra=azul). */
const TAG_META: Record<
  NonNullable<ReleaseEntry["tag"]>,
  { dot: string; text: string; label: string; icon: typeof Sparkles }
> = {
  feature: { dot: "bg-green-500", text: "text-green-400", label: "novidade", icon: Sparkles },
  fix: { dot: "bg-yellow-400", text: "text-yellow-300", label: "correção", icon: Wrench },
  infra: { dot: "bg-sky-400", text: "text-sky-300", label: "infra", icon: Cog },
};

/** Data ISO → legível pt (ex.: "03 jul 2026"). Fallback: string crua. */
function fmtDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  if (Number.isNaN(d.getTime())) return iso;
  try {
    return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "short", year: "numeric" });
  } catch {
    return iso;
  }
}

export function ReleaseNotesModal({ onClose }: Props) {
  const t = useT();
  const [query, setQuery] = useState("");

  const q = query.trim().toLowerCase();
  const filtered = useMemo(
    () =>
      !q
        ? RELEASES
        : RELEASES.filter(
            (r) =>
              r.version.toLowerCase().includes(q) ||
              r.title.toLowerCase().includes(q) ||
              r.highlights.some((h) => h.toLowerCase().includes(q)),
          ),
    [q],
  );

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[720px] max-w-[95vw] h-[640px] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Rocket size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">
            {t("releases.title", "Novidades — Releases do OmniRift")}
          </span>
          <div className="flex-1" />
          <div className="relative">
            <Search size={12} className="absolute left-2 top-1/2 -translate-y-1/2 text-textMuted" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("releases.searchPh", "buscar versão ou novidade…")}
              className="w-52 pl-6 pr-2 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
            />
          </div>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {/* Timeline vertical — mais recente no topo */}
        <div className="flex-1 overflow-auto px-5 py-4">
          {filtered.length === 0 ? (
            <p className="py-8 text-center text-[12px] text-textMuted opacity-60">
              {t("releases.notFound", "Nenhuma versão encontrada.")}
            </p>
          ) : (
            <ol className="relative">
              {/* Linha do tempo (fio vertical) */}
              <div className="absolute left-[5px] top-1 bottom-1 w-px bg-border" aria-hidden />
              {filtered.map((r) => {
                const meta = r.tag ? TAG_META[r.tag] : null;
                const TagIcon = meta?.icon;
                return (
                  <li key={r.version} className="relative pl-6 pb-5 last:pb-1">
                    {/* Marcador na linha do tempo */}
                    <span
                      className={cn(
                        "absolute left-0 top-1.5 w-[11px] h-[11px] rounded-full border-2 border-surface1",
                        meta?.dot ?? "bg-textMuted",
                      )}
                      aria-hidden
                    />
                    <div className="flex items-center flex-wrap gap-x-2 gap-y-1">
                      <span className="inline-flex items-center rounded bg-brand/15 text-brand text-[11px] font-semibold px-1.5 py-0.5 tabular-nums">
                        v{r.version}
                      </span>
                      <span className="text-[10px] text-textMuted tabular-nums">{fmtDate(r.date)}</span>
                      {meta && TagIcon && (
                        <span className={cn("inline-flex items-center gap-1 text-[10px]", meta.text)}>
                          <TagIcon size={10} />
                          {t(`releases.tag.${r.tag}`, meta.label)}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 text-[13px] font-medium text-text leading-snug">{r.title}</div>
                    {r.highlights.length > 0 && (
                      <ul className="mt-1 space-y-0.5">
                        {r.highlights.map((h, i) => (
                          <li key={i} className="flex items-start gap-1.5 text-[12px] text-textMuted leading-snug">
                            <span className="text-brand/70 mt-[1px] shrink-0">•</span>
                            <span>{h}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </li>
                );
              })}
            </ol>
          )}
        </div>

        <footer className="flex items-center gap-3 px-4 py-2 border-t border-border shrink-0">
          <Rocket size={12} className="text-textMuted opacity-70 shrink-0" />
          <span className="text-[10px] text-textMuted opacity-70">
            {t("releases.count", "77 versões · desde 2026-06-19")}
          </span>
          <div className="flex-1" />
          {q && (
            <span className="text-[10px] text-textMuted opacity-60 tabular-nums">
              {filtered.length}/{RELEASES.length}
            </span>
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
