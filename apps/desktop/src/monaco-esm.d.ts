// Declarações de tipo para os submódulos ESM do monaco-editor. O pacote só publica
// tipos no entry principal ("monaco-editor"); os caminhos ESM profundos (editor.api,
// basic-languages/*) não têm .d.ts próprio. Necessário pro tree-shake em monaco-setup.ts:
// importamos o EDITOR CORE + só os highlights, em vez do pacote inteiro (−11 MB de workers).

declare module "monaco-editor/esm/vs/editor/editor.api" {
  export * from "monaco-editor";
}

// Side-effect imports (contribuições de highlight Monarch — não exportam nada).
declare module "monaco-editor/esm/vs/basic-languages/*";
