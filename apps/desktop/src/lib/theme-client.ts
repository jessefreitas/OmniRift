// src/lib/theme-client.ts
//
// Tema do OmniRift: tokens (canais "R G B") + fontes, aplicados em runtime nas
// CSS variables do :root. Persiste em localStorage e roda no boot (main.tsx).

export type ThemeMode = "dark" | "light";

export interface Theme {
  mode: ThemeMode;
  /** token → "R G B" (canais, sem rgb()). */
  colors: Record<string, string>;
  fontSans: string;
  fontMono: string;
}

export const TOKENS: { key: string; label: string }[] = [
  { key: "bg", label: "Fundo" },
  { key: "surface1", label: "Superfície 1" },
  { key: "surface2", label: "Superfície 2" },
  { key: "surface3", label: "Superfície 3" },
  { key: "border", label: "Borda" },
  { key: "text", label: "Texto" },
  { key: "textMuted", label: "Texto suave" },
  { key: "brand", label: "Destaque" },
  { key: "brand-hover", label: "Destaque (hover)" },
  { key: "danger", label: "Perigo" },
];

const DARK: Record<string, string> = {
  bg: "10 16 20", surface1: "20 21 23", surface2: "28 30 34", surface3: "36 38 43",
  border: "46 45 50", textMuted: "176 180 186", text: "237 238 240",
  brand: "41 162 167", "brand-hover": "51 178 184", danger: "229 72 77",
};
const LIGHT: Record<string, string> = {
  bg: "247 248 250", surface1: "255 255 255", surface2: "241 243 245", surface3: "233 236 239",
  // textMuted escurecido (de #646c76 p/ #475569) → rótulos legíveis no fundo claro.
  border: "209 214 220", textMuted: "71 85 105", text: "17 22 28",
  brand: "23 140 145", "brand-hover": "18 120 125", danger: "200 50 55",
};

export const FONT_SANS: Record<string, string> = {
  Inter: '"Inter", ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  Sistema: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
  Serifada: 'ui-serif, Georgia, "Times New Roman", serif',
};
export const FONT_MONO: Record<string, string> = {
  "JetBrains Mono": '"JetBrains Mono", "Fira Code", ui-monospace, monospace',
  "Fira Code": '"Fira Code", ui-monospace, monospace',
  Sistema: 'ui-monospace, SFMono-Regular, Menlo, monospace',
};

export const ACCENTS: { name: string; brand: string; hover: string }[] = [
  { name: "Teal", brand: "41 162 167", hover: "51 178 184" },
  { name: "Azul", brand: "59 130 246", hover: "79 150 255" },
  { name: "Roxo", brand: "139 92 246", hover: "159 112 255" },
  { name: "Verde", brand: "34 197 94", hover: "54 217 114" },
  { name: "Âmbar", brand: "245 158 11", hover: "255 178 31" },
  { name: "Rosa", brand: "236 72 153", hover: "255 92 173" },
];

export function defaultTheme(mode: ThemeMode): Theme {
  return {
    mode,
    colors: { ...(mode === "light" ? LIGHT : DARK) },
    fontSans: FONT_SANS.Inter,
    fontMono: FONT_MONO["JetBrains Mono"],
  };
}

export const PRESETS: { name: string; theme: Theme }[] = [
  { name: "OmniRift Escuro", theme: defaultTheme("dark") },
  { name: "OmniRift Claro", theme: defaultTheme("light") },
  {
    name: "Meia-noite",
    theme: {
      mode: "dark",
      colors: { ...DARK, bg: "8 10 18", surface1: "15 17 28", surface2: "22 25 38", surface3: "30 34 50", brand: "99 102 241", "brand-hover": "119 122 255" },
      fontSans: FONT_SANS.Inter, fontMono: FONT_MONO["JetBrains Mono"],
    },
  },
  {
    name: "Floresta",
    theme: { mode: "dark", colors: { ...DARK, brand: "34 197 94", "brand-hover": "54 217 114" }, fontSans: FONT_SANS.Inter, fontMono: FONT_MONO["JetBrains Mono"] },
  },
];

const KEY = "omnirift-theme";

export function loadTheme(): Theme {
  try {
    const s = localStorage.getItem(KEY);
    if (s) {
      const t = JSON.parse(s) as Partial<Theme>;
      const base = defaultTheme(t.mode === "light" ? "light" : "dark");
      return { ...base, ...t, colors: { ...base.colors, ...(t.colors ?? {}) } };
    }
  } catch { /* localStorage off / json inválido */ }
  return defaultTheme("dark");
}

export function saveTheme(t: Theme): void {
  try { localStorage.setItem(KEY, JSON.stringify(t)); } catch { /* off */ }
}

/** Aplica o tema nas CSS variables do :root (cores + fontes + color-scheme). */
export function applyTheme(t: Theme): void {
  const r = document.documentElement;
  for (const { key } of TOKENS) {
    if (t.colors[key]) r.style.setProperty(`--${key}`, t.colors[key]);
  }
  r.style.setProperty("--font-sans", t.fontSans);
  r.style.setProperty("--font-mono", t.fontMono);
  r.style.colorScheme = t.mode;
}

// "R G B" ↔ #rrggbb (pros <input type=color> do editor).
export function channelsToHex(ch: string): string {
  const [r, g, b] = ch.trim().split(/\s+/).map((n) => Math.max(0, Math.min(255, parseInt(n, 10) || 0)));
  return "#" + [r, g, b].map((n) => n.toString(16).padStart(2, "0")).join("");
}
export function hexToChannels(hex: string): string {
  const h = hex.replace("#", "");
  const r = parseInt(h.slice(0, 2), 16) || 0;
  const g = parseInt(h.slice(2, 4), 16) || 0;
  const b = parseInt(h.slice(4, 6), 16) || 0;
  return `${r} ${g} ${b}`;
}
