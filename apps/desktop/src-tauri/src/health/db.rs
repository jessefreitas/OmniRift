//! Painel "Saúde do Projeto" (Fase B) — dimensão **Banco de Dados (do repo)**.
//!
//! `db_scan_repo(root)` caminha o repo (REUSA o walker do `scan.rs`: crate `ignore`
//! respeitando `.gitignore`, pulando node_modules/target/dist/.git) procurando fontes
//! de schema e extrai tabelas/colunas/PK/FK/índices:
//!   - **SQL / migrations** (`*.sql`): parser de DDL via crate `sqlparser`
//!     (`CREATE TABLE` → tabelas, colunas, tipos, PK, NOT NULL, FK, índices).
//!   - **Prisma** (`schema.prisma`): parser leve dos blocos `model { ... }`
//!     (campos, `@id`, `@unique`, `@relation`).
//!   - **ORM (código)**: best-effort por regex (TypeORM `@Entity`, Sequelize,
//!     SQLAlchemy, ActiveRecord `schema.rb`, Drizzle) — registra a FONTE; só
//!     detalha colunas quando o padrão é confiável (não inventa schema).
//!
//! `health_analyze_db(root)` roda o scan, monta um prompt PT-BR pedindo análise do
//! SCHEMA em JSON `AiReport` e roda pelo MESMO motor headless do `ai.rs`
//! (`run_agent_report`) — degrada igual (sem CLI → `Err` amigável).
//!
//! Fail-soft: arquivo que NÃO parsear vira aviso em `sources`, nunca derruba o scan.
//! Boundary: este módulo só LÊ o FS + parseia (puro) — `health_analyze_db` é o único
//! que fala com o agente, via `ai.rs`. Conteúdo de arquivo NUNCA é logado.

use std::path::Path;

use ignore::WalkBuilder;
use serde::{Deserialize, Serialize};
use sqlparser::ast::{ColumnOption, Statement, TableConstraint};
use sqlparser::dialect::GenericDialect;
use sqlparser::parser::Parser;

use super::ai::{clear_db_running, mark_db_running, persist_db_report, run_agent_report, AiReport};

/// Diretórios sempre ignorados, mesmo sem `.gitignore` no repo (espelha `scan.rs`).
const ALWAYS_SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".git"];

/// Teto suave de arquivos lidos por scan (evita travar em monorepo gigante).
const MAX_FILES: usize = 5_000;

/// Uma coluna de uma tabela detectada no repo.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbColumn {
    /// Nome da coluna.
    pub name: String,
    /// Tipo declarado (ex.: "VARCHAR(255)", "INTEGER", "String", "uuid").
    /// `type` é reservado em JS → o front recebe a chave `type` (rename abaixo).
    #[serde(rename = "type")]
    pub type_: String,
    /// `true` se a coluna é (parte da) chave primária.
    pub pk: bool,
    /// `true` se a coluna é chave estrangeira (referencia outra tabela).
    pub fk: bool,
    /// `true` se a coluna aceita NULL (default `true`; `NOT NULL`/PK → `false`).
    pub nullable: bool,
}

/// Uma tabela detectada no repo (de SQL/migration, Prisma ou ORM).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct DbTable {
    /// Nome da tabela/entidade.
    pub name: String,
    /// Colunas detectadas (vazio quando a fonte é ORM sem detalhe confiável).
    pub columns: Vec<DbColumn>,
    /// Índices detectados (descrição textual: `CREATE INDEX`, `@@index`, etc.).
    pub indexes: Vec<String>,
    /// Arquivo de origem (caminho absoluto) de onde a tabela foi extraída.
    pub source: String,
}

/// Resultado do `db_scan_repo` — o que o front recebe.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DbScan {
    /// Tabelas detectadas (ordem determinística: nome, depois fonte).
    pub tables: Vec<DbTable>,
    /// Arquivos de schema detectados + avisos de parse (fail-soft: o que não
    /// parseou aparece aqui como `"<arquivo> (aviso: …)"`, não como erro).
    pub sources: Vec<String>,
    /// Dialeto inferido (ex.: "prisma", "sql", "typeorm") quando há um predominante.
    pub dialect: Option<String>,
}

/// `true` se o arquivo é uma fonte de schema candidata (por nome/extensão).
fn is_schema_source(path: &Path) -> bool {
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    if ext == "sql" {
        return true;
    }
    if name == "schema.prisma" || ext == "prisma" {
        return true;
    }
    if name == "schema.rb" {
        return true; // ActiveRecord schema dump
    }
    // ORM em código: só varremos arquivos que provavelmente declaram models.
    matches!(ext.as_str(), "ts" | "js" | "py" | "rb")
}

/// Extrai o último identificador de um `ObjectName` (descarta o schema prefix).
fn object_name_table(name: &sqlparser::ast::ObjectName) -> String {
    name.0
        .last()
        .and_then(|p| p.as_ident())
        .map(|i| i.value.clone())
        .unwrap_or_else(|| name.to_string())
}

/// Parseia DDL SQL (`CREATE TABLE` / `CREATE INDEX`) num conjunto de `DbTable`.
/// `GenericDialect` cobre Postgres/MySQL/SQLite o suficiente. Tolerante: se o
/// arquivo inteiro não parsear, tenta statement-a-statement (split por `;`).
fn parse_sql_tables(sql: &str, source: &str) -> Result<Vec<DbTable>, String> {
    let dialect = GenericDialect {};
    let statements: Vec<Statement> = match Parser::parse_sql(&dialect, sql) {
        Ok(s) => s,
        Err(_) => {
            let mut acc = Vec::new();
            let mut any = false;
            for chunk in sql.split(';') {
                let trimmed = chunk.trim();
                if trimmed.is_empty() {
                    continue;
                }
                if let Ok(mut s) = Parser::parse_sql(&dialect, trimmed) {
                    any = true;
                    acc.append(&mut s);
                }
            }
            if !any {
                return Err("nenhum statement SQL parseável".into());
            }
            acc
        }
    };

    let mut tables: Vec<DbTable> = Vec::new();

    for stmt in &statements {
        match stmt {
            Statement::CreateTable(ct) => {
                let table_name = object_name_table(&ct.name);
                let mut columns: Vec<DbColumn> = Vec::new();
                let mut indexes: Vec<String> = Vec::new();

                // Colunas + opções inline (PRIMARY KEY / NOT NULL / REFERENCES).
                for col in &ct.columns {
                    let mut pk = false;
                    let mut fk = false;
                    // Default SQL: aceita NULL salvo NOT NULL/PK explícito.
                    let mut nullable = true;
                    for opt in &col.options {
                        match &opt.option {
                            ColumnOption::NotNull => nullable = false,
                            ColumnOption::Null => nullable = true,
                            ColumnOption::PrimaryKey(_) => {
                                pk = true;
                                nullable = false;
                            }
                            ColumnOption::ForeignKey(_) => fk = true,
                            _ => {}
                        }
                    }
                    columns.push(DbColumn {
                        name: col.name.value.clone(),
                        type_: col.data_type.to_string(),
                        pk,
                        fk,
                        nullable,
                    });
                }

                // Constraints de tabela: PRIMARY KEY (cols) / FOREIGN KEY (cols) /
                // UNIQUE / INDEX. Marca as colunas + registra índices.
                for c in &ct.constraints {
                    match c {
                        TableConstraint::PrimaryKey(pk_c) => {
                            for ic in &pk_c.columns {
                                let cname = ic.to_string();
                                mark_column(&mut columns, &cname, |col| {
                                    col.pk = true;
                                    col.nullable = false;
                                });
                            }
                        }
                        TableConstraint::ForeignKey(fk_c) => {
                            for ident in &fk_c.columns {
                                mark_column(&mut columns, &ident.value, |col| col.fk = true);
                            }
                        }
                        TableConstraint::Unique(_)
                        | TableConstraint::UniqueUsingIndex(_)
                        | TableConstraint::Index(_) => {
                            indexes.push(c.to_string());
                        }
                        _ => {}
                    }
                }

                tables.push(DbTable {
                    name: table_name,
                    columns,
                    indexes,
                    source: source.to_string(),
                });
            }
            // `CREATE INDEX ... ON <table> (...)` — anexa ao índice da tabela alvo.
            Statement::CreateIndex(ci) => {
                let target = object_name_table(&ci.table_name);
                let desc = stmt.to_string();
                if let Some(t) = tables.iter_mut().find(|t| t.name == target) {
                    t.indexes.push(desc);
                } else {
                    tables.push(DbTable {
                        name: target,
                        columns: Vec::new(),
                        indexes: vec![desc],
                        source: source.to_string(),
                    });
                }
            }
            _ => {}
        }
    }

    if tables.is_empty() {
        return Err("sem CREATE TABLE/INDEX".into());
    }
    Ok(tables)
}

/// Aplica `f` na coluna de nome `name` (case-insensitive), se existir.
fn mark_column(columns: &mut [DbColumn], name: &str, f: impl Fn(&mut DbColumn)) {
    let clean = name.trim().trim_matches(['"', '`', '[', ']']);
    if let Some(col) = columns
        .iter_mut()
        .find(|c| c.name.eq_ignore_ascii_case(clean))
    {
        f(col);
    }
}

/// Parser leve de `schema.prisma`: extrai blocos `model X { ... }` → tabela com
/// campos. Em cada campo: 1º token = nome, 2º = tipo; `@id`/`@unique`/`@relation`
/// e `?` (nullable) são lidos dos atributos. `@@index`/`@@unique` viram índices.
fn parse_prisma_tables(content: &str, source: &str) -> Vec<DbTable> {
    let mut tables = Vec::new();
    let mut lines = content.lines().peekable();

    while let Some(line) = lines.next() {
        let trimmed = line.trim();
        // Abertura de bloco model (ignora `view`/`type`/`enum`/`generator`).
        let Some(rest) = trimmed.strip_prefix("model ") else {
            continue;
        };
        let model_name = rest
            .split_whitespace()
            .next()
            .unwrap_or("")
            .trim_end_matches('{')
            .trim()
            .to_string();
        if model_name.is_empty() {
            continue;
        }

        let mut columns: Vec<DbColumn> = Vec::new();
        let mut indexes: Vec<String> = Vec::new();

        // Consome até o `}` que fecha o bloco.
        for body in lines.by_ref() {
            let bt = body.trim();
            if bt == "}" {
                break;
            }
            if bt.is_empty() || bt.starts_with("//") {
                continue;
            }
            // Atributos de bloco: `@@index([...])`, `@@unique([...])`, `@@id([...])`.
            if bt.starts_with("@@") {
                if bt.starts_with("@@index") || bt.starts_with("@@unique") {
                    indexes.push(bt.to_string());
                }
                if bt.starts_with("@@id") {
                    for name in extract_bracket_idents(bt) {
                        mark_column(&mut columns, &name, |c| {
                            c.pk = true;
                            c.nullable = false;
                        });
                    }
                }
                continue;
            }

            let mut tok = bt.split_whitespace();
            let Some(name) = tok.next() else { continue };
            let Some(raw_type) = tok.next() else { continue };

            let optional = raw_type.ends_with('?');
            let base_type = raw_type.trim_end_matches('?').trim_end_matches("[]");
            let attrs = &bt[bt.find(raw_type).map(|i| i + raw_type.len()).unwrap_or(0)..];

            let is_id = attrs.contains("@id");
            let is_unique = attrs.contains("@unique");
            // `@relation` ⇒ FK (referência explícita a outro model).
            let is_fk = attrs.contains("@relation");

            if is_unique {
                indexes.push(format!("@unique({name})"));
            }

            columns.push(DbColumn {
                name: name.to_string(),
                type_: base_type.to_string(),
                pk: is_id,
                fk: is_fk,
                nullable: optional && !is_id,
            });
        }

        tables.push(DbTable {
            name: model_name,
            columns,
            indexes,
            source: source.to_string(),
        });
    }

    tables
}

/// Extrai identificadores de dentro do 1º `[...]` (ex.: `@@index([a, b])` → [a, b]).
fn extract_bracket_idents(s: &str) -> Vec<String> {
    let Some(open) = s.find('[') else {
        return Vec::new();
    };
    let Some(close) = s[open..].find(']') else {
        return Vec::new();
    };
    s[open + 1..open + close]
        .split(',')
        .map(|p| p.trim().trim_matches('"').to_string())
        .filter(|p| !p.is_empty())
        .collect()
}

/// Detecta entidades ORM em código por regex (best-effort). Retorna `DbTable`s SEM
/// colunas detalhadas (só o nome) quando não dá pra extrair com confiança — NÃO
/// inventa schema. `None` se nenhum padrão ORM bateu.
fn detect_orm_tables(
    content: &str,
    path: &Path,
    source: &str,
) -> Option<(Vec<DbTable>, &'static str)> {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    // ActiveRecord schema dump (`schema.rb`): `create_table "x" do |t|`.
    if name == "schema.rb" {
        let mut tables = Vec::new();
        for line in content.lines() {
            let t = line.trim();
            if let Some(after) = t.strip_prefix("create_table ") {
                if let Some(tn) = first_quoted(after) {
                    tables.push(orm_stub(&tn, source));
                }
            }
        }
        return if tables.is_empty() {
            None
        } else {
            Some((tables, "activerecord"))
        };
    }

    match ext.as_str() {
        // TypeORM `@Entity(...)`, Drizzle `pgTable(...)`, Sequelize `.define(...)`.
        "ts" | "js" => {
            let mut tables = Vec::new();
            let mut kind = "orm";
            for cap in find_all(content, "@Entity") {
                kind = "typeorm";
                let tn = entity_name_after(content, cap).unwrap_or_else(|| "Entity".into());
                tables.push(orm_stub(&tn, source));
            }
            for cap in find_all(content, "Table(") {
                let slice = &content[cap..];
                if slice.starts_with("Table(") {
                    if let Some(tn) = first_quoted(slice) {
                        kind = "drizzle";
                        tables.push(orm_stub(&tn, source));
                    }
                }
            }
            for cap in find_all(content, ".define(") {
                kind = "sequelize";
                if let Some(tn) = first_quoted(&content[cap..]) {
                    tables.push(orm_stub(&tn, source));
                }
            }
            if tables.is_empty() {
                None
            } else {
                Some((tables, kind))
            }
        }
        // SQLAlchemy: `__tablename__ = "name"`.
        "py" => {
            let mut tables = Vec::new();
            for line in content.lines() {
                let t = line.trim();
                if let Some(after) = t.strip_prefix("__tablename__") {
                    if let Some(tn) = first_quoted(after) {
                        tables.push(orm_stub(&tn, source));
                    }
                }
            }
            if tables.is_empty() {
                None
            } else {
                Some((tables, "sqlalchemy"))
            }
        }
        _ => None,
    }
}

/// `DbTable` "stub": só nome + fonte, sem colunas (não inventamos schema do ORM).
fn orm_stub(name: &str, source: &str) -> DbTable {
    DbTable {
        name: name.to_string(),
        columns: Vec::new(),
        indexes: Vec::new(),
        source: source.to_string(),
    }
}

/// Índices (byte-offset) de todas as ocorrências de `needle` em `hay`.
fn find_all(hay: &str, needle: &str) -> Vec<usize> {
    let mut out = Vec::new();
    let mut start = 0;
    while let Some(i) = hay[start..].find(needle) {
        out.push(start + i);
        start += i + needle.len();
    }
    out
}

/// 1ª string entre aspas (simples ou duplas) a partir do início de `s`.
fn first_quoted(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let q = bytes.iter().position(|&b| b == b'\'' || b == b'"')?;
    let quote = bytes[q];
    let rest = &s[q + 1..];
    let end = rest.find(quote as char)?;
    Some(rest[..end].to_string())
}

/// Nome do `@Entity('x')`: se houver `('x')` logo após, usa; senão pega o
/// `class Foo` na sequência. `from` = offset do `@Entity`.
fn entity_name_after(content: &str, from: usize) -> Option<String> {
    let slice = &content[from..];
    if let Some(open) = slice.find('(') {
        let close = slice[open..].find(')').map(|c| open + c).unwrap_or(slice.len());
        if let Some(tn) = first_quoted(&slice[open..close]) {
            if !tn.is_empty() {
                return Some(tn);
            }
        }
    }
    // Sem nome explícito → pega o `class <Nome>` mais próximo.
    let cls = slice.find("class ")?;
    let tail = &slice[cls + "class ".len()..];
    let nm: String = tail
        .chars()
        .take_while(|c| c.is_alphanumeric() || *c == '_')
        .collect();
    if nm.is_empty() {
        None
    } else {
        Some(nm)
    }
}

/// Caminha `root` (REUSANDO o padrão do `scan.rs`: crate `ignore`, `.gitignore`,
/// pula node_modules/target/dist/.git), detecta fontes de schema e extrai tabelas.
/// Fail-soft total: arquivo que não parsear vira aviso em `sources`, nunca erro.
pub fn scan_db_dir(root: &Path) -> DbScan {
    let mut scan = DbScan::default();
    let mut dialect_votes: std::collections::HashMap<&'static str, usize> =
        std::collections::HashMap::new();
    let mut files_seen = 0usize;

    let walker = WalkBuilder::new(root)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|entry| {
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    return !ALWAYS_SKIP_DIRS.contains(&name);
                }
            }
            true
        })
        .build();

    for result in walker {
        if files_seen >= MAX_FILES {
            scan.sources.push(format!(
                "(aviso: teto de {MAX_FILES} arquivos atingido — scan truncado)"
            ));
            break;
        }
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if !is_schema_source(path) {
            continue;
        }
        files_seen += 1;

        let source = path.to_string_lossy().to_string();
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => {
                scan.sources.push(format!("{source} (aviso: ilegível)"));
                continue;
            }
        };

        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        let name = path
            .file_name()
            .and_then(|n| n.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();

        if ext == "sql" {
            match parse_sql_tables(&content, &source) {
                Ok(mut t) => {
                    *dialect_votes.entry("sql").or_insert(0) += 1;
                    scan.tables.append(&mut t);
                    scan.sources.push(source);
                }
                Err(e) => scan.sources.push(format!("{source} (aviso: {e})")),
            }
        } else if name == "schema.prisma" || ext == "prisma" {
            let mut t = parse_prisma_tables(&content, &source);
            if t.is_empty() {
                scan.sources
                    .push(format!("{source} (aviso: sem blocos model)"));
            } else {
                *dialect_votes.entry("prisma").or_insert(0) += 1;
                scan.tables.append(&mut t);
                scan.sources.push(source);
            }
        } else {
            // ORM em código (ts/js/py/rb) — best-effort; só registra se bateu padrão.
            if let Some((mut t, kind)) = detect_orm_tables(&content, path, &source) {
                *dialect_votes.entry(kind).or_insert(0) += 1;
                scan.tables.append(&mut t);
                scan.sources.push(source);
            }
            // Sem padrão ORM → não é fonte de schema; não vira aviso (evita ruído).
        }
    }

    // Dialeto predominante (mais "votos").
    scan.dialect = dialect_votes
        .into_iter()
        .max_by_key(|(_, n)| *n)
        .map(|(k, _)| k.to_string());

    // Ordem determinística: por nome, depois por fonte.
    scan.tables
        .sort_by(|a, b| a.name.cmp(&b.name).then_with(|| a.source.cmp(&b.source)));

    scan
}

/// Monta o prompt PT-BR pedindo análise do SCHEMA (normalização, FK/índice
/// faltando, N+1 provável, tipos ruins) em JSON estrito (formato `AiReport`).
/// Serializa o schema detectado como contexto. NÃO chama LLM (testável puro).
pub fn build_db_prompt(scan: &DbScan) -> String {
    let mut p = String::new();
    p.push_str(
        "Você é o analista de saúde de banco de dados do OmniRift. Analise o SCHEMA \
         abaixo (extraído do repositório) e produza um relatório de qualidade: problemas \
         de normalização, chaves estrangeiras/índices faltando, prováveis N+1, tipos de \
         coluna ruins, ausência de PK e outros smells de modelagem.\n\n",
    );

    if let Some(d) = &scan.dialect {
        p.push_str(&format!("Dialeto/fonte predominante: {d}\n"));
    }
    p.push_str(&format!(
        "Tabelas detectadas: {} · fontes: {}\n\n",
        scan.tables.len(),
        scan.sources.len()
    ));

    p.push_str("Schema:\n");
    for t in &scan.tables {
        p.push_str(&format!("Tabela `{}` (de {})\n", t.name, t.source));
        if t.columns.is_empty() {
            p.push_str("  (colunas não detalhadas — fonte ORM)\n");
        }
        for c in &t.columns {
            let mut flags = Vec::new();
            if c.pk {
                flags.push("PK");
            }
            if c.fk {
                flags.push("FK");
            }
            if !c.nullable {
                flags.push("NOT NULL");
            }
            let flag_str = if flags.is_empty() {
                String::new()
            } else {
                format!(" [{}]", flags.join(", "))
            };
            p.push_str(&format!("  - {}: {}{}\n", c.name, c.type_, flag_str));
        }
        for idx in &t.indexes {
            p.push_str(&format!("  índice: {idx}\n"));
        }
    }

    p.push_str(
        "\nRESPONDA APENAS com um objeto JSON VÁLIDO (sem markdown, sem comentários, sem \
         texto antes ou depois), exatamente neste formato:\n\
         {\n\
         \x20 \"target\": \"<schema do repositório>\",\n\
         \x20 \"summary\": \"<1-3 frases sobre o estado do schema>\",\n\
         \x20 \"findings\": [\n\
         \x20\x20\x20 {\n\
         \x20\x20\x20\x20\x20 \"severity\": \"critical|warning|info\",\n\
         \x20\x20\x20\x20\x20 \"kind\": \"smell|refactor|risk|perf|security\",\n\
         \x20\x20\x20\x20\x20 \"title\": \"<título curto>\",\n\
         \x20\x20\x20\x20\x20 \"detail\": \"<o que é o problema>\",\n\
         \x20\x20\x20\x20\x20 \"suggestion\": \"<como corrigir>\"\n\
         \x20\x20\x20 }\n\
         \x20 ]\n\
         }\n\
         Se o schema estiver saudável, devolva findings vazio e diga no summary. \
         Seja específico e acionável.\n",
    );
    p
}

/// `db_scan_repo` — varre o repo procurando fontes de schema (SQL/migrations,
/// Prisma, ORM) e extrai tabelas/colunas/PK/FK/índices. Fail-soft: o que não
/// parsear vira aviso em `sources`, nunca quebra o scan.
#[tauri::command]
pub async fn db_scan_repo(root: String) -> Result<DbScan, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("raiz não é um diretório: {root}"));
    }
    // Scan é só FS + parse (síncrono/CPU): roda em blocking pool pra não segurar
    // a thread do runtime async em repo grande.
    let root_owned = root.clone();
    tauri::async_runtime::spawn_blocking(move || scan_db_dir(Path::new(&root_owned)))
        .await
        .map_err(|e| format!("falha ao varrer o repo: {e}"))
}

/// `health_analyze_db` — roda `db_scan_repo`, monta o prompt do schema e roda
/// pelo MESMO motor headless do `ai.rs`. Degrada limpo (sem CLI → `Err` amigável).
///
/// PERSISTE o resultado sob a key fixa `__db_repo__` (mesmo padrão de
/// `health_analyze_file`): marcador `.running` antes de spawnar, `<key>.json` ao
/// concluir, remoção do marcador em erro (sem órfão).
#[tauri::command]
pub async fn health_analyze_db(root: String) -> Result<AiReport, String> {
    let scan = db_scan_repo(root.clone()).await?;
    let prompt = build_db_prompt(&scan);
    let target = format!("schema:{root}");

    mark_db_running(&root);
    match run_agent_report(&prompt, &target).await {
        Ok(report) => {
            persist_db_report(&root, &report);
            Ok(report)
        }
        Err(e) => {
            clear_db_running(&root);
            Err(e)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    #[test]
    fn parses_create_table_sql() {
        let sql = "CREATE TABLE users (\n\
                   id SERIAL PRIMARY KEY,\n\
                   email VARCHAR(255) NOT NULL,\n\
                   org_id INTEGER REFERENCES orgs(id),\n\
                   bio TEXT\n\
                   );";
        let tables = parse_sql_tables(sql, "/x/mig.sql").unwrap();
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert_eq!(t.name, "users");
        assert_eq!(t.columns.len(), 4);

        let id = t.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.pk, "id deve ser PK");
        assert!(!id.nullable, "PK não é nullable");

        let email = t.columns.iter().find(|c| c.name == "email").unwrap();
        assert!(!email.nullable, "NOT NULL → não nullable");
        assert!(
            email.type_.to_uppercase().contains("VARCHAR"),
            "tipo VARCHAR, got {}",
            email.type_
        );

        let org = t.columns.iter().find(|c| c.name == "org_id").unwrap();
        assert!(org.fk, "REFERENCES → FK");

        let bio = t.columns.iter().find(|c| c.name == "bio").unwrap();
        assert!(bio.nullable, "sem NOT NULL → nullable");
    }

    #[test]
    fn parses_table_level_constraints() {
        let sql = "CREATE TABLE memberships (\n\
                   user_id INTEGER,\n\
                   team_id INTEGER,\n\
                   PRIMARY KEY (user_id, team_id),\n\
                   FOREIGN KEY (team_id) REFERENCES teams(id)\n\
                   );";
        let tables = parse_sql_tables(sql, "/x/m.sql").unwrap();
        let t = &tables[0];
        let user = t.columns.iter().find(|c| c.name == "user_id").unwrap();
        let team = t.columns.iter().find(|c| c.name == "team_id").unwrap();
        assert!(user.pk && team.pk, "PK composta marca ambas");
        assert!(!user.nullable && !team.nullable, "PK → not null");
        assert!(team.fk, "FK de tabela marca team_id");
    }

    #[test]
    fn parses_prisma_model() {
        let prisma = "datasource db { provider = \"postgresql\" }\n\
            model User {\n\
            \x20 id    Int     @id @default(autoincrement())\n\
            \x20 email String  @unique\n\
            \x20 name  String?\n\
            \x20 posts Post[]\n\
            \x20 org   Org     @relation(fields: [orgId], references: [id])\n\
            \x20 orgId Int\n\
            \x20 @@index([email])\n\
            }\n";
        let tables = parse_prisma_tables(prisma, "/x/schema.prisma");
        assert_eq!(tables.len(), 1);
        let t = &tables[0];
        assert_eq!(t.name, "User");

        let id = t.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.pk, "@id → PK");
        assert!(!id.nullable, "PK não nullable");
        assert_eq!(id.type_, "Int");

        let name = t.columns.iter().find(|c| c.name == "name").unwrap();
        assert!(name.nullable, "String? → nullable");

        let org = t.columns.iter().find(|c| c.name == "org").unwrap();
        assert!(org.fk, "@relation → FK");

        assert!(
            t.indexes.iter().any(|i| i.contains("@@index")),
            "@@index detectado: {:?}",
            t.indexes
        );
        assert!(
            t.indexes.iter().any(|i| i.contains("@unique")),
            "@unique vira índice"
        );
    }

    #[test]
    fn sql_fail_soft_on_garbage() {
        // Não é SQL parseável → Err (o chamador transforma em aviso, não pânico).
        assert!(parse_sql_tables("isso não é sql {{{ <<", "/x/bad.sql").is_err());
    }

    #[test]
    fn scan_finds_sql_and_prisma_respecting_gitignore() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // .gitignore esconde o dir `ignored/`.
        fs::write(root.join(".gitignore"), "ignored/\n").unwrap();

        // Migration .sql válida.
        fs::create_dir_all(root.join("migrations")).unwrap();
        fs::write(
            root.join("migrations").join("001_init.sql"),
            "CREATE TABLE products (id SERIAL PRIMARY KEY, sku TEXT NOT NULL);",
        )
        .unwrap();

        // schema.prisma válido.
        fs::create_dir_all(root.join("prisma")).unwrap();
        fs::write(
            root.join("prisma").join("schema.prisma"),
            "model Order {\n id Int @id\n total Int\n}\n",
        )
        .unwrap();

        // Migration ignorada pelo .gitignore.
        fs::create_dir_all(root.join("ignored")).unwrap();
        fs::write(
            root.join("ignored").join("secret.sql"),
            "CREATE TABLE should_not_appear (id INT);",
        )
        .unwrap();

        // SQL inválido → vira aviso em sources, não derruba o scan.
        fs::write(root.join("broken.sql"), "CREATE TABL oops (").unwrap();

        // node_modules sempre pulado.
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(
            root.join("node_modules").join("dep.sql"),
            "CREATE TABLE dep_table (id INT);",
        )
        .unwrap();

        let scan = scan_db_dir(root);
        let names: Vec<&str> = scan.tables.iter().map(|t| t.name.as_str()).collect();

        assert!(
            names.contains(&"products"),
            "SQL migration deve entrar: {names:?}"
        );
        assert!(names.contains(&"Order"), "Prisma model deve entrar: {names:?}");
        assert!(
            !names.contains(&"should_not_appear"),
            ".gitignore deve esconder a migration"
        );
        assert!(!names.contains(&"dep_table"), "node_modules sempre pulado");
        // Fail-soft: o SQL quebrado aparece como aviso, não como tabela.
        assert!(
            scan.sources
                .iter()
                .any(|s| s.contains("broken.sql") && s.contains("aviso")),
            "broken.sql vira aviso: {:?}",
            scan.sources
        );
        // products: PK + NOT NULL detectados.
        let prod = scan.tables.iter().find(|t| t.name == "products").unwrap();
        assert!(prod.columns.iter().any(|c| c.name == "id" && c.pk));
        assert!(prod.columns.iter().any(|c| c.name == "sku" && !c.nullable));
    }

    #[test]
    fn detects_orm_entity_without_inventing_columns() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(
            root.join("src").join("user.entity.ts"),
            "@Entity('users')\nexport class User {\n  @Column() name: string;\n}\n",
        )
        .unwrap();

        let scan = scan_db_dir(root);
        let t = scan
            .tables
            .iter()
            .find(|t| t.name == "users")
            .expect("entity TypeORM detectada");
        assert!(
            t.columns.is_empty(),
            "ORM best-effort não inventa colunas (só registra a fonte)"
        );
        assert_eq!(scan.dialect.as_deref(), Some("typeorm"));
    }

    #[test]
    fn build_db_prompt_includes_schema_and_json_schema() {
        let scan = DbScan {
            tables: vec![DbTable {
                name: "users".into(),
                columns: vec![
                    DbColumn {
                        name: "id".into(),
                        type_: "INTEGER".into(),
                        pk: true,
                        fk: false,
                        nullable: false,
                    },
                    DbColumn {
                        name: "org_id".into(),
                        type_: "INTEGER".into(),
                        pk: false,
                        fk: true,
                        nullable: true,
                    },
                ],
                indexes: vec!["CREATE INDEX idx_email ON users (email)".into()],
                source: "/x/mig.sql".into(),
            }],
            sources: vec!["/x/mig.sql".into()],
            dialect: Some("sql".into()),
        };
        let p = build_db_prompt(&scan);
        assert!(p.contains("users"), "tabela no prompt");
        assert!(p.contains("id: INTEGER"), "coluna+tipo no prompt");
        assert!(p.contains("PK"), "flag PK no prompt");
        assert!(p.contains("FK"), "flag FK no prompt");
        assert!(p.contains("CREATE INDEX"), "índice no prompt");
        assert!(p.contains("normaliza"), "pede análise de normalização");
        assert!(p.contains("JSON"), "pede JSON");
        assert!(p.contains("\"findings\""), "esquema com findings");
        assert!(p.contains("\"severity\""), "esquema com severity");
    }

    #[test]
    fn build_db_prompt_marks_orm_tables_without_columns() {
        let scan = DbScan {
            tables: vec![DbTable {
                name: "users".into(),
                columns: vec![],
                indexes: vec![],
                source: "/x/user.entity.ts".into(),
            }],
            sources: vec!["/x/user.entity.ts".into()],
            dialect: Some("typeorm".into()),
        };
        let p = build_db_prompt(&scan);
        assert!(p.contains("colunas não detalhadas"), "marca ORM sem colunas");
    }
}
