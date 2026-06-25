// src/lib/grab/format.ts
//
// Serializa um GrabPayload como markdown pronto pro prompt do agente / clipboard.
//
//   ⚠️ XSS-SAFE: este markdown é TEXTO. Nunca é injetado via innerHTML em lugar
//   nenhum. Ainda assim, escapamos `<`, `>` e backtick (`) ANTES de interpolar:
//   (a) o HTML capturado vai dentro de um fence ```html e um backtick solto pode
//   quebrar o fence/escapar; (b) defesa em profundidade caso o destino renderize
//   markdown→HTML. NUNCA construímos DOM com este texto.
//
// Módulo PURO (sem React/Tauri/DOM) → testável 100% via node.

import type { GrabPayload } from "./payload";

/**
 * Escapa o que poderia escapar de um contexto de texto/markdown:
 *  - `<` e `>` → entidades (impede que um renderer markdown→HTML interprete como tag)
 *  - backtick → escapado com `\`` (impede quebra de inline-code / fence)
 * NÃO desfaz redação; opera sobre texto já redatado.
 */
export function escapeForMarkdown(s: string): string {
  return (s ?? "")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/`/g, "\\`");
}

/** Neutraliza backticks no corpo de um fence (impede fechar/escapar do bloco). */
function escapeFenceBody(s: string): string {
  return (s ?? "").replace(/`/g, "\\`");
}

/**
 * Constrói o markdown do payload. Tudo passa por escape; o HTML vai num fence cujo
 * corpo tem backticks neutralizados. Sem innerHTML em nenhum ponto.
 */
export function formatGrabAsMarkdown(p: GrabPayload): string {
  const t = p.target;
  const styleLines = Object.entries(t.computedCss)
    .map(([k, v]) => `- \`${escapeForMarkdown(k)}\`: ${escapeForMarkdown(v)}`)
    .join("\n");
  const attrLines = Object.entries(t.attrs)
    .map(([k, v]) => `- \`${escapeForMarkdown(k)}\`: ${escapeForMarkdown(v)}`)
    .join("\n");
  const nearby = p.nearbyText.map((s) => escapeForMarkdown(s)).join(" · ");
  const ancestors = p.ancestorPath.map((s) => escapeForMarkdown(s)).join(" > ");

  const lines: string[] = [
    // O `<tag>` é exibido com os colchetes JÁ escapados (&lt;/&gt;) — fora de fence,
    // nenhum `<`/`>` cru pode sair (defesa contra markdown→HTML no destino).
    `## Elemento capturado — \`${escapeForMarkdown(`<${t.tag}>`)}\``,
    "",
    `**URL:** ${escapeForMarkdown(p.page.url)}`,
    p.page.title ? `**Título:** ${escapeForMarkdown(p.page.title)}` : "",
    `**Seletor:** \`${escapeForMarkdown(t.selector)}\``,
    t.role ? `**Role/a11y:** ${escapeForMarkdown(t.role)}` : "",
    `**Caixa:** ${t.rect.width}×${t.rect.height} px @ (${t.rect.x}, ${t.rect.y})`,
    "",
    "**Atributos:**",
    attrLines || "_(nenhum)_",
    "",
    "**Estilos computados:**",
    styleLines || "_(nenhum)_",
    "",
    nearby ? `**Texto vizinho:** ${nearby}` : "",
    ancestors ? `**Caminho de ancestrais:** ${ancestors}` : "",
  ];

  if (p.outerHtml && p.outerHtml.length > 0) {
    lines.push("", "**HTML:**", "```html", escapeFenceBody(p.outerHtml), "```");
  }

  return lines.filter((l) => l !== "").join("\n");
}
