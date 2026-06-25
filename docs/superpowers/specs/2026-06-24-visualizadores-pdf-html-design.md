# Visualizadores PDF + HTML no canvas — Design

> Status: **active** · 2026-06-24. Pedido do Jesse: ver PDF dentro do app + ver apresentações HTML
> (reveal.js etc.) que o pessoal faz. Ambos **fogem da dor da Fase 5** (não são web cross-origin).

**Goal:** dois novos node-types no canvas — **PdfNode** e **HtmlNode** — que abrem arquivos locais,
redimensionáveis como os outros nodes. **Frontend-only** (sem comando Rust novo → não toca `lib.rs`,
evita conflito com outros itens do batch).

## PdfNode — via pdf.js (canvas, não iframe → WebKitGTK-safe)
- Dep: `pdfjs-dist` (npm). Worker via `?url` do Vite (`pdfjs-dist/build/pdf.worker.min.mjs`).
- Lê os bytes com `@tauri-apps/plugin-fs` `readFile(path) -> Uint8Array` → `getDocument({data})`.
- Render página→`<canvas>`. Controles: página ‹ N/total ›, zoom −/+ (scale). Scroll vertical entre páginas
  (lazy render da visível). `nowheel` no container (scroll rola o PDF, não o canvas — igual aos outros nodes).
- Estados: carregando / erro (arquivo inválido) / N páginas.
- Arquivo: `src/components/nodes/PdfNode.tsx` (lazy, code-split, como o SketchNode).

## HtmlNode — via asset protocol (iframe local, não remoto)
- Habilitar **assetProtocol** em `src-tauri/tauri.conf.json` (`app.security.assetProtocol = { enable: true,
  scope: ["**"] }` — escopo amplo p/ abrir qualquer arquivo escolhido pelo usuário; nota: o picker é o gate).
- `convertFileSrc(path)` (`@tauri-apps/api/core`) → `<iframe src=...>` → JS/CSS/assets relativos da
  apresentação funcionam (mesma origem asset). `sandbox` permissivo p/ apresentações (allow-scripts).
- Arquivo: `src/components/nodes/HtmlNode.tsx`. `nowheel` no iframe wrapper.

## Wiring (comum aos dois)
- `src/types/canvas.ts`: novos tipos `PdfNode`/`HtmlNode` (id, kind, filePath, size, position).
- `src/components/FloorCanvas.tsx`: registrar em `nodeTypes` (`pdf`, `html`) + cor no minimap.
- `src/store/canvas-store.ts`: helpers `addPdfNode(path)`/`addHtmlNode(path)` (tamanho default ~560×720 PDF,
  720×460 HTML).
- **Abrir**: (a) **FileTree duplo-clique** em `.pdf`→PdfNode, `.html`→HtmlNode (hoje o `.html` faz "preview" —
  redirecionar pro HtmlNode); (b) botão na toolbar/seção de ferramentas (file picker `@tauri-apps/plugin-dialog`).

## Decisões
1. PDF = pdf.js em `<canvas>` (sem iframe, sem dor de WebKitGTK). 2. HTML = asset protocol + iframe (local,
não cross-origin). 3. Frontend-only (sem Rust → sem conflito de `lib.rs` no batch). 4. `nowheel` nos dois.
5. Escopo amplo no assetProtocol (o file-picker é o controle de acesso). 6. PDF MVP = ver/zoom/páginas
(busca de texto / "enviar trecho pro agente" = fase 2, não agora).

## Testing
- tsc 0. Boot-safe (nodes sob demanda). Validação visual real fica pro boot-test do build final do batch
  (abrir um .pdf e um .html de apresentação no canvas).
- Edge: arquivo inexistente/corrompido → estado de erro no node (não crash).
