# Design Mode grab (RE 06) — Design do MVP

> Status: active · 2026-06-25. ref #10 (RE ref-re/06-browser-design-mode.md). Branch
> feat/terminal-backend-owned (batch ref grandes, ÚLTIMO item antes do build v0.1.35).

**Goal:** no PortalNode (iframe localhost), o usuário arma o "grab", passa o mouse sobre um elemento
(realce ao vivo), clica, e o OmniRift extrai um **payload curado-e-redatado** (HTML + CSS computado +
a11y + texto vizinho + ancestor-path + bounding rect) que vira **markdown pra colar no prompt do agente
ou no clipboard**. RE: a aba cross-origin NÃO porta (WebKitGTK) — escopo = iframe-localhost; **Computer Use
= fase 7+**; **screenshot recortado = fase 2** (capturePage de iframe é difícil no WebKitGTK). O grab é a
parte de maior valor e portável (JS puro).

## Arquitetura (frontend, TS — investigar acesso ao iframe primeiro)
1. **grab-guest** (`lib/grab/guest-script.ts`): runtime JS auto-contido com ações arm/awaitClick/
   extractHover/finalize/teardown. Roda no contexto da página-alvo: desenha overlay de realce no hover,
   captura o elemento no click, extrai o payload. SEM screenshot no MVP. Injeção: investigar o PortalNode —
   se o iframe localhost for same-origin com o webview, `iframe.contentWindow`/init-script; se cross-origin,
   protocolo **postMessage** (a página coopera) + degradação clara ("grab indisponível nesta origem").
2. **payload + budget/redação** (`lib/grab/payload.ts`, PURO + testável): tipo `GrabPayload` (page, target
   {tag, attrs filtrados, computedCss subset, rect, role/a11y}, nearbyText[], ancestorPath[]). `GRAB_BUDGET`
   (clampa tamanhos de HTML/CSS/texto). `redact()` — mascara segredos (value de input password, tokens,
   api-keys via regex) ANTES de sair da página. Defesa-em-profundidade: re-clamp/re-redact no lado do app.
3. **useGrabMode** (`hooks/useGrabMode.ts`): máquina de estado `idle→armed→awaiting→confirming→idle`(→error),
   ignora resultado stale por opId. Timeout duro 120s.
4. **PortalNode** integração: botão "🎯 grab" + atalhos; left-click → auto-copy markdown; → enviar pro agente
   (reusa o CustomEvent omnirift:turbo-seed/send existente).
5. **markdown** (`lib/grab/format.ts`, PURO + testável): `formatGrabAsMarkdown(payload)` — serializa como
   texto ESCAPADO (sem innerHTML; XSS-safe), pronto pro prompt.

## Decisões
1. Só o grab (browser cross-origin = limite WebKitGTK; Computer Use = fase 7+). 2. Screenshot = fase 2.
3. Redação de segredos na página + re-redação no app (defesa em profundidade). 4. Markdown como texto
   escapado (nunca innerHTML). 5. Injeção: descobrir o acesso real ao iframe; degradar claro se cross-origin.
6. Reusa o canal agente (turbo-seed/send) pra "enviar pro agente".

## Testing
- Vitest/TS PURO: payload budget clampa HTML/CSS/texto gigante; redact mascara password/token/api-key;
  formatGrabAsMarkdown escapa `<`/`>`/backtick (XSS-safe) + inclui tag/attrs/nearbyText/ancestorPath;
  máquina de estado do useGrabMode (idle→armed→awaiting→confirming, stale opId ignorado). tsc 0.
- Boot-test final (#10 = este): armar grab num PortalNode localhost, hover realça, click extrai, markdown
  no clipboard. (Se cross-origin bloquear, a degradação aparece — documentar.)
- GLM 5.2 audita o diff (foco: redação de segredos completa, XSS no markdown, budget burlável, postMessage
  origin-check).
