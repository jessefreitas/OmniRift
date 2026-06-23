# Spec — Maestri como interface plugável de memória (Brain Interface)

- **Data:** 2026-06-15
- **Status:** Design — aguardando revisão do spec
- **Depende de:** MCP embarcado (`mcp/server.rs`, `mcp/tools.rs`), PTY spawn (`pty/session.rs` — `PtySpawnConfig.env/args`), canvas store (`store/canvas-store.ts`).
- **Origem:** decisão de produto (Jesse, 2026-06-15) — usar o Maestri como **interface de conexão ao cérebro total**, com backend de memória **plugável** (OmniMemory **ou** Obsidian **ou** outros). Fecha também o problema de onboarding fragmentado dos 4 clientes (o Maestri vira o ponto único que pluga os agentes na memória, sem cirurgia em `~/.claude`).
- **Nota de naming:** "Maestri" é **codename de trabalho** — o produto será renomeado (candidato: OmniRift). O design mantém naming **neutro** (`MemoryProvider`, "Área de Conexões"), sem amarrar à marca; o rebrand não deve tocar a arquitetura.

---

## 1. Problema

Hoje o Maestri orquestra agentes (claude/codex/cursor) em terminais PTY no canvas, mas **nenhum agente tem memória persistente compartilhada** e **não há como ver/operar uma base de conhecimento** dentro do app. Ao mesmo tempo, conectar um dev ao cérebro OmniMemory hoje exige instalar um kit pesado em `~/.claude` (hooks + merge de `settings.json` + PAT) — frágil e travado em 1 cliente.

O Maestri resolve os dois: o canvas **já é um grafo de nós/arestas** (= a forma de um grafo de conhecimento) e o spawn de PTY **já aceita `env`/`args`** (= ponto de injeção da conexão por agente). Falta a **camada de memória plugável**.

## 2. Objetivo e sucesso

Adicionar ao Maestri uma camada `MemoryProvider` **plugável**, com OmniMemory e Obsidian como providers iniciais, em **dois planos**:

- **Plano 1 — Conexão (Brain Connect):** o Maestri conecta a um provider (1x, auth no keychain) e **injeta a conexão em todo agente que spawna** → agentes nascem memory-aware (search/save/handoff), sem tocar no config global do usuário.
- **Plano 2 — Visualização:** views no canvas que renderizam o conteúdo do provider (grafo de conhecimento, busca, sessões) — **live**, não como estado de canvas persistido.

**Sucesso quando:**
- [ ] Trocar de provider (OmniMemory ↔ Obsidian) é uma config, sem recompilar.
- [ ] Um agente spawnado pelo canvas consegue `search`/`save` no provider selecionado sem o usuário ter editado `~/.claude`.
- [ ] O grafo do provider aparece no canvas (entidades+relações no OmniMemory; notas+`[[links]]` no Obsidian).
- [ ] Token/credencial nunca em texto plano (keychain do OS).
- [ ] Tokens/config de outros clientes do usuário permanecem intactos (isolamento via `--strict-mcp-config`).
- [ ] Existe uma **Área de Conexões** (UI) pra adicionar/testar/alternar providers, com status visível e segredo no keychain.

## 3. Arquitetura — abstração `MemoryProvider`

A memória vira uma **interface com backends trocáveis**. OmniMemory é um provider; Obsidian é outro; futuros: Mem0/Notion/local.

```
interface MemoryProvider {
  connect(config) / health()
  search(query, filters)   -> Result[]                  // consulta
  save(content, meta)      -> id                         // auto-captura
  get(id)                  -> Full
  graph(scope)             -> { nodes[], edges[] }       // view do canvas
  agentWiring()            -> AgentWiring                 // como plugar um agente NESTE provider
}

// AgentWiring = como conectar um agente recém-spawnado ao provider:
//   { mcpServers?: McpServerSpec[],   // injetado via --mcp-config / config.toml
//     env?: (k,v)[],                  // injetado em PtySpawnConfig.env
//     systemPromptSnippet?: string }  // injetado via --append-system-prompt / role
```

**Onde mora (espelha os módulos existentes `mcp/`, `git/`, `pty/`):**
- **Rust** `src-tauri/src/memory/`: `provider.rs` (trait `MemoryProvider`), `omnimemory.rs`, `obsidian.rs`, `registry.rs` (provider ativo + config). O backend é dono de gerar a config MCP por agente e injetar no `PtySpawnConfig`.
- **Front** `src/lib/memory-client.ts` (search/graph via Tauri commands) + node novo `memory` no canvas store + painel de conexão.
- **Conexão** persistida no **keychain do OS** (Tauri secure storage), nunca no workspace nem em texto.

## 4. Providers iniciais

| Provider | Auth/conexão | search/save | graph (nodes/edges) | agentWiring |
|---|---|---|---|---|
| **OmniMemory** | bearer token escopado + URL do gateway MCP (`/mcp`, streamable-http) | tools `search_memories` / `save_*` | **entidades + `ontology_relations`** (OML — tipado, com confidence/decay) | `mcpServers: [omnimemory]` + header `Authorization: Bearer <token>` |
| **Obsidian** | **vault = pasta local** (sem auth) ou Local REST API plugin (token local) | ripgrep/Omnisearch + criar/append `.md` | **notas + `[[wikilinks]]`** (o graph view nativo do Obsidian É isso) | MCP community do Obsidian **ou** adapter de filesystem + `systemPromptSnippet` (cwd no vault) |

**Honesto:** o grafo do Obsidian (notas+links, não-tipado) é mais raso que o OML (entidades+relações tipadas + confidence + decay). O canvas renderiza ambos, mas a riqueza difere por provider — `graph()` normaliza pro mesmo `{nodes, edges}`, e o front degrada graciosamente quando faltam atributos.

## 5. Plano 1 — Brain Connect · **Fase 1**

### 5.1 Área de Conexões (UI) — o front da camada de providers

Painel dedicado (estilo dos modais/docks existentes — `RoleEditModal` / `SessionHistoryModal` / `OrchestratorDock`) onde o usuário **gerencia conexões de memória**. É o **ponto de entrada humano** da camada `MemoryProvider`:

- **Lista de providers** com status (conectado / desconectado / health) — OmniMemory, Obsidian, …
- **Adicionar/editar conexão:** OmniMemory (URL do gateway + token escopado); Obsidian (folder picker do vault, ou token do Local REST API). Cada provider declara seu próprio formulário de config (campos vêm do provider, não hardcoded na UI).
- **Testar conexão** (`provider.health()`) com feedback visual **antes** de salvar.
- **Definir provider ativo** (default global; override por-floor/por-agente em fase futura).
- **Múltiplas conexões coexistem** — ter OmniMemory + Obsidian configurados e alternar com 1 clique.
- Segredos no **keychain do OS**; a UI nunca exibe/loga o token salvo (só mascarado, ex.: `omni_••••3f2a`).

> O provider **ativo** nesta área é o que o `agentWiring` (§5.2) injeta nos agentes spawnados e o que as views do Plano 2 consultam. Trocar de provider aqui = trocar a memória de todo o ambiente, sem recompilar.

### 5.2 Wiring por agente

O Maestri **gera config MCP por agente** apontando pro provider ativo, injetada no spawn — **decisão fechada: nunca editar `~/.claude` global.**

Por tipo de agente (resolvido por `pty/profile.rs`):
- **claude:** escreve um `.mcp.json` temporário por agente com `provider.agentWiring().mcpServers`; passa `--mcp-config <path> --strict-mcp-config` em `PtySpawnConfig.args` (o `--strict` ignora o config global → isolamento garantido).
- **codex:** passa `-c mcp_servers.<name>...` (ou `--config <path>`) com o server do provider.
- **cursor / cursor-agent:** escreve `.cursor/mcp.json` no cwd do floor (worktree).
- **fallback (sem `--mcp-config`, ou Obsidian-as-filesystem):** injeta `env` (`MEMORY_PROVIDER`, `OMNIMEMORY_MCP_URL`/`OMNIMEMORY_TOKEN` **ou** `OBSIDIAN_VAULT`) + `--append-system-prompt`/role com o `systemPromptSnippet` instruindo o uso da memória.

Ponto de injeção (já existe): `PtySession::spawn` aplica `cfg.env`/`cfg.args` (session.rs:66-80); `addTerminal` (canvas-store.ts:161) monta `command/args/cwd`. A wiring entra aumentando esses campos no caminho de spawn de agente.

## 6. Plano 2 — Visualização (graph view + memory node)

- **Memory node** (`kind: "memory"` no canvas) — painel de busca: query → resultados como cards; salvar/curar.
- **Graph view** — `provider.graph(scope)` → React Flow renderiza nós (entidades/notas) + arestas (`kind: "relation"`). Navegar/expandir (lazy-load de vizinhos).
- **Sessions/History** — unifica o session recorder SQLite local com as sessões do provider (quando houver).
- **Crucial:** conteúdo do cérebro é **live** (vem do provider), **não** entra no `getWorkspaceSnapshot()`. O grafo é uma view que consulta — não nós salvos no workspace. Isso evita drift entre canvas e cérebro.

## 7. Auth / segurança

- Config de conexão (token, URL, vault path) no **keychain do OS** via Tauri — nunca em `localStorage`, workspace ou log.
- OmniMemory: usar **token escopado** (não admin global); o Maestri repassa o mesmo token pros agentes via wiring.
- `--strict-mcp-config` garante que a injeção do Maestri **não vaza nem sobrescreve** o config MCP pessoal do usuário.
- Deny-list de comandos destrutivos do Maestri continua valendo nos agentes.

## 8. Fases

- **Fase 1 (este spec):** `MemoryProvider` trait + provider OmniMemory + **Brain Connect** (wiring por agente, claude primeiro). Critério: agente spawnado faz `search_memories` sem config global.
- **Fase 2:** Graph view + Memory node (Plano 2) sobre o OmniMemory.
- **Fase 3:** Provider Obsidian (filesystem adapter + graph de `[[links]]`).
- **Fase 4:** providers adicionais (Mem0/Notion/local), sessões unificadas.

## 9. Testes (pirâmide)

- **Rust unit:** `agentWiring()` por provider gera o spec MCP correto; `omnimemory.rs` parseia resposta de `search`; geração do `.mcp.json` temporário (claude) e dos `-c` (codex).
- **Integração:** PtyManager spawna `claude --mcp-config <tmp> --strict-mcp-config` com server fake (mock MCP local) → agente lista a tool de memória; provider OmniMemory contra um gateway de teste.
- **Front:** `tsc` direcionado + smoke do Memory node (busca devolve cards) e do graph view (render de `{nodes,edges}` mock).

## 10. Fora de escopo (YAGNI)

- NÃO reescrever o OmniMemory nem o pipeline OML — só consumir.
- NÃO sincronização bidirecional Obsidian↔OmniMemory (Fase futura).
- NÃO edição/curadoria pesada do grafo na v1 (só navegar + abrir; editar vem depois).
- NÃO auth/SSO multiusuário do Maestri (é a camada de infra, "vem depois").

## 11. Riscos

- **Heterogeneidade de wiring entre CLIs** (claude/codex/cursor têm flags diferentes) → encapsular em `agentWiring()` por tipo; cobrir os 3 principais, fallback env+prompt pro resto.
- **`--strict-mcp-config` / flags podem mudar entre versões dos CLIs** → testar contra versão fixada; degradar pro fallback se a flag falhar.
- **graph() grande** (cérebro com milhares de entidades) → `scope` + paginação/lazy-load obrigatórios; nunca puxar o grafo inteiro.
- **Obsidian sem API** → adapter de filesystem é o baseline; MCP community é opcional/melhor-esforço.

## Compliance notes

- **Classe de dados:** confidencial (memória do usuário/projeto pode conter PII via provider).
- **ISO 27001:** A.8.10/A.8.11 (token em keychain, masking), A.8.15 (sem token em log), A.5.15 (token escopado por provider), A.8.28 (isolamento via `--strict-mcp-config`).
- **Risco mitigado:** vazamento de credencial entre providers/agentes; corrupção do config pessoal do usuário (resolvido por não tocar no global).

## Próximo passo

Revisão do spec → `writing-plans` da Fase 1 (Brain Connect). Implementação segue o dev-flow do projeto (worktree + gates + kanban). **Código da implementação despachado pro Ollama (devstral/qwen), auditado pelo Claude** (regra external-first).
