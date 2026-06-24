# Ações com Backup (painel Saúde do Projeto) — Design

> Status: **active** · 2026-06-24. Evolui o painel de Saúde de **read-only** para **acionável**:
> aplicar correções dos relatórios de IA, SEMPRE com backup automático e decisão do usuário.

**Goal:** Do relatório de IA → ação. Cada finding pode ser corrigido por um agente focado, mas
**nenhum código muda sem (a) confirmação do usuário e (b) backup automático restaurável**. Os
findings viram uma lista rastreada de dívida técnica por projeto.

**Princípio inviolável (do Jesse):** *backup obrigatório antes de corrigir QUALQUER código; o
usuário decide o que corrigir.* O backup-gate é a fundação — tudo passa por ele.

---

## Componentes

### 1. Backup-gate (backend, FUNDAÇÃO) — `src-tauri/src/health/backup.rs`
- `#[tauri::command] async fn health_backup(root: String, paths: Vec<String>) -> Result<BackupRef, String>`:
  copia cada arquivo pra `<root>/.omnirift/backups/<ISO-ts>/<relpath>` **usando reflink/CoW**
  (reusa o helper de `commands/fsinfo.rs` — instantâneo onde o FS suporta; fallback `std::fs::copy`).
  Cria `.omnirift/backups/<ts>/manifest.json` com os paths + ts. Retorna `BackupRef{id,ts,files,dir}`.
- `health_backup_restore(root, id) -> Result<(), String>`: restaura os arquivos do backup (sobrescreve).
- `health_backup_list(root) -> Vec<BackupRef>`: lista os backups do projeto (lê os manifests).
- Garante `.omnirift/` no `.gitignore` do projeto (append idempotente se faltar).
- State puro / sob demanda — **nada no setup que panique** (lição v0.1.15).

### 2. Findings acionáveis (frontend) — `AiReportView.tsx`
- Cada `AiFinding` ganha botão **"corrigir"**: → `confirmDialog` → `health_backup([finding.file])` →
  spawna agente focado (evento `omnirift:health-spawn-agent`, já existente, com payload estendido
  `{target, finding, backupId}`) seedado com arquivo+linha+título+sugestão pra aplicar SÓ aquele fix.
- Botão **"corrigir tudo do arquivo"** (backup 1x do arquivo → agente com todos os findings dele).
- Sem ação automática: toda correção exige o clique + passa pelo backup-gate. Mostra o BackupRef criado.

### 3. Tracker de tech-debt (frontend + persistência) — `health-tracker.ts` + `DebtTab`
- Persiste os findings por projeto (`localStorage` chave `omnirift-health-debt:<rootHash>`): cada item
  `{ id, file, title, severity, status, backupId?, ts }`, status ∈ `aberto|corrigindo|resolvido|ignorado`.
- Aba **"Dívida"** no painel: lista os itens, filtro por status/arquivo, ação **restaurar** (chama
  `health_backup_restore`) e marcar **resolvido/ignorado**. O usuário decide o que atacar.
- Ao mandar "corrigir" um finding → vira `corrigindo` (com backupId); quando o agente fecha, o usuário
  marca `resolvido` (MVP: manual; auto-detecção fica pra depois).

### 4. Fixes do Sidebar (uso, não código novo)
- Os fixes reais do `Sidebar.tsx` (window.prompt→modal, stale-closure/timers, etc.) são aplicados
  POR esse fluxo: o usuário escolhe o finding → backup → corrigir. Nada de refactor automático em massa.

## Contratos
```
BackupRef { id: string, ts: string, files: string[], dir: string }
DebtItem  { id, file, title, severity, status, backupId?, ts }
```

## Error handling
- Backup falha (disco cheio, permissão) → **ABORTA o fix** (não corrige sem backup) + erro claro.
- reflink indisponível → cópia normal (mais lenta, mas funciona). Restore valida que o backup existe.
- Agente de fix indisponível (sem CLI) → mesma degradação amigável do `health_analyze_file`.

## Boundaries
- `backup.rs` só faz IO de backup/restore (puro, testável). A orquestração de spawn fica no listener
  existente da Sidebar (estendido pro payload com finding+backupId). Tracker é frontend/persistência.

## Testing
- Rust: `health_backup` cria a árvore + manifest; `health_backup_restore` recupera o conteúdo original
  (round-trip num dir temp); `.gitignore` recebe `.omnirift/` idempotente. (reflink: testa o fallback copy.)
- TS: tracker persiste/lê/filtra; "corrigir" chama backup ANTES do spawn (ordem garantida).
- Boot-test obrigatório antes do release.

## Decisões
1. Backup = cópia reflink em `.omnirift/backups/<ts>/` + manifest + restore 1-clique (aprovado).
2. `.omnirift/` no `.gitignore` por padrão (aprovado).
3. Backup é **gate obrigatório** + correção sempre sob confirmação do usuário (princípio do Jesse).
4. Tracker persiste em localStorage por projeto (MVP); marcar resolvido é manual no MVP.
