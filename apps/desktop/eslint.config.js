import js from '@eslint/js'
import globals from 'globals'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import tseslint from 'typescript-eslint'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // `src-tauri/target` guarda artefato do cargo — inclusive JS GERADO pelo tauri-codegen.
  // Sem ignorar, `npm run lint` varria isso e cuspia ~7.000 problemas de código que não é
  // nosso, o que tornava o gate inútil na prática: ninguém lê 7.000 linhas pra achar as 3
  // que importam. Um gate que ninguém consegue ler é um gate desligado.
  globalIgnores(['dist', 'src-tauri/target', 'scripts/.*.bundle.mjs']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      js.configs.recommended,
      tseslint.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
])
