// src/lib/grab/guest-script.ts
//
// Runtime do grab que roda NO contexto da página-alvo (ref RE 06 §4.2).
//
// MECANISMO DE INJEÇÃO (decidido pela investigação do PortalNode):
//   O PortalNode renderiza `<iframe src={url} sandbox="… allow-same-origin …">`.
//   Quando a URL é localhost/same-origin com o webview Tauri, o parent ACESSA
//   `iframe.contentDocument`/`contentWindow` direto (same-origin policy permite).
//   Logo NÃO precisamos serializar este código pra `evaluate_script`: anexamos
//   listeners e desenhamos o overlay direto no documento do iframe a partir do
//   parent. Isso é o port "integral" do grab JS-puro do ref, sem CDP.
//
//   Cross-origin (qualquer site externo): `contentDocument` joga SecurityError →
//   `armGrab` devolve null → o hook degrada com mensagem clara ("grab indisponível
//   nesta origem"). Não há postMessage fallback porque a página externa não coopera
//   (não controlamos o conteúdo dela) — degradação é a resposta honesta (§7.1).
//
// Toda extração passa pela redação/clamp de payload.ts ANTES de devolver o payload
// (1ª camada da defesa em profundidade; o app re-aplica via clampPayload).

import {
  GRAB_BUDGET,
  GRAB_COMPUTED_CSS,
  GRAB_SAFE_ATTRIBUTE_NAMES,
  clamp,
  clampPayload,
  redactAttrs,
  redactHtml,
  redactText,
  type GrabPayload,
} from "./payload";

const HIGHLIGHT_ID = "__omnirift-grab-highlight";

/** Seletor CSS único best-effort (resolve 1 elemento; não garante o menor). */
function uniqueSelector(el: Element): string {
  const esc = (s: string) => (typeof CSS !== "undefined" && CSS.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, "_"));
  const doc = el.ownerDocument;
  if (el.id && doc.querySelectorAll(`#${esc(el.id)}`).length === 1) return `#${esc(el.id)}`;
  const parts: string[] = [];
  let cur: Element | null = el;
  while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== "html") {
    const node: Element = cur;
    const tag = node.tagName.toLowerCase();
    if (node.id && doc.querySelectorAll(`#${esc(node.id)}`).length === 1) {
      parts.unshift(`#${esc(node.id)}`);
      break;
    }
    const parent: Element | null = node.parentElement;
    if (parent) {
      const sameTag = Array.from(parent.children).filter((c) => c.tagName === node.tagName);
      if (sameTag.length > 1) parts.unshift(`${tag}:nth-of-type(${sameTag.indexOf(node) + 1})`);
      else parts.unshift(tag);
    } else {
      parts.unshift(tag);
    }
    cur = parent;
  }
  return clamp(parts.join(" > "), GRAB_BUDGET.selector);
}

/** Atributos filtrados (allowlist + aria-/data-), valores redatados. */
function extractAttrs(el: Element): Record<string, string> {
  const raw: Record<string, string> = {};
  let n = 0;
  for (const attr of Array.from(el.attributes)) {
    if (n >= GRAB_BUDGET.attrCount) break;
    const name = attr.name.toLowerCase();
    const keep = GRAB_SAFE_ATTRIBUTE_NAMES.includes(name) || name.startsWith("aria-") || name.startsWith("data-");
    if (!keep) continue;
    raw[name] = clamp(attr.value, GRAB_BUDGET.attrValue);
    n++;
  }
  return redactAttrs(raw); // máscara segredos por chave + valor.
}

/** Subset de estilos computados curados. */
function extractComputedCss(el: Element, win: Window): Record<string, string> {
  const cs = win.getComputedStyle(el);
  const out: Record<string, string> = {};
  for (const prop of GRAB_COMPUTED_CSS) {
    const v = cs.getPropertyValue(prop);
    if (v) out[prop] = v.trim();
  }
  return out;
}

/** Role/accessible-name best-effort. */
function extractRole(el: Element): string {
  const role = el.getAttribute("role") ?? "";
  const name = el.getAttribute("aria-label") ?? "";
  if (role && name) return `${role}: ${name}`;
  return role || name || "";
}

/** Texto dos irmãos imediatos (contexto sem despejar a árvore). */
function extractNearbyText(el: Element): string[] {
  const sibs = el.parentElement ? Array.from(el.parentElement.children).filter((c) => c !== el) : [];
  return sibs
    .map((s) => redactText((s as HTMLElement).innerText ?? s.textContent ?? ""))
    .map((s) => clamp(s, GRAB_BUDGET.nearbyTextEntry))
    .filter((s) => s.length > 0)
    .slice(0, GRAB_BUDGET.nearbyTextEntries);
}

/** Caminho de ancestrais ['section[role=main]', 'div.foo', ...]. */
function extractAncestorPath(el: Element): string[] {
  const path: string[] = [];
  let cur: Element | null = el.parentElement;
  while (cur && cur.tagName.toLowerCase() !== "html" && path.length < GRAB_BUDGET.ancestorPathEntries) {
    const tag = cur.tagName.toLowerCase();
    const role = cur.getAttribute("role");
    const cls = cur.classList.length ? `.${Array.from(cur.classList).slice(0, 2).join(".")}` : "";
    path.push(clamp(role ? `${tag}[role=${role}]` : `${tag}${cls}`, GRAB_BUDGET.ancestorPathEntry));
    cur = cur.parentElement;
  }
  return path;
}

/**
 * Extrai o GrabPayload de um elemento. Redige+clampa NA PÁGINA (1ª camada).
 * Exportado pra teste direto (puro o suficiente: depende só de DOM/win passados).
 */
export function extractPayload(el: Element, win: Window): GrabPayload {
  const doc = el.ownerDocument;
  const url = (() => { try { return doc.location.href; } catch { return ""; } })();
  const title = (() => { try { return doc.title; } catch { return ""; } })();
  const r = el.getBoundingClientRect();

  // outerHTML redatado (input password/value, atributos secretos, tokens em texto).
  let html = el.outerHTML ?? "";
  if (html.length > GRAB_BUDGET.htmlSnippet) html = html.slice(0, GRAB_BUDGET.htmlSnippet) + "\n<!-- …truncado -->";
  html = redactHtml(html);

  const payload: GrabPayload = {
    page: { url, title: redactText(title) },
    target: {
      tag: el.tagName.toLowerCase(),
      selector: uniqueSelector(el),
      attrs: extractAttrs(el),
      computedCss: extractComputedCss(el, win),
      rect: { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height) },
      role: extractRole(el),
    },
    outerHtml: html,
    nearbyText: extractNearbyText(el),
    ancestorPath: extractAncestorPath(el),
  };
  // 1ª passada de clamp na página (o app re-aplica = defesa em profundidade).
  return clampPayload(payload);
}

/** Handle do modo de grab armado. */
export interface GrabGuestHandle {
  teardown: () => void;
}

/**
 * Arma o grab no documento do iframe (same-origin): instala overlay de realce no
 * hover e captura no click. Devolve um handle pra teardown, ou `null` se o doc é
 * inacessível (cross-origin) — caller degrada.
 *
 * @param iframe  o <iframe> do portal
 * @param onPick  chamado UMA vez com o payload extraído no click
 * @param onCancel chamado se o usuário cancelar (Esc)
 */
export function armGrab(
  iframe: HTMLIFrameElement,
  onPick: (p: GrabPayload) => void,
  onCancel?: () => void,
): GrabGuestHandle | null {
  let d: Document;
  try {
    const doc = iframe.contentDocument; // joga/retorna null em cross-origin.
    if (!doc || !doc.body) return null;
    void doc.location.href; // toca o location: SecurityError em cross-origin.
    d = doc;
  } catch {
    return null; // cross-origin → sem acesso ao DOM.
  }
  const win = d.defaultView ?? window;

  // Limpa qualquer overlay pré-existente (defesa contra página que predefine fake).
  d.getElementById(HIGHLIGHT_ID)?.remove();

  const hl = d.createElement("div");
  hl.id = HIGHLIGHT_ID;
  Object.assign(hl.style, {
    position: "fixed",
    pointerEvents: "none",
    zIndex: "2147483647",
    border: "2px solid rgb(41 162 167)",
    background: "rgba(41,162,167,0.12)",
    borderRadius: "2px",
    transition: "all 40ms linear",
    boxSizing: "border-box",
    display: "none",
  } as Partial<CSSStyleDeclaration>);
  d.body.appendChild(hl);

  let current: Element | null = null;
  let settled = false;

  const onMove = (e: MouseEvent) => {
    const el = e.target as Element | null;
    if (!el || el === hl) return;
    current = el;
    const r = el.getBoundingClientRect();
    Object.assign(hl.style, {
      left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px`, display: "block",
    });
  };

  const onClick = (e: MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if ("stopImmediatePropagation" in e) e.stopImmediatePropagation();
    if (settled) return;
    const el = (e.target as Element) ?? current;
    if (el && el !== hl) {
      settled = true;
      try { onPick(extractPayload(el, win)); } finally { handle.teardown(); }
    }
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape" && !settled) {
      settled = true;
      handle.teardown();
      onCancel?.();
    }
  };

  // capture:true → intercepta antes do app guest e impede navegação/ação no click.
  win.addEventListener("mousemove", onMove, true);
  win.addEventListener("click", onClick, true);
  win.addEventListener("keydown", onKey, true);
  const prevCursor = d.body.style.cursor;
  d.body.style.cursor = "crosshair";

  const handle: GrabGuestHandle = {
    teardown() {
      try {
        win.removeEventListener("mousemove", onMove, true);
        win.removeEventListener("click", onClick, true);
        win.removeEventListener("keydown", onKey, true);
        d.body.style.cursor = prevCursor;
        hl.remove();
      } catch { /* doc pode ter recarregado/sumido */ }
    },
  };
  return handle;
}
