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

export type Translator = (key: string, fallback?: string) => string;

// Cache por locale: a MESMA referência enquanto o idioma não muda. Sem isto,
// `useT()` devolvia closure nova a cada render → qualquer `useCallback(..., [t])`
// + `useEffect([cb])` re-disparava IPC em loop (FileTree `list_dir` no Windows).
const TRANSLATORS: Record<Locale, Translator> = {
  pt: (key, fallback) => translate("pt", key, fallback),
  en: (key, fallback) => translate("en", key, fallback),
};

/** Tradutor estável pra um locale (mesma ref entre chamadas). */
export function makeTranslator(locale: Locale): Translator {
  return TRANSLATORS[locale];
}

/** Hook que re-renderiza ao trocar de idioma. Uso: const t = useT(); t("chave"). */
export function useT(): Translator {
  const locale = useI18n((s) => s.locale);
  return makeTranslator(locale);
}
