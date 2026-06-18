// src/components/AppearanceModal.tsx
//
// Painel Aparência: modo claro/escuro, temas prontos, cor de destaque, fontes e
// editor de TODOS os tokens de cor. Pré-visualização ao vivo + auto-save.

import { useState } from "react";
import { createPortal } from "react-dom";
import { Check, Copy, Palette, RotateCcw, X } from "lucide-react";

import {
  ACCENTS, FONT_MONO, FONT_SANS, PRESETS, TOKENS,
  applyTheme, channelsToHex, defaultTheme, hexToChannels, loadTheme, saveTheme,
  type Theme, type ThemeMode,
} from "@/lib/theme-client";
import { useT, useI18n, type Locale } from "@/lib/i18n";

export function AppearanceModal({ onClose }: { onClose: () => void }) {
  const [theme, setTheme] = useState<Theme>(() => loadTheme());
  const [copied, setCopied] = useState(false);
  const tr = useT();
  const locale = useI18n((s) => s.locale);
  const setLocale = useI18n((s) => s.setLocale);

  // Aplica + persiste a cada mudança (preview ao vivo).
  function apply(next: Theme) {
    setTheme(next);
    applyTheme(next);
    saveTheme(next);
  }
  const setColor = (key: string, ch: string) => apply({ ...theme, colors: { ...theme.colors, [key]: ch } });

  function exportTheme() {
    navigator.clipboard.writeText(JSON.stringify(theme, null, 2))
      .then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })
      .catch(() => {});
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="w-[620px] max-w-[94vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Palette size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{tr("appearance.title")}</span>
          <button onClick={exportTheme} title={tr("appearance.copyTheme")} className="text-textMuted hover:text-brand p-1">{copied ? <Check size={14} /> : <Copy size={14} />}</button>
          <button onClick={() => apply(defaultTheme(theme.mode))} title={tr("appearance.reset")} className="text-textMuted hover:text-brand p-1"><RotateCcw size={14} /></button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={tr("appearance.close")}><X size={16} /></button>
        </header>

        <div className="flex-1 overflow-auto p-4 space-y-4 text-[12px]">
          {/* Idioma */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-textMuted w-20">{tr("appearance.language")}</span>
            {(["pt", "en"] as Locale[]).map((l) => (
              <button
                key={l}
                onClick={() => setLocale(l)}
                className={"px-3 py-1 rounded border text-[11px] " + (locale === l ? "border-brand text-brand" : "border-border text-textMuted hover:text-text")}
              >
                {l === "pt" ? "Português" : "English"}
              </button>
            ))}
          </div>

          {/* Modo */}
          <div className="flex items-center gap-2">
            <span className="text-[11px] uppercase tracking-wider text-textMuted w-20">{tr("appearance.mode")}</span>
            {(["dark", "light"] as ThemeMode[]).map((m) => (
              <button
                key={m}
                onClick={() => apply({ ...defaultTheme(m), fontSans: theme.fontSans, fontMono: theme.fontMono })}
                className={"px-3 py-1 rounded border text-[11px] " + (theme.mode === m ? "border-brand text-brand" : "border-border text-textMuted hover:text-text")}
              >
                {m === "dark" ? tr("appearance.dark") : tr("appearance.light")}
              </button>
            ))}
          </div>

          {/* Temas prontos */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{tr("appearance.presets")}</div>
            <div className="flex flex-wrap gap-1.5">
              {PRESETS.map((p) => (
                <button key={p.name} onClick={() => apply(p.theme)} className="px-2.5 py-1 rounded border border-border text-[11px] text-textMuted hover:text-brand hover:border-brand">
                  {tr("themePreset." + p.name, p.name)}
                </button>
              ))}
            </div>
          </div>

          {/* Cor de destaque */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{tr("appearance.accent")}</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {ACCENTS.map((a) => (
                <button key={a.name} title={tr("accent." + a.name, a.name)} onClick={() => apply({ ...theme, colors: { ...theme.colors, brand: a.brand, "brand-hover": a.hover } })}
                  className="w-6 h-6 rounded-full border border-border" style={{ background: `rgb(${a.brand})` }} />
              ))}
              <input type="color" value={channelsToHex(theme.colors.brand)}
                onChange={(e) => apply({ ...theme, colors: { ...theme.colors, brand: hexToChannels(e.target.value), "brand-hover": hexToChannels(e.target.value) } })}
                className="w-6 h-6 rounded bg-transparent border border-border cursor-pointer" title={tr("appearance.customColor")} />
            </div>
          </div>

          {/* Fontes */}
          <div className="flex gap-3">
            <label className="flex-1">
              <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{tr("appearance.fontText")}</div>
              <select value={theme.fontSans} onChange={(e) => apply({ ...theme, fontSans: e.target.value })} className="w-full px-2 py-1 rounded bg-bg border border-border text-text text-[11px]">
                {Object.entries(FONT_SANS).map(([name, stack]) => (<option key={name} value={stack}>{name}</option>))}
              </select>
            </label>
            <label className="flex-1">
              <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{tr("appearance.fontMono")}</div>
              <select value={theme.fontMono} onChange={(e) => apply({ ...theme, fontMono: e.target.value })} className="w-full px-2 py-1 rounded bg-bg border border-border text-text text-[11px] font-mono">
                {Object.entries(FONT_MONO).map(([name, stack]) => (<option key={name} value={stack}>{name}</option>))}
              </select>
            </label>
          </div>

          {/* Editor completo de tokens */}
          <div>
            <div className="text-[11px] uppercase tracking-wider text-textMuted mb-1">{tr("appearance.allColors")}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5">
              {TOKENS.map((t) => (
                <label key={t.key} className="flex items-center gap-2">
                  <input type="color" value={channelsToHex(theme.colors[t.key] ?? "0 0 0")} onChange={(e) => setColor(t.key, hexToChannels(e.target.value))}
                    className="w-6 h-6 rounded bg-transparent border border-border cursor-pointer shrink-0" />
                  <span className="text-[11px] text-text truncate">{tr("token." + t.key, t.label)}</span>
                  <span className="ml-auto text-[9px] font-mono text-textMuted">{channelsToHex(theme.colors[t.key] ?? "0 0 0")}</span>
                </label>
              ))}
            </div>
          </div>
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-70 shrink-0">
          {tr("appearance.footer")}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
