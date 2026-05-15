/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        bg: "rgb(10 16 20)",
        surface1: "rgb(20 21 23)",
        surface2: "rgb(28 30 34)",
        border: "rgb(46 45 50)",
        textMuted: "rgb(176 180 186)",
        text: "rgb(237 238 240)",
        brand: {
          DEFAULT: "rgb(41 162 167)",
          hover: "rgb(51 178 184)",
        },
        danger: "rgb(229 72 77)",
      },
      fontFamily: {
        sans: ["Inter", "ui-sans-serif", "system-ui", "-apple-system", "Segoe UI", "Roboto", "sans-serif"],
        mono: ["JetBrains Mono", "Fira Code", "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
