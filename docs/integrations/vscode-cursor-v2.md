# Rodar dentro do VS Code / Cursor — decisão V2

> 2026-06-16 · **adiado pra v2** (estudo + recomendação)

## Pergunta

Dá pra rodar o OmniRift **dentro** do VS Code ou Cursor, depois de instalado na máquina do cliente?

## Resposta honesta

**O app atual (Tauri) NÃO roda "dentro" do VS Code/Cursor.** É uma janela nativa própria
(processo + backend Rust); o VS Code só renderiza as próprias webviews/painéis — não embute
a janela de outro app. (Cursor = fork do VS Code → mesma regra; extensões funcionam igual.)

- **Dá fácil:** uma extensão que **lança** o OmniRift (abre como janela ao lado, não embutido).
- **Embutir de verdade = outro produto** (rewrite), dois caminhos:

| Caminho | Envolve | Peso |
|---|---|---|
| **A) Extensão nativa** | Frontend React numa Webview do VS Code + backend Rust **reescrito em Node** (PTY/MCP/agentes/floors no extension host) | Pesado (reescreve o backend) |
| **B) Backend vira daemon** | Backend Rust roda headless (já sobe o MCP na :7844); frontend fala por HTTP/WS; Webview do VS Code hospeda o frontend | Médio (abstrair o transporte IPC→HTTP; sem reescrever Rust) ⭐ |

## Recomendação (pra v2)

90% do valor vem de: **app standalone** (`.AppImage`/`.deb`/`.msi`) rodando **ao lado** do
VS Code/Cursor **+ extensão leve** (lança o app + integra abrir-arquivo nos dois sentidos — o
"abrir no editor" já existe). Embedding real (caminho **B**) só se o cliente exigir **uma janela só**.

**A pergunta que decide:** é requisito *tudo numa janela do VS Code*, ou *rodar junto e integrado* basta?

## Refs
- Backend já expõe MCP server em `127.0.0.1:7844` (`apps/desktop/src-tauri/src/mcp/server.rs`) → base do caminho B
- "Abrir no editor" (17 editores) já existe: `commands/editor.rs` + `components/EditorOpenButton.tsx`
