# Gerenciador de banco no canvas — plano

> 2026-06-16 · Fase 1 ✅ feita · Fase 2 ⏳ a decidir

## Fase 1 — Browser SQLite ✅ (feita)

O nó **DB** virou um mini-browser SQLite (sem driver novo — reusa `db_query`):

- **Sidebar de tabelas** (lista via `sqlite_master`, auto ao abrir o `.db`) → clica numa tabela → `SELECT * FROM "<t>" LIMIT 200`
- **Editor SQL** + grid de resultados (Ctrl+Enter roda) · botão **recarregar tabelas**
- **Maximizar** (⤡) → overlay pra layout pgAdmin-like (sidebar + editor + grid com espaço)
- Tamanho default maior (560×420) pra caber a sidebar

Arquivos: `apps/desktop/src/components/nodes/DbNode.tsx` · backend `commands/dbnode.rs` (`db_query`).

## Fase 2 — Multi-DB (Postgres/MySQL) ⏳ a decidir

**Sacada:** `sqlx` (Rust) suporta **SQLite + Postgres + MySQL num driver só**. Conexão = URL
(`sqlite://`, `postgres://user:pass@host/db`, `mysql://…`); a mesma engine roda em qualquer um.

**O que entra:**
- Backend: `db_query(url, sql)`, `db_tables(url)`, `db_schema(url, tabela)`, `db_test(url)` — por dialeto
- Conexões: Área "Bancos de dados" na sidebar (tipo + host/porta/user/senha/db, ou URL; testa; salva com senha ofuscada como em `memory_connections`)
- Browser opera qualquer conexão (não só arquivo `.db`)

### Decisão honesta (do estudo com o usuário)
- **Vale a Fase 2 só se "agente operando banco remoto no fluxo" for um workflow real.** Senão, DBeaver/pgAdmin maduros já resolvem — duplicar não compensa o peso.
- **Segurança:** dar credencial de banco de produção a agentes de IA exige gating cuidadoso.
- **Peso:** `sqlx` + Postgres + MySQL **pesa no BUILD e no binário** (drivers grandes + TLS) — compile mais lento, AppImage ~+10-30MB. Runtime idle: leve.

## Specs de máquina pro OmniRift (advisory)

O app é leve; o peso são **agentes + Serena (LSP) + Playwright**, não o canvas.

| Cenário | Recomendado |
|---|---|
| App + 1-2 agentes | 4 núcleos · 8 GB · SSD |
| Vários agentes + Serena + browser | 8 núcleos · **16 GB** · SSD |
| Pesado (muitos agentes, repos grandes, Serena poliglota) | 8+ núcleos · 16-32 GB · SSD rápido |

- **RAM** é o gargalo nº1 (cada agente CLI = Node + LLM; cada LSP do Serena; chromium do Playwright)
- **SSD** forte recomendação — o HD externo atual é o gargalo real (builds 2-3 min, Serena, worktrees)
- GPU irrelevante (WebKitGTK compõe leve)
