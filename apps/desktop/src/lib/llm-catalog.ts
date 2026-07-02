// src/lib/llm-catalog.ts
//
// Catálogo dos providers de LLM CADASTRÁVEIS na Central de API — usado por telas que
// querem oferecer "cadastre este provider" quando ainda não há chave salva (ex.: o
// dropdown do Arquiteto de Pipeline). Duplicação CONSCIENTE dos KIND_PRESETS do
// ProvidersCentralModal.tsx (fonte da verdade dos kinds): o modal é lazy e importar
// dele puxaria o componente inteiro pra fora do lazy-load. Mudou lá → espelhe aqui.

export const LLM_CATALOG: { kind: string; label: string }[] = [
  { kind: "ollama-cloud", label: "Ollama Cloud" },
  { kind: "openrouter", label: "OpenRouter" },
  { kind: "openai", label: "OpenAI" },
  { kind: "anthropic", label: "Anthropic" },
  { kind: "groq", label: "Groq" },
  { kind: "gemini", label: "Google Gemini" },
];
