//! Painel "Saúde do Projeto" (Fase C) — dimensão **Banco de Dados AO VIVO**.
//!
//! Introspecta um banco **REAL** a partir de uma connection string e devolve o
//! MESMO `DbScan { tables, sources, dialect }` da Fase B (`db.rs`) — o front
//! renderiza igual, venha do repo (estático) ou do banco ao vivo.
//!
//!   - **SQLite** (`rusqlite`, SÍNCRONO → roda em `spawn_blocking`): abre o
//!     arquivo, introspecta via `sqlite_master` + `PRAGMA table_info` (colunas,
//!     tipo, NOT NULL, PK) + `PRAGMA index_list` + `PRAGMA foreign_key_list`.
//!   - **Postgres** (`tokio-postgres`, ASSÍNCRONO): conecta (TLS rustls quando
//!     `sslmode`/cloud; `NoTls` no local com fallback automático), introspecta
//!     `information_schema` (schema `public`) + `table_constraints`/
//!     `key_column_usage` (PK/FK) + `pg_indexes`.
//!
//! Cap duro de tempo: `connect + introspect` é envolvido num `timeout(8s)`.
//!
//! `health_analyze_db_live(conn_str)`: introspecta → `build_db_prompt(&scan)` →
//! roda pelo MESMO motor headless do `ai.rs` (`run_agent_report`). Degrada igual
//! (sem CLI de agente → `Err` amigável).
//!
//! 🔒 **SEGURANÇA CRÍTICA**: a connection string carrega credenciais. Ela NUNCA
//! é logada (`println!`/`log::`) nem incluída em mensagens de erro — os erros são
//! genéricos ("falha ao conectar"/"falha ao introspectar"). Boundary: este módulo
//! só fala com o banco (introspecção read-only) + `ai.rs` (no analyze).

use std::sync::Arc;
use std::time::Duration;

use super::ai::{run_agent_report, AiReport};
use super::db::{DbColumn, DbScan, DbTable};

/// Teto duro: `connect + introspect` precisa completar dentro disso ou aborta.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(8);

/// Rótulo de fonte que o front exibe pra distinguir do scan estático do repo.
const LIVE_SOURCE: &str = "(ao vivo)";

/// Dialeto do banco AO VIVO, detectado puramente pelo scheme/forma da conn string.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dialect {
    Postgres,
    Sqlite,
}

impl Dialect {
    /// Rótulo curto (vai pro `DbScan.dialect`, igual à Fase B).
    fn label(self) -> &'static str {
        match self {
            Dialect::Postgres => "postgres",
            Dialect::Sqlite => "sqlite",
        }
    }

    /// Detecção PURA (testável sem servidor) pelo scheme/forma da conn string:
    ///   - `postgres://` / `postgresql://`               → Postgres
    ///   - `sqlite:` (prefixo) / caminho `.db`/`.sqlite` → Sqlite
    ///
    /// `None` quando não dá pra inferir com confiança (ex.: `mysql://`).
    pub fn detect(conn_str: &str) -> Option<Dialect> {
        let s = conn_str.trim();
        let lower = s.to_ascii_lowercase();

        if lower.starts_with("postgres://") || lower.starts_with("postgresql://") {
            return Some(Dialect::Postgres);
        }
        if lower.starts_with("sqlite:") || lower.starts_with("sqlite://") {
            return Some(Dialect::Sqlite);
        }
        // Sem scheme: trata por extensão de arquivo (caminho direto pro .db).
        if lower.ends_with(".db")
            || lower.ends_with(".sqlite")
            || lower.ends_with(".sqlite3")
            || lower.ends_with(".db3")
        {
            return Some(Dialect::Sqlite);
        }
        None
    }
}

/// Tira o prefixo `sqlite:`/`sqlite://` da conn string → caminho do arquivo.
/// `sqlite::memory:` e `:memory:` viram o banco em memória do SQLite.
fn sqlite_file_path(conn_str: &str) -> String {
    let s = conn_str.trim();
    let path = s
        .strip_prefix("sqlite://")
        .or_else(|| s.strip_prefix("sqlite:"))
        .unwrap_or(s);
    // Tira query string (`?mode=ro` etc.) se houver.
    let path = path.split('?').next().unwrap_or(path);
    path.to_string()
}

/// Heurística PURA: a conn string de Postgres pede TLS? (`sslmode=require/...`
/// ou host de provedor de nuvem conhecido). Local (`localhost`/`127.0.0.1` sem
/// `sslmode`) → começa em `NoTls`. Em qualquer caso há fallback no connect.
fn postgres_wants_tls(conn_str: &str) -> bool {
    let lower = conn_str.to_ascii_lowercase();
    if lower.contains("sslmode=disable") {
        return false;
    }
    if lower.contains("sslmode=require")
        || lower.contains("sslmode=verify-ca")
        || lower.contains("sslmode=verify-full")
        || lower.contains("sslmode=prefer")
    {
        return true;
    }
    // Provedores de nuvem comuns exigem TLS por padrão.
    const CLOUD_HOSTS: [&str; 7] = [
        "neon.tech",
        "supabase",
        "render.com",
        "amazonaws.com",
        "azure.com",
        "cockroachlabs.cloud",
        "pooler.",
    ];
    CLOUD_HOSTS.iter().any(|h| lower.contains(h))
}

// ─────────────────────────── SQLite (rusqlite, sync) ───────────────────────────

/// Introspecta um arquivo SQLite (SÍNCRONO → o chamador roda em `spawn_blocking`).
/// `sqlite_master` (tabelas de usuário) + `PRAGMA table_info`/`index_list`/
/// `foreign_key_list`. Erros são GENÉRICOS (nunca incluem `path`/conn string).
fn introspect_sqlite_blocking(file_path: &str) -> Result<DbScan, String> {
    use rusqlite::Connection;

    // Abre read-only-ish: abrir normal basta (só fazemos SELECT/PRAGMA).
    let conn = Connection::open(file_path).map_err(|_| "falha ao conectar".to_string())?;

    // Nomes das tabelas de usuário (pula tabelas internas `sqlite_*`).
    let table_names: Vec<String> = {
        let mut stmt = conn
            .prepare(
                "SELECT name FROM sqlite_master \
                 WHERE type = 'table' AND name NOT LIKE 'sqlite_%' \
                 ORDER BY name",
            )
            .map_err(|_| "falha ao introspectar".to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|_| "falha ao introspectar".to_string())?;
        rows.filter_map(Result::ok).collect()
    };

    let mut tables: Vec<DbTable> = Vec::with_capacity(table_names.len());

    for tname in &table_names {
        // FK: conjunto de colunas "from" que referenciam outra tabela.
        let fk_cols: std::collections::HashSet<String> = {
            let mut stmt = conn
                .prepare(&format!("PRAGMA foreign_key_list({})", quote_ident(tname)))
                .map_err(|_| "falha ao introspectar".to_string())?;
            // foreign_key_list cols: id, seq, table, from, to, on_update, on_delete, match
            let rows = stmt
                .query_map([], |r| r.get::<_, String>(3)) // "from"
                .map_err(|_| "falha ao introspectar".to_string())?;
            rows.filter_map(Result::ok).collect()
        };

        // Colunas: PRAGMA table_info → (cid, name, type, notnull, dflt_value, pk).
        let columns: Vec<DbColumn> = {
            let mut stmt = conn
                .prepare(&format!("PRAGMA table_info({})", quote_ident(tname)))
                .map_err(|_| "falha ao introspectar".to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let name: String = r.get(1)?;
                    let type_: String = r.get(2)?;
                    let notnull: i64 = r.get(3)?;
                    let pk: i64 = r.get(5)?;
                    Ok((name, type_, notnull, pk))
                })
                .map_err(|_| "falha ao introspectar".to_string())?;

            let mut cols = Vec::new();
            for row in rows {
                let (name, type_, notnull, pk) = row.map_err(|_| "falha ao introspectar".to_string())?;
                let is_pk = pk > 0;
                cols.push(DbColumn {
                    fk: fk_cols.contains(&name),
                    name,
                    type_,
                    pk: is_pk,
                    // PK ⇒ NOT NULL implícito; senão usa o flag `notnull`.
                    nullable: !is_pk && notnull == 0,
                });
            }
            cols
        };

        // Índices: PRAGMA index_list → (seq, name, unique, origin, partial).
        let indexes: Vec<String> = {
            let mut stmt = conn
                .prepare(&format!("PRAGMA index_list({})", quote_ident(tname)))
                .map_err(|_| "falha ao introspectar".to_string())?;
            let rows = stmt
                .query_map([], |r| {
                    let name: String = r.get(1)?;
                    let unique: i64 = r.get(2)?;
                    Ok((name, unique))
                })
                .map_err(|_| "falha ao introspectar".to_string())?;

            let mut idx = Vec::new();
            for row in rows {
                let (name, unique) = row.map_err(|_| "falha ao introspectar".to_string())?;
                idx.push(if unique != 0 {
                    format!("{name} (unique)")
                } else {
                    name
                });
            }
            idx
        };

        tables.push(DbTable {
            name: tname.clone(),
            columns,
            indexes,
            source: LIVE_SOURCE.to_string(),
        });
    }

    Ok(DbScan {
        tables,
        sources: vec![LIVE_SOURCE.to_string()],
        dialect: Some(Dialect::Sqlite.label().to_string()),
    })
}

/// Aspas em identificador SQLite (`"x""y"`) — evita quebra com nomes reservados.
fn quote_ident(name: &str) -> String {
    format!("\"{}\"", name.replace('"', "\"\""))
}

// ─────────────────────────── Postgres (tokio-postgres) ──────────────────────────

/// Verificador de certificado que ACEITA tudo (não valida a cadeia). Necessário
/// pra introspectar Postgres em nuvem sem arrastar um cert store no binário; é uma
/// ferramenta de diagnóstico read-only operada pelo próprio usuário com a conn
/// string dele. NÃO usar em código de produção que troque dados sensíveis.
#[derive(Debug)]
struct AcceptAllVerifier;

impl rustls::client::danger::ServerCertVerifier for AcceptAllVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &rustls::pki_types::CertificateDer<'_>,
        _intermediates: &[rustls::pki_types::CertificateDer<'_>],
        _server_name: &rustls::pki_types::ServerName<'_>,
        _ocsp_response: &[u8],
        _now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        Ok(rustls::client::danger::ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn verify_tls13_signature(
        &self,
        _message: &[u8],
        _cert: &rustls::pki_types::CertificateDer<'_>,
        _dss: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        Ok(rustls::client::danger::HandshakeSignatureValid::assertion())
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        use rustls::SignatureScheme::*;
        vec![
            ECDSA_NISTP384_SHA384,
            ECDSA_NISTP256_SHA256,
            RSA_PSS_SHA512,
            RSA_PSS_SHA384,
            RSA_PSS_SHA256,
            RSA_PKCS1_SHA512,
            RSA_PKCS1_SHA384,
            RSA_PKCS1_SHA256,
            ED25519,
        ]
    }
}

/// Monta o `MakeRustlsConnect` (TLS accept-all) pro tokio-postgres.
fn make_tls() -> tokio_postgres_rustls::MakeRustlsConnect {
    let config = rustls::ClientConfig::builder()
        .dangerous()
        .with_custom_certificate_verifier(Arc::new(AcceptAllVerifier))
        .with_no_client_auth();
    tokio_postgres_rustls::MakeRustlsConnect::new(config)
}

/// Conecta no Postgres com a estratégia TLS escolhida e roda a introspecção
/// inteira. A `connection` task é spawnada e dropada no fim (fecha o socket).
/// Erros GENÉRICOS (nunca incluem a conn string).
async fn introspect_postgres(conn_str: &str) -> Result<DbScan, String> {
    let wants_tls = postgres_wants_tls(conn_str);

    // Tenta a estratégia preferida; se o connect falhar, tenta a outra (NoTls↔TLS).
    let client = match connect_postgres(conn_str, wants_tls).await {
        Ok(c) => c,
        Err(_) => connect_postgres(conn_str, !wants_tls)
            .await
            .map_err(|_| "falha ao conectar".to_string())?,
    };

    introspect_postgres_with(&client).await
}

/// Faz UM connect (TLS ou NoTls) e devolve o `Client` já com a connection task
/// rodando em background (a task termina sozinha quando o `Client` é dropado).
async fn connect_postgres(
    conn_str: &str,
    use_tls: bool,
) -> Result<tokio_postgres::Client, ()> {
    if use_tls {
        let (client, connection) = tokio_postgres::connect(conn_str, make_tls())
            .await
            .map_err(|_| ())?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(client)
    } else {
        let (client, connection) = tokio_postgres::connect(conn_str, tokio_postgres::NoTls)
            .await
            .map_err(|_| ())?;
        tokio::spawn(async move {
            let _ = connection.await;
        });
        Ok(client)
    }
}

/// Introspecta o schema `public` de um `Client` já conectado: tabelas/colunas
/// (`information_schema`) + PK/FK (`table_constraints` ⨝ `key_column_usage`) +
/// índices (`pg_indexes`). Erros GENÉRICOS.
async fn introspect_postgres_with(client: &tokio_postgres::Client) -> Result<DbScan, String> {
    let map_err = |_| "falha ao introspectar".to_string();

    // Tabelas base do schema public (sem views).
    let table_rows = client
        .query(
            "SELECT table_name FROM information_schema.tables \
             WHERE table_schema = 'public' AND table_type = 'BASE TABLE' \
             ORDER BY table_name",
            &[],
        )
        .await
        .map_err(map_err)?;
    let table_names: Vec<String> = table_rows.iter().map(|r| r.get::<_, String>(0)).collect();

    // PK por tabela: column_name das constraints PRIMARY KEY.
    let pk_rows = client
        .query(
            "SELECT tc.table_name, kcu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'",
            &[],
        )
        .await
        .map_err(map_err)?;
    let mut pk_set: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for r in &pk_rows {
        pk_set.insert((r.get::<_, String>(0), r.get::<_, String>(1)));
    }

    // FK por tabela: column_name das constraints FOREIGN KEY.
    let fk_rows = client
        .query(
            "SELECT tc.table_name, kcu.column_name \
             FROM information_schema.table_constraints tc \
             JOIN information_schema.key_column_usage kcu \
               ON tc.constraint_name = kcu.constraint_name \
              AND tc.table_schema = kcu.table_schema \
             WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'",
            &[],
        )
        .await
        .map_err(map_err)?;
    let mut fk_set: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
    for r in &fk_rows {
        fk_set.insert((r.get::<_, String>(0), r.get::<_, String>(1)));
    }

    // Colunas de todas as tabelas (uma query só, ordenada).
    let col_rows = client
        .query(
            "SELECT table_name, column_name, data_type, is_nullable \
             FROM information_schema.columns \
             WHERE table_schema = 'public' \
             ORDER BY table_name, ordinal_position",
            &[],
        )
        .await
        .map_err(map_err)?;

    // Índices por tabela (texto do `indexdef`).
    let idx_rows = client
        .query(
            "SELECT tablename, indexname FROM pg_indexes WHERE schemaname = 'public' \
             ORDER BY tablename, indexname",
            &[],
        )
        .await
        .map_err(map_err)?;
    let mut idx_map: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
    for r in &idx_rows {
        let t: String = r.get(0);
        let n: String = r.get(1);
        idx_map.entry(t).or_default().push(n);
    }

    // Agrupa colunas por tabela, marcando PK/FK/nullable.
    let mut cols_map: std::collections::HashMap<String, Vec<DbColumn>> =
        std::collections::HashMap::new();
    for r in &col_rows {
        let tname: String = r.get(0);
        let cname: String = r.get(1);
        let dtype: String = r.get(2);
        let is_nullable: String = r.get(3); // "YES" | "NO"
        let key = (tname.clone(), cname.clone());
        let is_pk = pk_set.contains(&key);
        let is_fk = fk_set.contains(&key);
        cols_map.entry(tname).or_default().push(DbColumn {
            name: cname,
            type_: dtype,
            pk: is_pk,
            fk: is_fk,
            nullable: !is_pk && is_nullable.eq_ignore_ascii_case("YES"),
        });
    }

    let mut tables: Vec<DbTable> = Vec::with_capacity(table_names.len());
    for tname in &table_names {
        tables.push(DbTable {
            name: tname.clone(),
            columns: cols_map.remove(tname).unwrap_or_default(),
            indexes: idx_map.remove(tname).unwrap_or_default(),
            source: LIVE_SOURCE.to_string(),
        });
    }

    Ok(DbScan {
        tables,
        sources: vec![LIVE_SOURCE.to_string()],
        dialect: Some(Dialect::Postgres.label().to_string()),
    })
}

// ─────────────────────────────── Comandos Tauri ────────────────────────────────

/// `db_introspect` — introspecta um banco REAL pela connection string e devolve o
/// MESMO `DbScan` da Fase B. SQLite via `rusqlite` (em `spawn_blocking`), Postgres
/// via `tokio-postgres` (TLS rustls/NoTls com fallback). `connect + introspect`
/// tem cap de 8s. 🔒 A conn string NUNCA é logada nem aparece em erros.
#[tauri::command]
pub async fn db_introspect(conn_str: String) -> Result<DbScan, String> {
    let dialect = Dialect::detect(&conn_str)
        .ok_or_else(|| "connection string não reconhecida (use postgres:// ou sqlite:)".to_string())?;

    let fut = async move {
        match dialect {
            Dialect::Sqlite => {
                let file = sqlite_file_path(&conn_str);
                tauri::async_runtime::spawn_blocking(move || introspect_sqlite_blocking(&file))
                    .await
                    .map_err(|_| "falha ao introspectar".to_string())?
            }
            Dialect::Postgres => introspect_postgres(&conn_str).await,
        }
    };

    // Cap duro de tempo no connect + introspect inteiro.
    tokio::time::timeout(CONNECT_TIMEOUT, fut)
        .await
        .map_err(|_| "falha ao conectar".to_string())?
}

/// `health_analyze_db_live` — introspecta o banco AO VIVO, monta o prompt do
/// schema (`build_db_prompt`) e roda pelo MESMO motor headless do `ai.rs`. Degrada
/// limpo: sem CLI de agente no PATH → `Err` amigável. 🔒 Conn string nunca logada.
#[tauri::command]
pub async fn health_analyze_db_live(conn_str: String) -> Result<AiReport, String> {
    let scan = db_introspect(conn_str).await?;
    let prompt = super::db::build_db_prompt(&scan);
    let target = format!("banco ao vivo:{}", scan.dialect.as_deref().unwrap_or("?"));
    run_agent_report(&prompt, &target).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    // ── Detecção de dialeto (pura, sem servidor) ──────────────────────────────

    #[test]
    fn detect_postgres_schemes() {
        assert_eq!(
            Dialect::detect("postgres://u:p@host:5432/db"),
            Some(Dialect::Postgres)
        );
        assert_eq!(
            Dialect::detect("postgresql://u:p@host/db?sslmode=require"),
            Some(Dialect::Postgres)
        );
        // Case-insensitive.
        assert_eq!(
            Dialect::detect("POSTGRES://x"),
            Some(Dialect::Postgres)
        );
    }

    #[test]
    fn detect_sqlite_scheme_and_paths() {
        assert_eq!(Dialect::detect("sqlite:/tmp/x.db"), Some(Dialect::Sqlite));
        assert_eq!(
            Dialect::detect("sqlite:///abs/path/app.sqlite"),
            Some(Dialect::Sqlite)
        );
        assert_eq!(Dialect::detect("/var/data/app.db"), Some(Dialect::Sqlite));
        assert_eq!(Dialect::detect("./local.sqlite3"), Some(Dialect::Sqlite));
        assert_eq!(Dialect::detect("data.db3"), Some(Dialect::Sqlite));
    }

    #[test]
    fn detect_unknown_returns_none() {
        assert_eq!(Dialect::detect("mysql://u@host/db"), None);
        assert_eq!(Dialect::detect("redis://x"), None);
        assert_eq!(Dialect::detect("just a string"), None);
    }

    #[test]
    fn sqlite_file_path_strips_prefix_and_query() {
        assert_eq!(sqlite_file_path("sqlite:/tmp/x.db"), "/tmp/x.db");
        assert_eq!(sqlite_file_path("sqlite:///abs/app.db"), "/abs/app.db");
        assert_eq!(sqlite_file_path("sqlite:/tmp/x.db?mode=ro"), "/tmp/x.db");
        assert_eq!(sqlite_file_path("/plain/path.db"), "/plain/path.db");
    }

    #[test]
    fn postgres_tls_heuristic() {
        assert!(postgres_wants_tls("postgres://h/db?sslmode=require"));
        assert!(postgres_wants_tls("postgres://x.neon.tech/db"));
        assert!(!postgres_wants_tls("postgres://localhost:5432/db"));
        assert!(!postgres_wants_tls(
            "postgres://h/db?sslmode=disable"
        ));
    }

    // ── Introspecção SQLite round-trip (rusqlite, sem servidor) ───────────────

    #[test]
    fn sqlite_introspect_roundtrip_via_rusqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("live.db");
        let db_path_str = db_path.to_string_lossy().to_string();

        // Cria um schema real: PK, FK, NOT NULL, índice.
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch(
                "CREATE TABLE orgs (
                     id   INTEGER PRIMARY KEY,
                     name TEXT NOT NULL
                 );
                 CREATE TABLE users (
                     id     INTEGER PRIMARY KEY,
                     email  TEXT NOT NULL,
                     org_id INTEGER REFERENCES orgs(id),
                     bio    TEXT
                 );
                 CREATE INDEX idx_users_email ON users (email);
                 CREATE UNIQUE INDEX uq_users_email ON users (email);",
            )
            .unwrap();
        }

        // Introspecta via a função síncrona (o que o command roda em spawn_blocking).
        let scan = introspect_sqlite_blocking(&db_path_str).expect("introspect ok");

        assert_eq!(scan.dialect.as_deref(), Some("sqlite"));
        assert_eq!(scan.sources, vec!["(ao vivo)".to_string()]);

        let names: Vec<&str> = scan.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"orgs"), "tabela orgs: {names:?}");
        assert!(names.contains(&"users"), "tabela users: {names:?}");

        let users = scan.tables.iter().find(|t| t.name == "users").unwrap();

        // PK detectada + NOT NULL implícito.
        let id = users.columns.iter().find(|c| c.name == "id").unwrap();
        assert!(id.pk, "id é PK");
        assert!(!id.nullable, "PK não é nullable");

        // NOT NULL explícito.
        let email = users.columns.iter().find(|c| c.name == "email").unwrap();
        assert!(!email.nullable, "email NOT NULL");

        // FK detectada via foreign_key_list.
        let org = users.columns.iter().find(|c| c.name == "org_id").unwrap();
        assert!(org.fk, "org_id é FK");
        assert!(org.nullable, "org_id sem NOT NULL → nullable");

        // Coluna comum nullable.
        let bio = users.columns.iter().find(|c| c.name == "bio").unwrap();
        assert!(!bio.pk && !bio.fk && bio.nullable);

        // Tipo preservado (SQLite reporta o declarado).
        assert!(
            email.type_.to_uppercase().contains("TEXT"),
            "tipo TEXT, got {}",
            email.type_
        );

        // Índices detectados (o unique vem marcado).
        assert!(
            users.indexes.iter().any(|i| i.contains("idx_users_email")),
            "índice normal: {:?}",
            users.indexes
        );
        assert!(
            users
                .indexes
                .iter()
                .any(|i| i.contains("uq_users_email") && i.contains("unique")),
            "índice unique marcado: {:?}",
            users.indexes
        );

        // orgs: source ao vivo + PK.
        let orgs = scan.tables.iter().find(|t| t.name == "orgs").unwrap();
        assert_eq!(orgs.source, "(ao vivo)");
        assert!(orgs.columns.iter().any(|c| c.name == "id" && c.pk));
        assert!(orgs.columns.iter().any(|c| c.name == "name" && !c.nullable));
    }

    #[test]
    fn sqlite_skips_internal_tables() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("auto.db");
        let db_path_str = db_path.to_string_lossy().to_string();
        {
            let conn = Connection::open(&db_path).unwrap();
            // AUTOINCREMENT cria a tabela interna sqlite_sequence.
            conn.execute_batch(
                "CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, v TEXT);",
            )
            .unwrap();
        }
        let scan = introspect_sqlite_blocking(&db_path_str).unwrap();
        let names: Vec<&str> = scan.tables.iter().map(|t| t.name.as_str()).collect();
        assert!(names.contains(&"t"));
        assert!(
            !names.iter().any(|n| n.starts_with("sqlite_")),
            "tabelas sqlite_* internas são puladas: {names:?}"
        );
    }

    #[test]
    fn sqlite_introspect_missing_file_is_generic_error() {
        // Arquivo inexistente em dir inexistente → erro genérico (sem path vazado).
        let err = introspect_sqlite_blocking("/nonexistent/dir/nope.db").unwrap_err();
        assert!(
            err == "falha ao conectar" || err == "falha ao introspectar",
            "erro genérico, sem vazar path: {err:?}"
        );
        assert!(!err.contains("/nonexistent"), "erro NÃO vaza o caminho");
    }

    #[tokio::test]
    async fn db_introspect_command_roundtrip_sqlite() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("cmd.db");
        {
            let conn = Connection::open(&db_path).unwrap();
            conn.execute_batch("CREATE TABLE widgets (id INTEGER PRIMARY KEY, label TEXT NOT NULL);")
                .unwrap();
        }
        let conn_str = format!("sqlite:{}", db_path.to_string_lossy());
        let scan = db_introspect(conn_str).await.unwrap();
        assert_eq!(scan.dialect.as_deref(), Some("sqlite"));
        assert!(scan.tables.iter().any(|t| t.name == "widgets"));
    }

    #[tokio::test]
    async fn db_introspect_unknown_dialect_errs() {
        let err = db_introspect("mysql://u@h/db".to_string()).await.unwrap_err();
        assert!(err.contains("não reconhecida"), "erro de dialeto: {err}");
    }
}
