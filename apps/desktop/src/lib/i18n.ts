// src/lib/i18n.ts
//
// i18n leve do OmniRift (camada própria, sem dependência). Locale persistido +
// auto-detectado do SO. `useT()` re-renderiza ao trocar de idioma. Fallback PT.

import { create } from "zustand";

import { pt } from "./locales/pt";
import { en } from "./locales/en";

export type Locale = "pt" | "en";

const DICTS: Record<Locale, Record<string, string>> = { pt, en };
const KEY = "omnirift-locale";

function detect(): Locale {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved === "pt" || saved === "en") return saved;
  } catch { /* localStorage off */ }
  const nav = typeof navigator !== "undefined" ? navigator.language : "pt";
  return nav.toLowerCase().startsWith("pt") ? "pt" : "en";
}

interface I18nState {
  locale: Locale;
  setLocale: (l: Locale) => void;
}

export const useI18n = create<I18nState>((set) => ({
  locale: detect(),
  setLocale: (l) => {
    try { localStorage.setItem(KEY, l); } catch { /* off */ }
    set({ locale: l });
  },
}));

/** Traduz uma chave no locale atual (fallback: PT → a própria chave). */
export function translate(locale: Locale, key: string, fallback?: string): string {
  return DICTS[locale][key] ?? DICTS.pt[key] ?? fallback ?? key;
}

/** Hook que re-renderiza ao trocar de idioma. Uso: const t = useT(); t("chave"). */
export function useT(): (key: string, fallback?: string) => string {
  const locale = useI18n((s) => s.locale);
  return (key, fallback) => translate(locale, key, fallback);
}
