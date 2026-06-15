# Fase 1a — Camada de Memory Provider (backend) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans pra implementar task-a-task. Steps usam checkbox (`- [ ]`).
> **Execução OmniForge:** o **corpo do código** de cada step é gerado via Ollama (`multi_agent_dispatch.py --type code`, devstral/qwen) e **auditado pelo Claude** por execução real (`cargo test`). As **interfaces, tipos e testes** abaixo são o contrato fixo — não mudam.

**Goal:** Tornar a memória do Maestri **plugável** atrás de uma interface estável `MemoryProvider`, com `LocalProvider` (SQLite existente, default zero-config) e `OmniMemoryProvider` (gateway remoto) — sem UI ainda.

**Architecture:** Novo módulo `src-tauri/src/memory/` com trait `MemoryProvider` + registry de conexões (Tauri managed state). As tools `memory_*` (já existentes em `mcp/tools.rs`) passam a rotear pelo provider **ativo** em vez de chamar `db` direto. `agent_mcp_config` ganha a injeção do MCP do provider quando aplicável. Reaproveita a fiação de spawn que já existe (`agent_mcp_config` + `workerClaudeArgs`).

**Tech Stack:** Rust 2021, Tauri 2.11, reqwest 0.12 (rustls, já no Cargo), rusqlite 0.32 (bundled, já no Cargo), serde_json, tokio. Segredos: ver Task 1 (decisão keyring vs SQLite cifrado).

---

## File structure

| Arquivo | Responsabilidade |
|---|---|
| `src-tauri/src/memory/mod.rs` (criar) | re-exports + `pub mod` do módulo |
| `src-tauri/src/memory/types.rs` (criar) | `MemoryRecord`, `MemoryQuery`, `ProviderHealth`, `AgentWiring`, `ProviderKind`, `ConnectionConfig` |
| `src-tauri/src/memory/provider.rs` (criar) | trait `MemoryProvider` |
| `src-tauri/src/memory/local.rs` (criar) | `LocalProvider` — wrappeia o blackboard SQLite (`db.rs`) |
| `src-tauri/src/memory/omnimemory.rs` (criar) | `OmniMemoryProvider` — reqwest → gateway |
| `src-tauri/src/memory/registry.rs` (criar) | `MemoryRegistry` (conexões + provider ativo) — Tauri state |
| `src-tauri/src/commands/memory.rs` (criar) | comandos Tauri: list/connect/test/set_active/active |
| `src-tauri/src/mcp/tools.rs` (modificar `memory_dispatch`, ~245-325) | rotear pelo provider ativo |
| `src-tauri/src/commands/mcp.rs` (modificar `agent_mcp_config`, ~86-126) | injetar MCP do provider ativo |
| `src-tauri/src/lib.rs` (modificar) | `pub mod memory;` + `manage(MemoryRegistry)` + registrar comandos |
| `src-tauri/src/commands/mod.rs` (modificar) | `pub mod memory;` |

---

### Task 1: Deps + decisão de armazenamento de segredo + esqueleto do módulo

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/memory/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:1-6` (lista de `pub mod`)

**Decisão (registrar):** segredo do provider (token OmniMemory) fica em **SQLite cifrado** no `app_data_dir` (tabela `memory_connections`), **não** no `keyring` do OS. Motivo: o projeto evita deps de sistema (rusqlite `bundled`, rustls em vez de native-tls); `keyring` no Linux puxa libsecret/dbus. Cifragem local com chave derivada por máquina (Task 5). *(Refina o spec, que dizia "keychain" — keychain vira melhoria opcional Fase 2.)*

- [ ] **Step 1: criar o módulo vazio** — `memory/mod.rs` com:
```rust
pub mod types;
pub mod provider;
pub mod local;
pub mod omnimemory;
pub mod registry;

pub use provider::MemoryProvider;
pub use registry::MemoryRegistry;
pub use types::*;
```
(os arquivos referenciados são criados nas tasks seguintes; criar stubs `// TODO Task N` vazios pra compilar não — preferir criar este `mod.rs` só na Task 6 quando os submódulos existirem. **Reordenação:** fazer os `pub mod` só quando o submódulo existir.)

- [ ] **Step 2: registrar `pub mod memory;` em lib.rs** — adicionar a linha após `pub mod mcp;` (lib.rs:4).

- [ ] **Step 3: compilar** — Run: `cd apps/desktop/src-tauri && cargo build`  ·  Expected: compila (módulo vazio ok).

- [ ] **Step 4: commit**
```bash
git add apps/desktop/src-tauri/src/memory/ apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(memory): esqueleto do módulo memory provider"
```

---

### Task 2: Tipos + trait `MemoryProvider`

**Files:**
- Create: `apps/desktop/src-tauri/src/memory/types.rs`
- Create: `apps/desktop/src-tauri/src/memory/provider.rs`
- Test: inline `#[cfg(test)]` em `provider.rs` (MockProvider)

- [ ] **Step 1: escrever o teste falho** (MockProvider implementa o trait, roundtrip save→search):
```rust
// provider.rs  #[cfg(test)] mod tests
struct MockProvider { store: parking_lot::Mutex<Vec<MemoryRecord>> }
#[async_trait::async_trait]
impl MemoryProvider for MockProvider {
    fn kind(&self) -> ProviderKind { ProviderKind::Local }
    async fn health(&self) -> ProviderHealth { ProviderHealth::ok("mock") }
    async fn save(&self, r: NewMemory) -> anyhow::Result<String> {
        let id = format!("m{}", self.store.lock().len());
        self.store.lock().push(MemoryRecord{ id: id.clone(), content: r.content, category: r.category, project: r.project });
        Ok(id)
    }
    async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>> {
        Ok(self.store.lock().iter().filter(|m| m.content.contains(&q.query)).cloned().collect())
    }
    async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>> {
        Ok(self.store.lock().iter().find(|m| m.id==id).cloned())
    }
    async fn forget(&self, id: &str) -> anyhow::Result<bool> {
        let mut s=self.store.lock(); let n=s.len(); s.retain(|m| m.id!=id); Ok(s.len()<n)
    }
    fn agent_wiring(&self) -> AgentWiring { AgentWiring::none() }
}

#[tokio::test]
async fn save_then_search_roundtrip() {
    let p = MockProvider{ store: parking_lot::Mutex::new(vec![]) };
    let id = p.save(NewMemory{ content:"decisão X".into(), category:"decision".into(), project:None }).await.unwrap();
    let hits = p.search(MemoryQuery{ query:"decisão".into(), project:None, limit:10 }).await.unwrap();
    assert_eq!(hits.len(), 1);
    assert_eq!(hits[0].id, id);
}
```

- [ ] **Step 2: rodar e ver falhar** — Run: `cargo test -p maestri-linux memory::provider`  ·  Expected: FAIL (tipos/trait não existem).

- [ ] **Step 3: definir tipos** (`types.rs`):
```rust
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ProviderKind { Local, OmniMemory, Obsidian }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryRecord { pub id: String, pub content: String, pub category: String, pub project: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NewMemory { pub content: String, pub category: String, pub project: Option<String> }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MemoryQuery { pub query: String, pub project: Option<String>, pub limit: usize }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ProviderHealth { pub ok: bool, pub detail: String }
impl ProviderHealth {
    pub fn ok(d: &str) -> Self { Self{ ok:true, detail:d.into() } }
    pub fn fail(d: String) -> Self { Self{ ok:false, detail:d } }
}

/// Como conectar um agente recém-spawnado a ESTE provider.
#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct AgentWiring {
    /// Entradas a mesclar no `mcpServers` do agent-mcp.json (nome → spec JSON).
    pub mcp_servers: Vec<(String, serde_json::Value)>,
    /// Vars de env a injetar no PtySpawnConfig.
    pub env: Vec<(String, String)>,
    /// Trecho a anexar via --append-system-prompt / role.
    pub system_prompt_snippet: Option<String>,
}
impl AgentWiring { pub fn none() -> Self { Self::default() } }

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ConnectionConfig {
    pub kind: ProviderKind,
    /// OmniMemory: URL do gateway MCP (ex. https://memory.omnimemory.com.br/mcp). Obsidian: vault path.
    pub endpoint: Option<String>,
    /// Token (cifrado em repouso pela registry; nunca serializado pro front em claro).
    #[serde(skip_serializing)]
    pub token: Option<String>,
}
```

- [ ] **Step 4: definir o trait** (`provider.rs`):
```rust
use crate::memory::types::*;

#[async_trait::async_trait]
pub trait MemoryProvider: Send + Sync {
    fn kind(&self) -> ProviderKind;
    async fn health(&self) -> ProviderHealth;
    async fn save(&self, m: NewMemory) -> anyhow::Result<String>;
    async fn search(&self, q: MemoryQuery) -> anyhow::Result<Vec<MemoryRecord>>;
    async fn get(&self, id: &str) -> anyhow::Result<Option<MemoryRecord>>;
    async fn forget(&self, id: &str) -> anyhow::Result<bool>;
    /// Default: sem injeção (provider local não precisa wirar nada — agente usa as tools memory_* do MCP do Maestri).
    fn agent_wiring(&self) -> AgentWiring { AgentWiring::none() }
}
```
Adicionar dep `async-trait = "0.1"` no Cargo.toml (Task 1 step opcional — incluir aqui se faltar).

- [ ] **Step 5: rodar e ver passar** — Run: `cargo test -p maestri-linux memory::provider`  ·  Expected: PASS.

- [ ] **Step 6: commit**
```bash
git add apps/desktop/src-tauri/src/memory/ apps/desktop/src-tauri/Cargo.toml
git commit -m "feat(memory): trait MemoryProvider + tipos"
```

---

### Task 3: `LocalProvider` (reusa o blackboard SQLite)

**Files:**
- Create: `apps/desktop/src-tauri/src/memory/local.rs`
- Test: inline `#[cfg(test)]`

> Contexto: `db.rs` já tem `memory_remember(content, category, project, ...) -> id`, `memory_recall(query, ...)`, `memory_list`, `memory_forget(id)`. `LocalProvider` é um adapter fino sobre `Arc<crate::db::Db>`. **Auditar as assinaturas reais de `db.rs` antes de implementar** (o worker DEVE abrir `db.rs` e casar os parâmetros — não inventar).

- [ ] **Step 1: teste falho** — roundtrip via `LocalProvider` contra `Db` temp:
```rust
#[tokio::test]
async fn local_provider_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let db = std::sync::Arc::new(crate::db::Db::open(dir.path()).unwrap());
    let p = LocalProvider::new(db);
    let id = p.save(NewMemory{ content:"endpoint X = /api/y".into(), category:"note".into(), project:Some("proj".into()) }).await.unwrap();
    let hits = p.search(MemoryQuery{ query:"endpoint".into(), project:Some("proj".into()), limit:10 }).await.unwrap();
    assert!(hits.iter().any(|m| m.id == id));
}
```
(Adicionar `tempfile = "3"` em `[dev-dependencies]` se faltar.)

- [ ] **Step 2: ver falhar** — Run: `cargo test -p maestri-linux memory::local`  ·  Expected: FAIL.

- [ ] **Step 3: implementar `LocalProvider`** — body via Ollama, contrato: `struct LocalProvider { db: Arc<crate::db::Db> }`, `new(db)`, impl do trait mapeando `save→db.memory_remember`, `search→db.memory_recall`, `get`/`forget`/health(`ProviderHealth::ok("local-sqlite")`), `kind()=Local`, `agent_wiring()=none()`. Casar nomes/params reais de `db.rs`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p maestri-linux memory::local`  ·  Expected: PASS.

- [ ] **Step 5: commit** — `feat(memory): LocalProvider sobre o blackboard SQLite`.

---

### Task 4: `OmniMemoryProvider` (reqwest → gateway)

**Files:**
- Create: `apps/desktop/src-tauri/src/memory/omnimemory.rs`
- Test: inline `#[cfg(test)]` com servidor HTTP stub (axum local em porta efêmera).

> Contrato do gateway: MCP streamable-http em `<endpoint>` com `Authorization: Bearer <token>`. `search` → POST JSON-RPC `tools/call` `search_memories {query, limit, project}`; `save` → `tools/call` `save_memory`. `health` → GET `<base>/health` (200 + `{"status":"healthy"}`). **Auditar o shape real da resposta MCP do gateway** (campo `result.content` etc.) antes de fixar o parser; o stub do teste deve imitar o shape real.

- [ ] **Step 1: teste falho** — contra stub axum que responde health 200:
```rust
#[tokio::test]
async fn omnimemory_health_ok_against_stub() {
    let app = axum::Router::new().route("/health", axum::routing::get(|| async { "{\"status\":\"healthy\"}" }));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
    let p = OmniMemoryProvider::new(ConnectionConfig{ kind: ProviderKind::OmniMemory, endpoint: Some(format!("http://{addr}")), token: Some("t".into()) });
    let h = p.health().await;
    assert!(h.ok, "health detail: {}", h.detail);
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p maestri-linux memory::omnimemory`  ·  Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `struct OmniMemoryProvider { cfg: ConnectionConfig, http: reqwest::Client }`. `new(cfg)` cria `reqwest::Client`. `health` GET `{base}/health` (base = endpoint sem `/mcp`). `search`/`save` POST JSON-RPC ao endpoint MCP com header Bearer. `agent_wiring()` retorna `AgentWiring{ mcp_servers: vec![("omnimemory", json!({"type":"http","url": endpoint, "headers": {"Authorization": format!("Bearer {token}")}}))], ..default }`. Erros → `ProviderHealth::fail`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p maestri-linux memory::omnimemory`  ·  Expected: PASS.

- [ ] **Step 5: commit** — `feat(memory): OmniMemoryProvider via reqwest + agent_wiring`.

---

### Task 5: `MemoryRegistry` (conexões + provider ativo, Tauri state)

**Files:**
- Create: `apps/desktop/src-tauri/src/memory/registry.rs`
- Modify: `apps/desktop/src-tauri/src/db.rs` (tabela `memory_connections` + cifragem) — auditar `Db` p/ seguir o padrão das outras tabelas.
- Test: inline.

- [ ] **Step 1: teste falho**:
```rust
#[tokio::test]
async fn registry_set_active_and_resolve() {
    let dir = tempfile::tempdir().unwrap();
    let db = std::sync::Arc::new(crate::db::Db::open(dir.path()).unwrap());
    let reg = MemoryRegistry::new(db.clone());
    reg.upsert_connection(ConnectionConfig{ kind: ProviderKind::Local, endpoint: None, token: None }).unwrap();
    reg.set_active(ProviderKind::Local).unwrap();
    let active = reg.active_provider();          // -> Arc<dyn MemoryProvider>
    assert_eq!(active.kind(), ProviderKind::Local);
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p maestri-linux memory::registry`  ·  Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `MemoryRegistry { db, active: RwLock<ProviderKind>, conns: DashMap<ProviderKind, ConnectionConfig> }`. `upsert_connection` persiste em `memory_connections` (token cifrado: XOR/AES-GCM com chave derivada do `app_data_dir` + machine-id — função `obfuscate/deobfuscate` simples na v1, marcada `// TODO hardening`). `set_active` valida que a conexão existe. `active_provider() -> Arc<dyn MemoryProvider>` instancia `LocalProvider`/`OmniMemoryProvider` conforme `kind` + conn. `list_connections()` (token mascarado). Default boot = `Local`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p maestri-linux memory::registry`  ·  Expected: PASS.

- [ ] **Step 5: registrar state em lib.rs** — `let memory_registry = Arc::new(MemoryRegistry::new(...));` e `.manage(memory_registry)`. (Nota de ordem: o `Db` é criado no `setup`; a registry precisa do `Db` — instanciar a registry dentro do `setup` após abrir o `Db`, ou tornar o `Db` um Arc compartilhado. Auditar o fluxo atual de `Db` em lib.rs:72-80 e adaptar.)

- [ ] **Step 6: commit** — `feat(memory): MemoryRegistry com conexões persistidas + provider ativo`.

---

### Task 6: Rotear `memory_dispatch` pelo provider ativo (regression-safe)

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs:245-325` (`memory_dispatch`)
- Modify: `apps/desktop/src-tauri/src/mcp/server.rs:31-38` (`McpState` ganha `memory_registry`)
- Modify: `apps/desktop/src-tauri/src/lib.rs:59` (passar a registry pro `mcp_router`)
- Test: inline em tools.rs

> Hoje `memory_dispatch` chama `state.app … db.memory_*` direto. Passa a chamar `state.memory_registry.active_provider().{save,search,...}`. Com `Local` ativo (default), comportamento = idêntico (regression). `memory_dispatch` vira `async` (já está dentro de dispatch async no server.rs:213 — ajustar a chamada pra `.await`).

- [ ] **Step 1: teste falho** — `memory_remember` então `memory_recall` via dispatch com registry Local ativa devolve o item (mesma semântica de antes):
```rust
#[tokio::test]
async fn memory_dispatch_roundtrip_local() {
    // monta McpState mínimo com Db temp + MemoryRegistry(Local ativo)
    // chama memory_dispatch(&state, "memory_remember", json!({"content":"X","category":"note"})).await
    // depois memory_dispatch(&state, "memory_recall", json!({"query":"X"})).await contém "X"
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p maestri-linux mcp::tools::`  ·  Expected: FAIL (assinatura/registry).

- [ ] **Step 3: implementar** — body via Ollama: adicionar `pub(crate) memory_registry: Arc<crate::memory::MemoryRegistry>` em `McpState`; propagar no `mcp_router` (server.rs) e na criação em lib.rs; reescrever `memory_dispatch` p/ `async` roteando pelo `active_provider()`. Manter os nomes de tool (`memory_remember/recall/list/forget/remember_error`) e o formato de retorno texto.

- [ ] **Step 4: ver passar** — Run: `cargo test -p maestri-linux`  ·  Expected: PASS (incl. testes existentes — **regression guard**).

- [ ] **Step 5: commit** — `refactor(memory): memory_* roteia pelo provider ativo (Local default)`.

---

### Task 7: Estender `agent_mcp_config` com a wiring do provider ativo

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/mcp.rs:86-126` (`agent_mcp_config`)
- Test: inline (extrair a montagem do mapa de servers numa fn pura testável).

> Hoje `agent_mcp_config` monta serena+context7+playwright e grava `agent-mcp.json`. Adicionar: pegar `memory_registry.active_provider().agent_wiring().mcp_servers` e **mesclar** no mapa. Com `Local` ativo → nada muda (wiring none). Com `OmniMemory` ativo → entra a entrada `omnimemory` (http + Bearer). **Merge, não strict** — mantém os MCPs do usuário.

- [ ] **Step 1: teste falho** — extrair `fn build_mcp_servers(extra: &AgentWiring) -> serde_json::Map<String,Value>` (pura) e testar:
```rust
#[test]
fn omnimemory_wiring_is_merged() {
    let wiring = AgentWiring{ mcp_servers: vec![("omnimemory".into(), serde_json::json!({"type":"http","url":"https://x/mcp"}))], ..Default::default() };
    let servers = build_mcp_servers(&wiring);
    assert!(servers.contains_key("context7"));   // base preservada
    assert!(servers.contains_key("omnimemory"));  // provider mesclado
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p maestri-linux commands::mcp`  ·  Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama: refatorar `agent_mcp_config` p/ usar `build_mcp_servers(&wiring)`; a command recebe `memory_registry: State<...>` e passa `active_provider().agent_wiring()`. Manter a gravação do `agent-mcp.json`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p maestri-linux commands::mcp`  ·  Expected: PASS.

- [ ] **Step 5: commit** — `feat(memory): agent_mcp_config injeta o MCP do provider ativo (merge)`.

---

### Task 8: Comandos Tauri da camada de conexão

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/memory.rs`
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (`pub mod memory;`)
- Modify: `apps/desktop/src-tauri/src/lib.rs` (imports + `generate_handler!`)
- Test: smoke via `cargo test` (cada command chama a registry).

- [ ] **Step 1: teste falho** — `memory_set_active` + `memory_active` roundtrip (chamando as fns internas, sem o runtime Tauri):
```rust
#[tokio::test]
async fn commands_set_and_get_active() {
    // registry com Local+OmniMemory upserted
    // set_active(OmniMemory) -> active() == "omnimemory"
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p maestri-linux commands::memory`  ·  Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama, comandos:
  - `memory_providers_list() -> Vec<ConnectionConfig>` (token mascarado)
  - `memory_connect(cfg: ConnectionConfig)` → `registry.upsert_connection`
  - `memory_test(kind: ProviderKind) -> ProviderHealth` → instancia provider e chama `health().await`
  - `memory_set_active(kind: ProviderKind)` → `registry.set_active`
  - `memory_active() -> ProviderKind`
  Todos recebem `State<'_, Arc<MemoryRegistry>>`, retornam `Result<_, String>`.

- [ ] **Step 4: registrar em lib.rs** — `use commands::memory::{...}` + adicionar os 5 no `generate_handler![]`.

- [ ] **Step 5: ver passar + build completo** — Run: `cargo test -p maestri-linux && cargo build`  ·  Expected: PASS + compila.

- [ ] **Step 6: commit** — `feat(memory): comandos Tauri connect/test/set_active/list`.

---

## Self-review (coverta vs spec §3–§5.2)

- [x] `MemoryProvider` trait + tipos → Task 2
- [x] OmniMemory provider → Task 4 ; Local (default zero-config) → Task 3
- [x] provider ativo + conexões persistidas → Task 5
- [x] `memory_*` plugável (rota pelo ativo) → Task 6
- [x] agent wiring (injeção merge, não strict) → Task 7
- [x] superfície de comandos pra a Área de Conexões (UI da Fase 1b) → Task 8
- Obsidian provider → **Fase 1c** (fora deste plano)
- Área de Conexões (UI React) → **Fase 1b** (plano separado; consome os comandos da Task 8)
- Graph view / Memory node → **Fase 2**

## Fora de escopo deste plano
UI (Connections area), Obsidian, graph view, keychain do OS (v1 usa SQLite cifrado), override de provider por-floor/por-agente.
