// src/lib/portal-grab.ts
//
// "Grab" de elemento do Design Mode (P1 #9 do teardown do ref, §3.5).
//
// O grab do ref é JavaScript puro — portável pro nosso portal (iframe in-DOM).
// A DIFERENÇA crucial vs. ref: ele embute abas cross-origin reais (Electron +
// Chromium sandbox), nós embutimos um iframe. Por isso:
//
//   ⚠️ LIMITAÇÃO FUNDAMENTAL (não é bug a corrigir):
//   Só conseguimos ler o DOM de conteúdo SAME-ORIGIN / localhost. Um iframe
//   cross-origin barra `iframe.contentDocument` pela same-origin policy do
//   navegador — é segurança do browser, não dá pra contornar a partir do parent.
//   Coerente com o escopo do portal (preview de dev server localhost). Para
//   esses casos o caller recebe `null` de `attachGrabMode` e deve avisar o user.
//
// O valor está no PAYLOAD pro agente: seletor único, estilos relevantes, ARIA,
// HTML recortado, texto vizinho — formatado em markdown. Screenshot recortado
// fica como TODO (precisaria de cálculo de retângulo + foto da viewport, inviável
// limpo dentro do iframe; ver nota em `GRAB_BUDGET.screenshot`).

/** Orçamento de captura — limites de tamanho do payload (espelha GRAB_BUDGET do ref §3.5). */
export const GRAB_BUDGET = {
  /** Texto visível do elemento, truncado. */
  textSnippet: 200,
  /** outerHTML recortado. */
  htmlSnippet: 4096,
  /** Texto dos irmãos/vizinhos somados. */
  nearbyText: 400,
  /** Stretch/TODO: recorte de screenshot. Inviável limpo no iframe (mesma origin
   *  policy + sem captura de viewport do guest sem APIs nativas). Deixado p/ Fase 7+
   *  (sidecar de Computer Use). Por ora não capturamos imagem. */
  screenshot: 0,
} as const;

/** Estilos computados "relevantes" capturados (~12) — os que importam pra um agente
 *  reconstruir/entender o look de um elemento sem despejar a folha de estilo inteira. */
const RELEVANT_STYLES = [
  "display",
  "position",
  "color",
  "background-color",
  "font-size",
  "font-weight",
  "font-family",
  "padding",
  "margin",
  "border",
  "border-radius",
  "box-shadow",
] as const;

/** Atributos ARIA / acessibilidade capturados. */
const ARIA_ATTRS = ["role", "aria-label", "aria-labelledby", "aria-describedby", "aria-hidden", "aria-expanded"] as const;

/** Payload da captura — shape espelhando o `BrowserGrabPayload` do ref (§3.5),
 *  adaptado ao que conseguimos extrair de um iframe same-origin. */
export interface GrabPayload {
  /** Seletor CSS único (best-effort: #id > nth-of-type encadeado). */
  selector: string;
  /** Nome da tag (lowercase). */
  tag: string;
  /** Texto visível, ≤ GRAB_BUDGET.textSnippet. */
  textSnippet: string;
  /** ~12 estilos computados relevantes. */
  styles: Record<string, string>;
  /** Atributos ARIA/role presentes. */
  aria: Record<string, string>;
  /** outerHTML recortado, ≤ GRAB_BUDGET.htmlSnippet. Valores de input sensível redatados. */
  htmlSnippet: string;
  /** Texto dos elementos vizinhos (irmãos), ≤ GRAB_BUDGET.nearbyText. */
  nearbyText: string;
  /** URL do documento capturado. */
  url: string;
  /** Caixa do elemento (px) — útil de contexto, não é screenshot. */
  rect: { x: number; y: number; width: number; height: number };
}

function clamp(s: string, max: number): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/** Seletor CSS único best-effort: usa #id se único; senão encadeia tag:nth-of-type
 *  subindo até o body. Não garante o "menor" seletor, garante que resolve 1 elemento. */
function uniqueSelector(el: Element): string {
  if (el.id && el.ownerDocument.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) {
    return `#${CSS.escape(el.id)}`;
  }
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== "html") {
    const node: Element = cur;
    const tag = node.tagName.toLowerCase();
    if (node.id && node.ownerDocument.querySelectorAll(`#${CSS.escape(node.id)}`).length === 1) {
      parts.unshift(`#${CSS.escape(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) {
        const idx = sameTag.indexOf(node) + 1;
        parts.unshift(`${tag}:nth-of-type(${idx})`);
      } else {
        parts.unshift(tag);
      }
    } else {
      parts.unshift(tag);
    }
    cur = parent;
  }
  return parts.join(" > ");
}

/**
 * Redige conteúdo sensível ÓBVIO antes de mandar pro agente:
 *  - valor de inputs `type=password`
 *  - valor de qualquer input/textarea (pode conter PII/segredo digitado)
 * Substitui o atributo `value=` por `value="[redacted]"` no HTML recortado.
 */
function redactSensitive(html: string): string {
  // Inputs com value preenchido: zera o valor (não sabemos o que o user digitou).
  return html
    .replace(/(<input\b[^>]*\bvalue=)("[^"]*"|'[^']*')/gi, '$1"[redacted]"')
    .replace(/(<input\b[^>]*\btype=("?)password\2[^>]*)/gi, (m) => m.replace(/value=("[^"]*"|'[^']*')/gi, 'value="[redacted]"'));
}

/** Constrói o `GrabPayload` a partir de um elemento capturado. */
export function buildPayload(el: Element, url: string): GrabPayload {
  const doc = el.ownerDocument;
  const win = doc.defaultView ?? window;
  const cs = win.getComputedStyle(el);

  const styles: Record<string, string> = {};
  for (const prop of RELEVANT_STYLES) {
    const v = cs.getPropertyValue(prop);
    if (v) styles[prop] = v.trim();
  }

  const aria: Record<string, string> = {};
  for (const a of ARIA_ATTRS) {
    const v = el.getAttribute(a);
    if (v != null) aria[a] = v;
  }

  // Texto vizinho: irmãos imediatos (contexto sem despejar a árvore toda).
  const siblings = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c !== el) : [];
  const nearbyText = clamp(siblings.map((s) => (s as HTMLElement).innerText ?? s.textContent ?? "").join(" · "), GRAB_BUDGET.nearbyText);

  // HTML recortado + redação de valores sensíveis.
  let html = el.outerHTML ?? "";
  if (html.length > GRAB_BUDGET.htmlSnippet) html = html.slice(0, GRAB_BUDGET.htmlSnippet) + "\n<!-- …truncado -->";
  html = redactSensitive(html);

  const r = el.getBoundingClientRect();

  return {
    selector: uniqueSelector(el),
    tag: el.tagName.toLowerCase(),
    textSnippet: clamp((el as HTMLElement).innerText ?? el.textContent ?? "", GRAB_BUDGET.textSnippet),
    styles,
    aria,
    htmlSnippet: html,
    nearbyText,
    url,
    rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
  };
}

/** Formata o `GrabPayload` como markdown pronto pro prompt do agente. */
export function payloadToMarkdown(p: GrabPayload): string {
  const styleLines = Object.entries(p.styles).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n");
  const ariaLines = Object.keys(p.aria).length
    ? Object.entries(p.aria).map(([k, v]) => `- \`${k}\`: ${v}`).join("\n")
    : "_(nenhum)_";
  return [
    `## Elemento capturado — \`<${p.tag}>\``,
    "",
    `**URL:** ${p.url}`,
    `**Seletor:** \`${p.selector}\``,
    `**Caixa:** ${p.rect.width}×${p.rect.height} px @ (${p.rect.x}, ${p.rect.y})`,
    "",
    p.textSnippet ? `**Texto:** ${p.textSnippet}\n` : "",
    "**Estilos computados:**",
    styleLines || "_(nenhum)_",
    "",
    "**ARIA / role:**",
    ariaLines,
    "",
    p.nearbyText ? `**Texto vizinho:** ${p.nearbyText}\n` : "",
    "**HTML:**",
    "```html",
    p.htmlSnippet,
    "```",
  ].filter((l) => l !== "").join("\n");
}

/** Handle devolvido por `attachGrabMode` para desligar o modo. */
export interface GrabHandle {
  detach: () => void;
}

/**
 * Liga o modo de captura no documento do iframe: destaca o elemento sob o mouse
 * e captura no clique. Funciona SÓ pra iframe same-origin/localhost — se o doc não
 * for acessível (cross-origin), devolve `null` e o caller deve avisar o user.
 *
 * @param iframe  o <iframe> do portal
 * @param onPick  chamado com o GrabPayload extraído no clique
 * @returns handle p/ detach, ou null se o doc é inacessível (cross-origin)
 */
export function attachGrabMode(iframe: HTMLIFrameElement, onPick: (p: GrabPayload) => void): GrabHandle | null {
  let doc: Document | null = null;
  try {
    // Acesso ao contentDocument JOGA SecurityError em cross-origin (same-origin policy).
    doc = iframe.contentDocument;
    if (!doc || !doc.body) return null;
    // Força um toque no document p/ confirmar que não é cross-origin "vazio".
    void doc.location.href;
  } catch {
    return null; // cross-origin → sem acesso ao DOM.
  }
  const d = doc;
  const win = d.defaultView ?? window;
  const url = (() => { try { return d.location.href; } catch { return iframe.src; } })();

  // Overlay de destaque — um <div> posicionado sobre o elemento sob o mouse.
  const hl = d.createElement("div");
  Object.assign(hl.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    border: "2px solid rgb(41 162 167)",
    background: "rgba(41,162,167,0.12)",
    borderRadius: "2px",
    transition: "all 40ms linear",
    boxSizing: "border-box",
  } as Partial<CSSStyleDeclaration>);
  d.body.appendChild(hl);

  let current: Element | null = null;

  const onMove = (e: MouseEvent) => {
    const el = e.target as Element | null;
    if (!el || el === hl) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, {
      left: `${r.left}px`,
      top: `${r.top}px`,
      width: `${r.width}px`,
      height: `${r.height}px`,
      display: "block",
    });
  };

  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    const el = (e.target as Element) ?? current;
    if (el && el !== hl) onPick(buildPayload(el, url));
  };

  // capture:true → pega o evento antes do app guest (e impede navegação no clique).
  win.addEventListener("mousemove", onMove, true);
  win.addEventListener("click", onClick, true);
  // Cursor de "alvo" enquanto o modo está ligado.
  const prevCursor = d.body.style.cursor;
  d.body.style.cursor = "crosshair";

  return {
    detach() {
      try {
        win.removeEventListener("mousemove", onMove, true);
        win.removeEventListener("click", onClick, true);
        d.body.style.cursor = prevCursor;
        hl.remove();
      } catch { /* doc pode ter recarregado/sumido */ }
    },
  };
}
