// src/lib/grab/payload.ts
//
// Design Mode "grab" — payload puro, orçado e redatado (ref RE 06 §3, §7.3).
//
// Este módulo é PURO (sem React, sem Tauri, sem efeitos): só tipos + funções de
// clamp/redação que rodam tanto NO contexto da página (guest-script) quanto no
// app (defesa em profundidade). Isso permite testar 100% via node.
//
//   ⚠️ LIMITAÇÃO FUNDAMENTAL (não é bug): o grab só lê o DOM de conteúdo
//   SAME-ORIGIN/localhost. Iframe cross-origin barra `contentDocument` pela
//   same-origin policy — segurança do browser, não contornável do parent.
//   Cross-origin → degradação clara (ver useGrabMode/PortalNode).
//
// Defesa em profundidade: a redação/clamp roda DUAS vezes — na página (antes do
// payload sair, em guest-script.ts) e DE NOVO aqui via `clampPayload()` no app,
// assumindo que o guest pode estar comprometido (ref §6.2). Budget NÃO é
// burlável: o app re-aplica `clampPayload()` em todo payload recebido.

/** Orçamento de captura — limites de tamanho do payload (espelha GRAB_BUDGET do ref §3.3). */
export const GRAB_BUDGET = {
  /** Texto visível do elemento, truncado. */
  textSnippet: 200,
  /** outerHTML recortado (caracteres). */
  htmlSnippet: 4096,
  /** CSS computado serializado (caracteres) — teto duro mesmo com muitas props. */
  computedCss: 2048,
  /** Cada entrada de nearbyText, truncada. */
  nearbyTextEntry: 200,
  /** Nº máximo de entradas em nearbyText. */
  nearbyTextEntries: 10,
  /** Nº máximo de entradas no ancestorPath. */
  ancestorPathEntries: 12,
  /** Cada entrada do ancestorPath, truncada. */
  ancestorPathEntry: 160,
  /** Seletor CSS único. */
  selector: 700,
  /** Cada valor de atributo, truncado. */
  attrValue: 300,
  /** Nº máximo de atributos retidos. */
  attrCount: 24,
} as const;

/** Allowlist de atributos retidos (resto descartado; `aria-*`/`data-*` passam à parte). */
export const GRAB_SAFE_ATTRIBUTE_NAMES: readonly string[] = [
  "id", "class", "name", "type", "role", "href", "src", "alt",
  "title", "placeholder", "for", "action", "method", "value", "disabled",
  "checked", "selected", "rel", "target", "lang", "dir",
];

/** Estilos computados curados (~16) — o que importa pra um agente entender o look. */
export const GRAB_COMPUTED_CSS: readonly string[] = [
  "display", "position", "color", "background-color", "font-size", "font-weight",
  "font-family", "line-height", "padding", "margin", "border", "border-radius",
  "box-shadow", "width", "height", "text-align",
];

/**
 * Padrões de segredo (substring, case-insensitive) — valores/textos que casam viram
 * `[redacted]`. Padrões ESTREITOS de propósito (ref §3.4): palavras genéricas como
 * `code`/`state` casariam classes CSS normais (`source-code`, `stateful`) e
 * degradariam a extração. A intenção é pegar callbacks OAuth e valores credenciais.
 */
export const GRAB_SECRET_PATTERNS: readonly string[] = [
  "access_token", "refresh_token", "auth_token", "id_token", "bearer",
  "api_key", "apikey", "api-key", "client_secret", "client-secret",
  "oauth_state", "x-amz-", "session_id", "sessionid", "csrf",
  "secret", "password", "passwd", "private_key", "privatekey",
];

/**
 * Regex que casa um TOKEN/CHAVE embutido em texto livre (não só nomes de campo):
 *  - `Bearer <token>` / `Authorization: <token>`
 *  - chaves prefixadas comuns: sk-, pk-, ghp_, gho_, xoxb-, AKIA…, AIza…, eyJ (JWT)
 *  - strings longas hex/base64 com cara de credencial
 * Conservador: alvo são segredos óbvios, não qualquer string longa de UI.
 */
const SECRET_VALUE_REGEXES: readonly RegExp[] = [
  /\bbearer\s+[a-z0-9._\-+/=]{12,}/gi,
  /\b(?:authorization|api[-_]?key|access[-_]?token|client[-_]?secret)\s*[:=]\s*["']?[a-z0-9._\-+/=]{8,}/gi,
  /\b(?:sk|pk|rk)[-_][a-z0-9]{16,}/gi,
  /\bgh[posu]_[A-Za-z0-9]{16,}/g,
  /\bxox[baprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{20,}/g,
  /\beyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{6,}/g,
];

export interface GrabRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface GrabTarget {
  /** Nome da tag (lowercase). */
  tag: string;
  /** Seletor CSS único (best-effort: #id / nth-of-type encadeado). */
  selector: string;
  /** Atributos filtrados (allowlist + aria-/data-), valores redatados. */
  attrs: Record<string, string>;
  /** Subset de estilos computados curados. */
  computedCss: Record<string, string>;
  /** Caixa do elemento (px CSS, relativo ao viewport). */
  rect: GrabRect;
  /** Role/accessible-name de acessibilidade (best-effort). */
  role: string;
}

export interface GrabPayload {
  /** Contexto da página. */
  page: { url: string; title: string };
  /** O elemento alvo. */
  target: GrabTarget;
  /** outerHTML recortado e redatado, ≤ GRAB_BUDGET.htmlSnippet. */
  outerHtml: string;
  /** Texto dos irmãos/vizinhos (cada entrada já clampada). */
  nearbyText: string[];
  /** Caminho de ancestrais ['div','section[role=main]',...]. */
  ancestorPath: string[];
}

/** Colapsa whitespace e trunca em `max`. */
export function clamp(s: string, max: number): string {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max) + "…" : t;
}

/**
 * Mascara segredos numa string ANTES de sair da página (e de novo no app).
 *  - aplica os SECRET_VALUE_REGEXES (tokens/chaves em texto livre)
 * Retorna a string com os trechos sensíveis trocados por `[redacted]`.
 */
export function redactText(input: string): string {
  let out = input ?? "";
  for (const re of SECRET_VALUE_REGEXES) {
    out = out.replace(re, "[redacted]");
  }
  return out;
}

/** True se a CHAVE de um campo/atributo indica conteúdo secreto (substring, case-insensitive). */
export function isSecretKey(key: string): boolean {
  const k = (key ?? "").toLowerCase();
  return GRAB_SECRET_PATTERNS.some((p) => k.includes(p));
}

/**
 * Redige conteúdo sensível num bloco de HTML (outerHTML):
 *  - value de input[type=password] → SEMPRE [redacted]
 *  - value de qualquer input/textarea → [redacted] (pode conter PII/segredo digitado)
 *  - atributos cuja CHAVE casa GRAB_SECRET_PATTERNS → [redacted]
 *  - tokens/chaves embutidos em texto livre → [redacted] (via redactText)
 * Defesa: roda na página E no app.
 */
export function redactHtml(html: string): string {
  let out = html ?? "";
  // 1) input[type=password] — value sempre mascarado (mesmo sem aspas correspondentes).
  out = out.replace(/<input\b[^>]*\btype\s*=\s*("?)password\1[^>]*>/gi, (tag) =>
    tag.replace(/\bvalue\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, 'value="[redacted]"'),
  );
  // 2) qualquer input/textarea com value preenchido → mascara o value.
  out = out.replace(/(<(?:input|textarea)\b[^>]*\bvalue\s*=\s*)("[^"]*"|'[^']*'|[^\s>]+)/gi, '$1"[redacted]"');
  // 2b) CONTEÚDO interno de <textarea> (nó de texto, não atributo) cujo name/id/placeholder
  // indica segredo → mascara (senha/PII digitada não casaria o regex de token). [GLM-audit]
  out = out.replace(/<textarea\b([^>]*)>([\s\S]*?)<\/textarea>/gi, (m, attrs: string) =>
    /\b(?:name|id|placeholder)\s*=\s*["']?[^"'>]*(?:password|passwd|secret|token|api[-_]?key)/i.test(attrs)
      ? `<textarea${attrs}>[redacted]</textarea>`
      : m,
  );
  // 3) atributos cuja chave é secreta → mascara o valor.
  out = out.replace(/([a-z][\w:-]*)\s*=\s*("[^"]*"|'[^']*')/gi, (m, name: string) =>
    isSecretKey(name) ? `${name}="[redacted]"` : m,
  );
  // 4) tokens/chaves soltos no texto.
  out = redactText(out);
  return out;
}

/** Redige um mapa de atributos (chave secreta OU valor com cara de token). */
export function redactAttrs(attrs: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(attrs)) {
    if (isSecretKey(k)) {
      out[k] = "[redacted]";
    } else {
      out[k] = redactText(String(v ?? ""));
    }
  }
  return out;
}

/**
 * Re-clampa E re-redata um payload no lado do app (defesa em profundidade, ref §6.2).
 * Assume estrutura possivelmente hostil: valida cada campo, trunca contra GRAB_BUDGET,
 * re-aplica redação de segredos. O budget aqui é a rede de segurança final — não
 * confiamos que o guest tenha respeitado os limites.
 */
export function clampPayload(raw: unknown): GrabPayload {
  const r = (raw ?? {}) as Partial<GrabPayload>;
  const page = (r.page ?? {}) as Partial<GrabPayload["page"]>;
  const target = (r.target ?? {}) as Partial<GrabTarget>;

  // attrs: allowlist NÃO é re-aplicada aqui (o guest já filtrou; aria-/data- variam),
  // mas TODO valor é re-redatado e clampado, e o nº de entradas é limitado.
  const rawAttrs = (target.attrs ?? {}) as Record<string, unknown>;
  const attrs: Record<string, string> = {};
  let attrN = 0;
  for (const [k, v] of Object.entries(rawAttrs)) {
    if (attrN >= GRAB_BUDGET.attrCount) break;
    const key = String(k);
    const val = isSecretKey(key) ? "[redacted]" : clamp(redactText(String(v ?? "")), GRAB_BUDGET.attrValue);
    attrs[key] = val;
    attrN++;
  }

  const rawCss = (target.computedCss ?? {}) as Record<string, unknown>;
  const computedCss: Record<string, string> = {};
  let cssLen = 0;
  for (const [k, v] of Object.entries(rawCss)) {
    const entry = `${k}:${String(v ?? "")}`;
    if (cssLen + entry.length > GRAB_BUDGET.computedCss) break;
    cssLen += entry.length;
    computedCss[String(k)] = clamp(String(v ?? ""), 200);
  }

  const rect0 = (target.rect ?? {}) as Partial<GrabRect>;
  const rect: GrabRect = {
    x: numOr0(rect0.x),
    y: numOr0(rect0.y),
    width: numOr0(rect0.width),
    height: numOr0(rect0.height),
  };

  const nearbyText = (Array.isArray(r.nearbyText) ? r.nearbyText : [])
    .slice(0, GRAB_BUDGET.nearbyTextEntries)
    .map((s) => clamp(redactText(String(s ?? "")), GRAB_BUDGET.nearbyTextEntry))
    .filter((s) => s.length > 0);

  const ancestorPath = (Array.isArray(r.ancestorPath) ? r.ancestorPath : [])
    .slice(0, GRAB_BUDGET.ancestorPathEntries)
    .map((s) => clamp(String(s ?? ""), GRAB_BUDGET.ancestorPathEntry))
    .filter((s) => s.length > 0);

  // outerHtml: redata segredos ANTES de truncar, DEPOIS corta. Truncar primeiro vazaria
  // um secret se o corte caísse no meio de uma tag (ex.: `<input type=password value="x`
  // sem o `>` → o regex de password não casa e a senha não-token escapa). [GLM-audit GRAVE]
  let outerHtml = redactHtml(String(r.outerHtml ?? ""));
  if (outerHtml.length > GRAB_BUDGET.htmlSnippet) {
    outerHtml = outerHtml.slice(0, GRAB_BUDGET.htmlSnippet) + "\n<!-- …truncado -->";
  }

  return {
    page: {
      url: clamp(String(page.url ?? ""), 600),
      title: clamp(redactText(String(page.title ?? "")), 300),
    },
    target: {
      tag: clamp(String(target.tag ?? ""), 64).toLowerCase(),
      selector: clamp(String(target.selector ?? ""), GRAB_BUDGET.selector),
      attrs,
      computedCss,
      rect,
      role: clamp(String(target.role ?? ""), 80),
    },
    outerHtml,
    nearbyText,
    ancestorPath,
  };
}

function numOr0(n: unknown): number {
  const v = typeof n === "number" ? n : Number(n);
  return Number.isFinite(v) ? Math.round(v) : 0;
}
