# Painel "Saúde do Projeto" — Design

> Status: **active** · Brainstorm 2026-06-23 (Jesse + Claude). Evolui o painel de complexidade
> por-arquivo (9e) para um **dashboard de nível de projeto** com dimensões plugáveis.

**Goal:** Um painel proeminente que mapeia a saúde do projeto inteiro — complexidade de **todos**
os arquivos (hotspots de risco/refactor) e a estrutura do **banco de dados** — e permite pedir
**análise de IA** (relatório inline ou escalando p/ um agente no canvas).

**Por que existe (texto que vai no header/empty-state do painel):**
> "Mapeia a saúde do projeto num lugar só: acha os arquivos mais complexos/arriscados (onde bug
> nasce e refactor compensa) e a estrutura do seu banco — e pede análise de IA pra você agir
> antes que vire problema."

**Arquitetura:** Overlay/dashboard grande (1 por projeto), aberto por botão na toolbar + command
palette. Estrutura de **dimensões plugáveis** (toggles ☑/☐) sobre um shell comum — começa com
**Código** e **Banco de Dados**, extensível (deps, segurança…). Backend Rust faz scan/parse +
expõe via comandos Tauri com streaming de progresso; análise de IA roteia pelo LLM/brain ativo
(OmniPartner/BYOK ou agente headless), com escalada pro fluxo de spawn de agente já existente.

**Tech stack:** Tauri 2 (Rust + React/TS). Reusa: `code/metrics.rs` (`code_metrics`, `MetricLang`),
`ignore` crate (respeito a `.gitignore`), fluxo de spawn de agente (`addTerminal` + `agent_mcp_config`),
provider de memória/LLM ativo (Fase 8 / OmniPartner).

---

## Componentes e responsabilidades

### Backend (Rust) — `src-tauri/src/health/`
- **`scan.rs`** — `project_scan(root)`: caminha o projeto com o crate `ignore` (respeita `.gitignore`,
  pula `node_modules/target/dist/.git`), filtra extensões com grammar de métrica (Rust/TS/TSX/JS/JSX/Python),
  roda `code_metrics` por arquivo. **Streaming**: emite evento `health://file` por arquivo conforme
  calcula (não bloqueia) + `health://scan-done` no fim. **Cache** por `(path, mtime, size)` em memória
  (state) → re-scan só recalcula o que mudou.
- **`db.rs`** — Fase B/C:
  - `db_scan_repo(root)`: detecta fontes de schema no repo — diretórios de migration, `*.sql`,
    `schema.prisma`, models ORM (TypeORM/Sequelize/SQLAlchemy/ActiveRecord/Drizzle) → extrai tabelas,
    colunas, tipos, PK/FK, índices. Fail-soft: o que não parsear vira aviso, não erro.
  - `db_introspect(conn_str)` (Fase C): conecta via `sqlx::Any` e introspecta o schema real.
- **`ai.rs`** — `health_analyze_file(path)` e `health_analyze_db(schema)`: montam prompt (métricas +
  trecho/relação) e rodam no LLM ativo → `AiReport` estruturado. "Escalar p/ agente" NÃO mora aqui:
  o front usa o spawn existente (DebuggerAgent/Reviewer) com o arquivo+métricas injetados.
- **Comandos Tauri** (registrados em `lib.rs`, **state puro, nada no setup que panique**):
  `project_scan`, `health_analyze_file`, `db_scan_repo`, `db_introspect`, `health_analyze_db`.

### Frontend (React) — `src/components/health/`
- **`ProjectHealthPanel.tsx`** — o overlay. Header didático (o "por que existe") + toggles de dimensão
  + corpo por dimensão. Abre via botão na `CanvasToolbar` + entrada na `CommandPalette`. Estado/abertura
  por projeto (persistido em `canvas-store`/localStorage). Gated em `currentCwd` (precisa de projeto aberto).
- **`CodeDimension.tsx`** — resumo (nº arquivos, média cx, top hotspots) + lista/árvore ordenável por cx↓.
  Cada linha: `path · cx · cog · MI` + cor por nível (reusa thresholds do 9e) + checkbox (lote) +
  botão "analisar IA". Clique no arquivo → abre o CodeNode existente naquele arquivo.
- **`DbDimension.tsx`** — tabelas detectadas (do repo) + ação "conectar ao vivo" + "analisar IA".
- **`AiReportView.tsx`** — relatório inline (markdown estruturado: smells, refactors sugeridos, risco)
  por arquivo/lote, com botão **"abrir agente"** (escala pro canvas) e "copiar".
- **`health-client.ts`** — wrappers TS dos comandos + listeners dos eventos de streaming.

## Modelos de dados (contratos)
```
FileHealth   { path, lang, cyclomatic, cognitive, mi, worst_fn: {name,line,cx}, level }
ScanSummary  { total_files, avg_cx, hotspots: FileHealth[], scanned, skipped }
DbTable      { name, columns:[{name,type,pk,fk,nullable}], indexes:[...], source }
AiReport     { target, findings:[{severity, kind, title, detail, suggestion, line?}], summary }
```

## Fluxos
- **Scan (abrir painel):** abre overlay → `project_scan(currentCwd)` → UI popula via `health://file`
  progressivo (skeleton → preenche) → `health://scan-done` fecha o resumo. Re-abrir usa cache.
- **Analisar IA (inline):** clica "analisar IA" em 1+ arquivos → `health_analyze_file` por alvo →
  `AiReportView` renderiza o relatório. Lote = sequencial com progresso.
- **Escalar p/ agente:** botão "abrir agente" no relatório → spawn (DebuggerAgent/Reviewer) no floor
  ativo com o arquivo + métricas + o relatório como contexto inicial.
- **Banco (repo):** toggle Banco → `db_scan_repo` → tabelas; "analisar IA" → `health_analyze_db`.
- **Banco (ao vivo):** "conectar" → connection string → `db_introspect` → mesmo fluxo de análise.

## Faseamento (entrega incremental — cada fase é entregável sozinha)
- **Fase A (MVP):** shell do overlay + toggles + **dimensão Código** completa (scan progressivo +
  cache + hotspots + relatório IA inline + escalar agente). Abrir via toolbar + palette.
- **Fase B:** **dimensão Banco — do repo** (detecção + parse de migrations/SQL/ORM + análise IA).
- **Fase C:** **Banco — ao vivo** (`sqlx::Any` + connection string, credencial via keychain da Fase 8.2).

## Error handling
- Scan: arquivo sem grammar/ilegível → conta em `skipped`, não quebra o scan. Repo gigante → streaming +
  cache evitam travar; cap suave de exibição com aviso ("mostrando top N, +M").
- IA: LLM/brain indisponível → relatório vira estado de erro amigável ("análise indisponível"), painel
  segue mostrando as métricas. Fail-open (igual à camada compress).
- DB ao vivo: falha de conexão → erro claro, nunca trava o painel; credencial nunca em log.

## Boundaries / isolamento
- `health/scan.rs` só calcula (puro) — não spawna nem toca rede. `health/ai.rs` só fala com o LLM.
- O painel **consome** comandos; não duplica lógica de métrica (reusa `code_metrics`) nem de spawn.
- DB é dimensão isolada (Fase B/C) — não bloqueia a dimensão Código.

## Testing
- Rust: `project_scan` respeita `.gitignore` + filtra langs (fixture de dir); cache invalida por mtime;
  `db_scan_repo` parseia uma migration/prisma de fixture. `health_analyze_*` testa a montagem do prompt
  (não a chamada de LLM real).
- TS: `tsc` + render do painel com dados mock; ordenação por cx; seleção em lote.
- **Boot-test obrigatório** (lição v0.1.15): rodar o app e confirmar que abre, antes de release.

## Decisões registradas (do brainstorm)
1. Análise = **métricas automáticas + IA sob demanda** (os dois). 2. Forma = **overlay grande** (painel
de verdade, não popover). 3. IA = **relatório inline + escalar p/ agente**. 4. Scan = **progressivo +
.gitignore + cache**. 5. Dimensões **plugáveis** (Código + Banco, extensível). 6. Banco = **repo + ao
vivo opcional**. 7. Painel **explica por que existe + como ajuda** (header/empty-state didático).

## Em aberto (decidir na fase)
- Motor da IA inline: OmniPartner/BYOK vs agente headless via `multi_agent_dispatch` (decidir na Fase A).
- Persistência do último scan/relatório (só memória vs SQLite) — provável SQLite p/ histórico de hotspots.
