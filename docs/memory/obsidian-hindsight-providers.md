# Obsidian + Hindsight como providers de memória (estudo)

> Status: **estudo / pendente de decisão** · 2026-06-16
> Contexto: Fase 8 — Memória plugável (interface do cérebro). Ambos encaixam na
> trait `MemoryProvider` existente (`apps/desktop/src-tauri/src/memory/`).

## Por que isto encaixa

A Fase 8 já tem a abstração de provider plugável:

- `MemoryProvider` (trait) + `LocalProvider` (SQLite blackboard, default) + `OmniMemoryProvider` (gateway remoto)
- `MemoryRegistry` mantém o provider ativo + conexões (tabela `memory_connections`)
- As tools MCP `memory_*` roteiam pelo provider ativo
- `agent_mcp_config` injeta o MCP do provider ativo nos agentes (`agent_wiring().mcp_servers`)
- Comandos: `memory_providers_list`, `memory_connect`, `memory_test`, `memory_set_active`, `memory_active`

A trait (`memory/provider.rs`) pede:

```rust
trait MemoryProvider {
    fn kind(&self) -> ProviderKind;
    async fn health(&self) -> ProviderHealth;
    async fn save(&self, m: NewMemory) -> Result<String>;       // store
    async fn search(&self, q: MemoryQuery) -> Result<Vec<MemoryRecord>>; // recall
    async fn get(&self, id: &str) -> Result<Option<MemoryRecord>>;
    async fn forget(&self, id: &str) -> Result<bool>;
    fn agent_wiring(&self) -> AgentWiring;  // injeta MCP nos agentes (default: none)
}
```

Adicionar um provider = implementar isso + registrar na `MemoryRegistry` + uma entrada
na Área de Conexões (UI Fase 1b, ainda pendente).

---

## 🟣 Obsidian (plugin "Local REST API")

- Repo do plugin: https://github.com/coddingtonbear/obsidian-local-rest-api
- Comunidade: https://community.obsidian.md/
- Vault em **markdown** — o usuário já vive nele (segundo cérebro humano-legível).
- Expõe HTTP local **e um MCP nativo** (`/mcp/`).

### Conexão
- Base: `https://127.0.0.1:27124/` (HTTPS, cert self-signed) ou `http://127.0.0.1:27123/`
- Auth: `Authorization: Bearer <api-key>` (de Settings → Local REST API no Obsidian)
- Cert self-signed → no Rust, `reqwest` com `danger_accept_invalid_certs(true)` **só pra 127.0.0.1**

### Mapeamento trait → endpoints
| Trait | Obsidian |
|---|---|
| `save(memory)` | `PUT /vault/{path}` (cria) ou `POST /vault/{path}` (append) — nota markdown; `category`/`project` no **frontmatter** |
| `search(query)` | `POST /search/simple/?query=...` (full-text) **ou** `POST /search/` (JsonLogic em frontmatter/tags/path) |
| `get(id)` | `GET /vault/{path}` (id = caminho da nota) |
| `forget(id)` | `DELETE /vault/{path}` |
| **`agent_wiring()`** | injeta o **`/mcp/`** do Obsidian → agentes ganham as tools do vault direto |

Outros endpoints úteis: `/vault/{path}/frontmatter/{key}`, `/vault/{path}/heading/{name}`,
`/tags/`, `/periodic/{period}/` (daily notes), `/open/{path}` (abre na UI).

### Avaliação
- **Bom pra:** conhecimento curado (humano + agente compartilham), notas legíveis, daily notes.
- **Infra:** zero (já roda no Obsidian do usuário).
- **Esforço:** **baixo** — provider reqwest fino + injeção do `/mcp/`.
- **Risco:** cert self-signed; escopo só na instância Obsidian local rodando.

---

## 🔵 Hindsight (vectorize-io) — MIT

- Repo: https://github.com/vectorize-io/hindsight
- **Memória de agente que aprende com o tempo.** 3 tipos (biomimético): **World** (fatos),
  **Experiences** (experiências do agente), **Mental Models** (compreensão aprendida).
- Recall combina **4 estratégias**: semântica + keyword (BM25) + grafo + temporal.
- Benchmark: LongMemEval **>90%** (vs ~60-70% de RAG/vetorial puro).

### Conexão
- REST API na porta **8888** + SDKs (`hindsight-client` Python, `@vectorize-io/hindsight-client` Node)
- Modo **embedded** (Python, sem servidor: `HindsightServer`) + CLI
- **Sem MCP nativo** (tem doc/skill pra Claude Code) → as tools `memory_*` roteiam pro REST dele

### Mapeamento trait → operações
| Trait | Hindsight |
|---|---|
| `save(memory)` | `retain(bank_id, content, context?, timestamp?)` |
| `search(query)` | `recall(bank_id, query)` — multi-estratégia (muito além do `LIKE` do SQLite) |
| **+ novo: `reflect`** | `reflect(bank_id, query)` — o agente **sintetiza/aprende** (não temos nada disso) |
| `get`/`forget` | best-effort (Hindsight é recall-cêntrico; mapear ao que o REST expõe) |
| `agent_wiring()` | `none` (igual Local) — roteia via `memory_*` |

### Avaliação
- **Bom pra:** o "agentes ficam mais espertos a cada sessão" — **upgrade do nosso blackboard**.
- **Infra:** **PostgreSQL** (Hindsight traz no Docker) + um **LLM externo** (OpenAI/Anthropic/
  Gemini/Groq/**Ollama**/LMStudio) — ou seja, o nosso **LLM BYOK** (`llm_chat`) já serve.
- **Esforço:** médio (subir Postgres + Hindsight via Docker; provider reqwest pro :8888; fiar o LLM BYOK).
- **Desbloqueio:** a memória **semântica/aprendida** que tínhamos adiado ("embeddings exigem LLM
  e n vamos usar agora") — o Hindsight bundla embeddings + usa o LLM BYOK. Não precisamos construir.

---

## Os dois são complementares

- **Obsidian** = conhecimento legível, curado, humano+agente compartilham.
- **Hindsight** = memória episódica/aprendida do agente (reflect, recall multi-estratégia).

A `MemoryRegistry` já suporta múltiplas conexões → dá pra ter **Local + OmniMemory + Obsidian +
Hindsight** e trocar o ativo na Área de Conexões. Avançado: provider ativo roteia `memory_*`,
mas `agent_wiring()` poderia injetar o `/mcp/` do Obsidian **em paralelo**.

## Recomendação de ordem

1. **ObsidianProvider primeiro** — quick win (HTTP fino + injeta `/mcp/`), infra zero, usuário já usa.
2. **HindsightProvider** depois — o "cérebro forte" (Postgres + LLM BYOK); transformador.

## Decisões pendentes (analisar depois)

- [ ] Estender a trait com `reflect()` (pro Hindsight) ou expor só como tool MCP extra?
- [ ] Obsidian: layout do vault pras memórias de agente (pasta `omnirift/`? por projeto? frontmatter schema?)
- [ ] Hindsight: subir via Docker gerenciado pelo app, ou o usuário aponta uma instância existente?
- [ ] Múltiplos providers ativos ao mesmo tempo (Obsidian conhecimento + Hindsight episódica) vs um ativo só?
- [ ] Onde guardar tokens/URLs (tabela `memory_connections` já ofusca; keychain é Fase 2)

## Refs

- Trait: `apps/desktop/src-tauri/src/memory/provider.rs`
- Registry/providers: `apps/desktop/src-tauri/src/memory/{registry,local,omnimemory}.rs`
- Spec Fase 8: `docs/superpowers/specs/2026-06-15-maestri-brain-interface-design.md`
