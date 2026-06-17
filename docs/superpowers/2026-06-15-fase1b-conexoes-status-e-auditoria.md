# Fase 1b (Área de Conexões) + auditoria da Fase 1a — status

- **Data:** 2026-06-15
- **Branch:** `feat/memory-provider-fase1` (não pushada)
- **Contexto:** duas sessões CC trabalharam em paralelo. A sessão "cérebro" entregou a Fase 1a
  (backend `MemoryProvider`); a sessão "Maestri" (frontend) entregou a Fase 1b (UI) + features
  do canvas. Tudo no mesmo branch.

## O que ficou pronto (end-to-end funcional)

A camada de memória plugável está **usável ponta a ponta**:

1. **UI Área de Conexões** (`ConnectionsModal` + `providers-client.ts`) — abre pelo menu
   `⋯ Ferramentas → Conexões de memória` ou `Ctrl+K`. Add/testar/alternar Local · OmniMemory ·
   Obsidian(soon). O "Usar" (ativar) é **independente** do "Testar" (health), então o provider
   funciona mesmo se o health falhar.
2. **`agent_mcp_config`** (mcp.rs) faz **merge da `agent_wiring()` do provider ativo** no
   `agent-mcp.json` de cada agente claude → OmniMemory ativo = agentes nascem plugados (http+Bearer).
   Local = wiring vazia (zero regressão).
3. **tools MCP `memory_*`** roteiam pelo provider ativo (`registry.active_provider()`).
4. **DEV_CONTRACT** (worker claude) manda `memory_recall` antes de codar → roteia pro provider ativo.

## Auditoria da Fase 1a (revisão do Claude/cérebro)

**Veredito: sólida.** Arquitetura limpa, testes reais, código defensivo, e a minha camada
(`agent_memory` + tools `memory_*`) foi preservada como o **provider `Local`** (zero regressão).

### Pontos a revisar antes do merge em branch protegida
1. **`merge` vs `--strict-mcp-config`** — o spec pedia `--strict` p/ isolamento (não vazar/
   sobrescrever o MCP pessoal do user; compliance A.8.28). A entrega usou **merge** (preserva os
   MCPs do user). Tradeoff consciente (UX > isolamento estrito) — **confirmar que é aceitável.**
2. **`health()` do OmniMemory — CORRIGIDO (2026-06-15):** antes batia em `/health` (path que
   pode não existir → falso-negativo). Agora faz um **search mínimo** no path `/v1` já verificado
   (`/actions/omnimemory/v1/search_memories` com `query:"ping", limit:1`) — testa rota+auth+rede
   de uma vez; 401 → "token inválido".
3. **Token = ofuscação XOR, não cifragem** (`registry.rs`, chave hardcoded). Honesto no código
   (TODO keychain). OK p/ v1 local; **não pode ir pra multiusuário/prod sem keychain do OS** (Fase 2).

### Nota fina
Com OmniMemory ativo, o agente tem **dois caminhos** pro mesmo backend: as tools `memory_*`
(roteadas) + o MCP nativo injetado (`agent_wiring`). Leve redundância, não quebra. Quando
unificar, o DEV_CONTRACT deveria virar o `systemPromptSnippet` do provider ativo.

## Pendências (pra seguir)
- **Push/PR** do branch → dispara o code-review-ai. (Decisão do owner; envolve organização do
  branch — Fase 1a + 1b + features de canvas estão todas juntas.)
- **Fase 1c** — provider Obsidian (vault local + graph de `[[links]]`).
- **Fase 2** — token no keychain do OS; get/forget no gateway OmniMemory; graph view + memory node.
- **CLI `maestri` no PATH** — deferido até o app ser empacotado/instalado (hoje roda via `tauri:dev`).
