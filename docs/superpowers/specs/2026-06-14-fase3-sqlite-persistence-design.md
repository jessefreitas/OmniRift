# Spec + Plano — Fase 3: Persistência SQLite (auto-save/restore)

- **Data:** 2026-06-14
- **Status:** Aprovado — em execução
- **Roadmap:** Fase 3 (Roles + persistência SQLite). Roles já existem (`AgentRole` + presets); falta a persistência.

## Problema
Hoje o canvas só persiste se o usuário clicar **Salvar/Abrir** (export/import JSON manual). Reiniciar o app = canvas vazio. Sem durabilidade automática.

## Meta
O app **lembra sozinho** do canvas (floors/nós/edges/cwd) entre reinícios. PTYs re-spawnam do comando salvo (processo vivo não ressuscita; a estrutura volta).

## Decisão
**Doc-em-SQLite** (o `WorkspaceFileV2` serializado num único row), não schema relacional — durável, casa com o modelo, sem complexidade desnecessária no v1. Salvar/Abrir manual continua intacto.

## Arquitetura

**Backend (Rust):**
- Dep: `rusqlite = { version = "0.32", features = ["bundled"] }` (SQLite embutido, sem dep de sistema).
- `src-tauri/src/db.rs`: `pub struct Db(parking_lot::Mutex<rusqlite::Connection>)`.
  - `Db::open(dir: PathBuf) -> Result<Db>` — cria o dir, abre `maestri.db`, `CREATE TABLE IF NOT EXISTS workspace (id INTEGER PRIMARY KEY, doc TEXT NOT NULL, updated_at TEXT)`.
  - `save(&self, doc: &str)` — UPSERT row id=1.
  - `load(&self) -> Result<Option<String>>` — SELECT doc WHERE id=1.
- Comandos: `db_save_workspace(doc: String, db: State<Db>)`, `db_load_workspace(db: State<Db>) -> Option<String>`.
- `lib.rs` setup: `let db = Db::open(app.path().app_data_dir()?)?; app.manage(db);` + registra os comandos.

**Frontend (TS):**
- `lib/db-client.ts`: `dbSaveWorkspace(doc)`, `dbLoadWorkspace()`.
- `lib/persistence-client.ts`: `initPersistence()`:
  - **auto-load** no boot: `dbLoadWorkspace()` → se houver doc, `restoreWorkspace(JSON.parse(doc))`.
  - **auto-save** debounced (~600ms) via `useCanvasStore.subscribe`, dedup por assinatura do `getWorkspaceSnapshot()` (o store muda muito — status/posições; salva só quando o doc realmente muda).
- `App.tsx`: chama `initPersistence()` no mount (antes/junto do bridge de orquestração).

## Tasks
1. **Rust** — `db.rs` + comandos + `lib.rs` + dep. Teste unit (sqlite in-memory: save→load round-trip). Verif: `cargo test --lib db:: && cargo build`.
2. **Frontend** — `db-client.ts` + `persistence-client.ts` + `App.tsx`. Verif: `tsc`.
3. **Smoke** — app: criar floors/terminais → fechar → reabrir → canvas restaurado.

## Fora de escopo (v1)
Schema relacional; histórico/versões; restaurar estado vivo de PTY (impossível); migração de DB schema (uma tabela só).
