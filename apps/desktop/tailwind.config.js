/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      // Tokens via CSS variables (canais "R G B") → tema editável em runtime pelo
      // painel Aparência. `<alpha-value>` mantém os modificadores de opacidade (bg-brand/10).
      colors: {
        bg: "rgb(var(--bg) / <alpha-value>)",
        surface1: "rgb(var(--surface1) / <alpha-value>)",
        surface2: "rgb(var(--surface2) / <alpha-value>)",
        surface3: "rgb(var(--surface3) / <alpha-value>)",
        border: "rgb(var(--border) / <alpha-value>)",
        textMuted: "rgb(var(--textMuted) / <alpha-value>)",
        text: "rgb(var(--text) / <alpha-value>)",
        brand: {
          DEFAULT: "rgb(var(--brand) / <alpha-value>)",
          hover: "rgb(var(--brand-hover) / <alpha-value>)",
        },
        danger: "rgb(var(--danger) / <alpha-value>)",
      },
      fontFamily: {
        sans: ["var(--font-sans)"],
        mono: ["var(--font-mono)"],
      },
    },
  },
  plugins: [],
};
