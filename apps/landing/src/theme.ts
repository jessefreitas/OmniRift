// Accent palette carried over from the source design. All four accents share the
// same tuning for the dark background; swap ACCENT to re-theme the whole site.
export const ACCENTS = {
  Verde: "#6EE7A8",
  Âmbar: "#F6C667",
  Violeta: "#B49BFF",
  Azul: "#79B4FF",
} as const;

export type AccentName = keyof typeof ACCENTS;

// OmniRift's product identity leans teal/green, so "Verde" is the default accent
// (closest to the in-app brand). Set to "Âmbar" | "Violeta" | "Azul" to re-skin.
export const ACCENT_NAME: AccentName = "Verde";
export const ACCENT = ACCENTS[ACCENT_NAME];

export const PRODUCT_NAME = "OmniRift";
export const TAGLINE =
  "Terminais, notas e navegadores convivem num espaço infinito. Conecte agentes, delegue tarefas e acompanhe tudo de um lugar só.";

// Repository / download targets. Adjust to the real release URLs when shipping.
export const REPO_URL = "https://git.omnimemory.com.br/jesse_freitas/maestri_linux";
