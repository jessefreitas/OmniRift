//! Biblioteca corporativa de serviços.
//!
//! O catálogo e os contratos ficam no SQLite do canal. Credenciais ficam somente no
//! keychain do SO. Agentes enxergam operações declaradas, nunca URLs arbitrárias ou
//! tokens. GETs podem ser automáticos; qualquer mutação passa por aprovação humana.

use crate::db::Db;
use anyhow::{anyhow, Context, Result};
use reqwest::{header::HeaderName, Method, Url};
use rusqlite::OptionalExtension;
use serde::{Deserialize, Serialize};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::str::FromStr;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::Manager;
use uuid::Uuid;

const MAX_RESPONSE_BYTES: u64 = 1_048_576;
/// Reuso de sessão MCP OmniMemory (evita initialize completo a cada get_secret).
const OMNI_MCP_SESSION_TTL: Duration = Duration::from_secs(10 * 60);
/// Cache em memória do segredo resolvido (nunca vai pro SQLite / log).
const OMNI_SECRET_CACHE_TTL: Duration = Duration::from_secs(5 * 60);
const ALLOWED_CATEGORIES: &[&str] = &[
    "payment",
    "consultation",
    "process",
    "proposal",
    "quote",
    "internal",
    "other",
];
const ALLOWED_AUTH: &[&str] = &["none", "bearer", "header"];
const ALLOWED_MODES: &[&str] = &["catalog", "auto", "approval"];

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ServiceOperation {
    pub id: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub method: String,
    pub path: String,
    #[serde(default = "empty_schema")]
    pub input_schema: Value,
    #[serde(default = "default_execution_mode")]
    pub execution_mode: String,
}

fn empty_schema() -> Value {
    json!({ "type": "object", "properties": {} })
}

fn default_execution_mode() -> String {
    "catalog".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceDefinition {
    pub id: String,
    pub name: String,
    pub category: String,
    #[serde(default)]
    pub description: String,
    pub base_url: String,
    pub auth_kind: String,
    #[serde(default)]
    pub auth_header: String,
    #[serde(default)]
    pub auth_prefix: String,
    /// Referência privada no cofre OmniMemory. Nunca entra no catálogo dos agentes.
    #[serde(default)]
    pub credential_project: String,
    #[serde(default)]
    pub credential_key: String,
    #[serde(default)]
    pub enabled: bool,
    #[serde(default)]
    pub operations: Vec<ServiceOperation>,
    #[serde(default, skip_deserializing)]
    pub has_credential: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRequest {
    pub id: String,
    pub service_id: String,
    pub service_name: String,
    pub operation_id: String,
    pub operation_name: String,
    pub input: Value,
    pub source: String,
    pub status: String,
    pub result_preview: Option<String>,
    pub created_at: String,
    pub decided_at: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceCallResult {
    pub request_id: String,
    pub status: String,
    pub http_status: Option<u16>,
    pub body: Option<Value>,
    pub duration_ms: Option<u128>,
}

pub fn ensure_schema(conn: &rusqlite::Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS company_services (
            id              TEXT PRIMARY KEY,
            name            TEXT NOT NULL,
            category        TEXT NOT NULL,
            description     TEXT NOT NULL DEFAULT '',
            base_url        TEXT NOT NULL,
            auth_kind       TEXT NOT NULL DEFAULT 'none',
            auth_header     TEXT NOT NULL DEFAULT '',
            auth_prefix     TEXT NOT NULL DEFAULT '',
            credential_project TEXT NOT NULL DEFAULT '',
            credential_key  TEXT NOT NULL DEFAULT '',
            enabled         INTEGER NOT NULL DEFAULT 0,
            operations_json TEXT NOT NULL DEFAULT '[]',
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        CREATE TABLE IF NOT EXISTS company_service_requests (
            id              TEXT PRIMARY KEY,
            service_id      TEXT NOT NULL,
            operation_id    TEXT NOT NULL,
            input_json      TEXT NOT NULL DEFAULT '{}',
            source          TEXT NOT NULL DEFAULT 'agent',
            status          TEXT NOT NULL DEFAULT 'pending',
            result_preview  TEXT,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            decided_at      TEXT,
            FOREIGN KEY(service_id) REFERENCES company_services(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_service_requests_status
            ON company_service_requests(status, created_at DESC);",
    )?;
    // Migração aditiva para bancos criados antes do suporte ao cofre OmniMemory.
    let columns = {
        let mut stmt = conn.prepare("PRAGMA table_info(company_services)")?;
        let rows = stmt.query_map([], |row| row.get::<_, String>(1))?;
        rows.collect::<rusqlite::Result<HashSet<_>>>()?
    };
    for (name, ddl) in [
        ("auth_prefix", "TEXT NOT NULL DEFAULT ''"),
        ("credential_project", "TEXT NOT NULL DEFAULT ''"),
        ("credential_key", "TEXT NOT NULL DEFAULT ''"),
    ] {
        if !columns.contains(name) {
            conn.execute(
                &format!("ALTER TABLE company_services ADD COLUMN {name} {ddl}"),
                [],
            )?;
        }
    }
    Ok(())
}

pub fn init(db: &Db) {
    if let Err(error) = db.with_conn(ensure_schema) {
        log::error!("falha criando schema da Biblioteca de Serviços: {error}");
    }
}

fn credential_account(id: &str) -> String {
    format!("company-service.{id}.credential")
}

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || matches!(c, '-' | '_'))
}

fn valid_credential_ref(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 160
        && value
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | ':' | '-'))
}

fn validate_base_url(raw: &str) -> Result<Url> {
    let url = Url::parse(raw.trim()).context("baseUrl inválida")?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(anyhow!("baseUrl deve usar http ou https"));
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err(anyhow!(
            "credenciais não podem ficar na baseUrl; use o keychain"
        ));
    }
    if url.query().is_some() || url.fragment().is_some() {
        return Err(anyhow!("baseUrl não pode conter query ou fragmento"));
    }
    Ok(url)
}

fn validate_header_name(name: &str) -> Result<()> {
    let parsed = HeaderName::from_str(name.trim())
        .map_err(|_| anyhow!("nome do header de autenticação inválido"))?;
    if matches!(parsed.as_str(), "host" | "content-length" | "connection") {
        return Err(anyhow!("header de autenticação não permitido"));
    }
    Ok(())
}

fn validate_operation(op: &mut ServiceOperation) -> Result<()> {
    op.id = op.id.trim().to_ascii_lowercase();
    op.name = op.name.trim().to_string();
    op.method = op.method.trim().to_ascii_uppercase();
    op.path = op.path.trim().to_string();
    op.execution_mode = op.execution_mode.trim().to_ascii_lowercase();

    if !valid_id(&op.id) {
        return Err(anyhow!("id de operação inválido: {}", op.id));
    }
    if op.name.is_empty() {
        return Err(anyhow!("operação {} precisa de nome", op.id));
    }
    if !matches!(
        op.method.as_str(),
        "GET" | "POST" | "PUT" | "PATCH" | "DELETE"
    ) {
        return Err(anyhow!("método não permitido em {}", op.id));
    }
    if op.path.is_empty()
        || op.path.contains("://")
        || op.path.contains("..")
        || op.path.contains('?')
        || op.path.contains('#')
    {
        return Err(anyhow!("path relativo inválido em {}", op.id));
    }
    if !ALLOWED_MODES.contains(&op.execution_mode.as_str()) {
        return Err(anyhow!("modo de execução inválido em {}", op.id));
    }
    if op.execution_mode == "auto" && op.method != "GET" {
        return Err(anyhow!(
            "somente GET pode ser automático; {} precisa de approval ou catalog",
            op.id
        ));
    }
    if !op.input_schema.is_object() {
        return Err(anyhow!("inputSchema de {} precisa ser objeto JSON", op.id));
    }
    Ok(())
}

pub fn validate_service(service: &mut ServiceDefinition) -> Result<()> {
    service.id = service.id.trim().to_ascii_lowercase();
    service.name = service.name.trim().to_string();
    service.category = service.category.trim().to_ascii_lowercase();
    service.base_url = service.base_url.trim().trim_end_matches('/').to_string();
    service.auth_kind = service.auth_kind.trim().to_ascii_lowercase();
    service.auth_header = service.auth_header.trim().to_string();
    service.credential_project = service.credential_project.trim().to_string();
    service.credential_key = service.credential_key.trim().to_string();

    if !valid_id(&service.id) {
        return Err(anyhow!(
            "id do serviço deve ser slug minúsculo (a-z, 0-9, - ou _)"
        ));
    }
    if service.name.is_empty() {
        return Err(anyhow!("nome do serviço é obrigatório"));
    }
    if !ALLOWED_CATEGORIES.contains(&service.category.as_str()) {
        return Err(anyhow!("categoria de serviço inválida"));
    }
    validate_base_url(&service.base_url)?;
    if !ALLOWED_AUTH.contains(&service.auth_kind.as_str()) {
        return Err(anyhow!("authKind inválido"));
    }
    if service.auth_kind == "header" {
        validate_header_name(&service.auth_header)?;
        if service.auth_prefix.len() > 64 || service.auth_prefix.contains(['\r', '\n']) {
            return Err(anyhow!("prefixo de autenticação inválido"));
        }
    } else if service.auth_kind == "bearer" {
        service.auth_header = "Authorization".into();
        service.auth_prefix.clear();
    } else {
        service.auth_header.clear();
        service.auth_prefix.clear();
        service.credential_project.clear();
        service.credential_key.clear();
    }
    if service.credential_project.is_empty() != service.credential_key.is_empty() {
        return Err(anyhow!(
            "credentialProject e credentialKey precisam ser informados juntos"
        ));
    }
    if !service.credential_project.is_empty()
        && (!valid_credential_ref(&service.credential_project)
            || !valid_credential_ref(&service.credential_key))
    {
        return Err(anyhow!("referência de credencial OmniMemory inválida"));
    }

    let mut ids = HashSet::new();
    for operation in &mut service.operations {
        validate_operation(operation)?;
        if !ids.insert(operation.id.clone()) {
            return Err(anyhow!("id de operação duplicado: {}", operation.id));
        }
    }
    Ok(())
}

pub fn upsert(
    db: &Db,
    mut service: ServiceDefinition,
    credential: Option<&str>,
) -> Result<ServiceDefinition> {
    validate_service(&mut service)?;
    if let Some(value) = credential.map(str::trim).filter(|v| !v.is_empty()) {
        if !crate::memory::secret_store::set(&credential_account(&service.id), value) {
            return Err(anyhow!("keychain indisponível; o serviço não foi alterado"));
        }
    }
    let operations_json = serde_json::to_string(&service.operations)?;
    db.with_conn(|conn| {
        ensure_schema(conn)?;
        conn.execute(
            "INSERT INTO company_services
                (id, name, category, description, base_url, auth_kind, auth_header,
                 auth_prefix, credential_project, credential_key, enabled, operations_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name, category=excluded.category, description=excluded.description,
                base_url=excluded.base_url, auth_kind=excluded.auth_kind,
                auth_header=excluded.auth_header, auth_prefix=excluded.auth_prefix,
                credential_project=excluded.credential_project,
                credential_key=excluded.credential_key, enabled=excluded.enabled,
                operations_json=excluded.operations_json, updated_at=datetime('now')",
            rusqlite::params![
                service.id,
                service.name,
                service.category,
                service.description,
                service.base_url,
                service.auth_kind,
                service.auth_header,
                service.auth_prefix,
                service.credential_project,
                service.credential_key,
                service.enabled as i64,
                operations_json,
            ],
        )?;
        Ok(())
    })?;

    service.has_credential = crate::memory::secret_store::get(&credential_account(&service.id))
        .is_some()
        || !service.credential_key.is_empty();
    Ok(service)
}

fn map_service(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServiceDefinition> {
    let operations_json: String = row.get(11)?;
    let id: String = row.get(0)?;
    let credential_project: String = row.get(8)?;
    let credential_key: String = row.get(9)?;
    Ok(ServiceDefinition {
        has_credential: crate::memory::secret_store::get(&credential_account(&id)).is_some()
            || !credential_key.is_empty(),
        id,
        name: row.get(1)?,
        category: row.get(2)?,
        description: row.get(3)?,
        base_url: row.get(4)?,
        auth_kind: row.get(5)?,
        auth_header: row.get(6)?,
        auth_prefix: row.get(7)?,
        credential_project,
        credential_key,
        enabled: row.get::<_, i64>(10)? != 0,
        operations: serde_json::from_str(&operations_json).unwrap_or_default(),
    })
}

pub fn list(db: &Db, enabled_only: bool) -> Result<Vec<ServiceDefinition>> {
    db.with_conn(|conn| {
        ensure_schema(conn)?;
        let sql = if enabled_only {
            "SELECT id,name,category,description,base_url,auth_kind,auth_header,auth_prefix,
                    credential_project,credential_key,enabled,operations_json
             FROM company_services WHERE enabled=1 ORDER BY category,name"
        } else {
            "SELECT id,name,category,description,base_url,auth_kind,auth_header,auth_prefix,
                    credential_project,credential_key,enabled,operations_json
             FROM company_services ORDER BY category,name"
        };
        let mut stmt = conn.prepare(sql)?;
        let rows = stmt.query_map([], map_service)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(Into::into)
}

pub fn get(db: &Db, id: &str) -> Result<Option<ServiceDefinition>> {
    db.with_conn(|conn| {
        ensure_schema(conn)?;
        conn.query_row(
            "SELECT id,name,category,description,base_url,auth_kind,auth_header,auth_prefix,
                    credential_project,credential_key,enabled,operations_json
             FROM company_services WHERE id=?1",
            [id],
            map_service,
        )
        .optional()
    })
    .map_err(Into::into)
}

pub fn delete(db: &Db, id: &str) -> Result<()> {
    db.with_conn(|conn| {
        ensure_schema(conn)?;
        conn.execute(
            "DELETE FROM company_service_requests WHERE service_id=?1",
            [id],
        )?;
        conn.execute("DELETE FROM company_services WHERE id=?1", [id])?;
        Ok(())
    })?;
    crate::memory::secret_store::delete(&credential_account(id));
    invalidate_omni_credential_caches();
    Ok(())
}

pub fn delete_credential(id: &str) {
    crate::memory::secret_store::delete(&credential_account(id));
    // Sem db aqui: invalida caches em memória (TTL curto; evita segredo/sessão stale).
    invalidate_omni_credential_caches();
}

fn map_request(row: &rusqlite::Row<'_>) -> rusqlite::Result<ServiceRequest> {
    let input_json: String = row.get(5)?;
    Ok(ServiceRequest {
        id: row.get(0)?,
        service_id: row.get(1)?,
        service_name: row.get(2)?,
        operation_id: row.get(3)?,
        operation_name: row.get(4)?,
        input: serde_json::from_str(&input_json).unwrap_or_else(|_| json!({})),
        source: row.get(6)?,
        status: row.get(7)?,
        result_preview: row.get(8)?,
        created_at: row.get(9)?,
        decided_at: row.get(10)?,
    })
}

pub fn requests(db: &Db, status: Option<&str>) -> Result<Vec<ServiceRequest>> {
    db.with_conn(|conn| {
        ensure_schema(conn)?;
        let mut stmt = conn.prepare(
            "SELECT r.id,r.service_id,s.name,r.operation_id,
                    COALESCE(json_extract(s.operations_json,
                        '$[' || (SELECT key FROM json_each(s.operations_json)
                                  WHERE json_extract(value,'$.id')=r.operation_id LIMIT 1) || '].name'),
                        r.operation_id),
                    r.input_json,r.source,r.status,r.result_preview,r.created_at,r.decided_at
               FROM company_service_requests r
               JOIN company_services s ON s.id=r.service_id
              WHERE (?1 IS NULL OR r.status=?1)
              ORDER BY r.created_at DESC LIMIT 200",
        )?;
        let rows = stmt.query_map([status], map_request)?;
        rows.collect::<rusqlite::Result<Vec<_>>>()
    })
    .map_err(Into::into)
}

fn insert_request(
    db: &Db,
    service_id: &str,
    operation_id: &str,
    input: &Value,
    source: &str,
    status: &str,
) -> Result<String> {
    let id = Uuid::new_v4().to_string();
    let input_json = serde_json::to_string(input)?;
    db.with_conn(|conn| {
        ensure_schema(conn)?;
        conn.execute(
            "INSERT INTO company_service_requests
                (id,service_id,operation_id,input_json,source,status)
             VALUES (?1,?2,?3,?4,?5,?6)",
            rusqlite::params![id, service_id, operation_id, input_json, source, status],
        )?;
        Ok(())
    })?;
    Ok(id)
}

fn update_request(db: &Db, id: &str, status: &str, preview: Option<&str>) -> Result<()> {
    db.with_conn(|conn| {
        conn.execute(
            "UPDATE company_service_requests
                SET status=?2,result_preview=?3,decided_at=datetime('now') WHERE id=?1",
            rusqlite::params![id, status, preview],
        )?;
        Ok(())
    })?;
    Ok(())
}

fn transition_request(db: &Db, id: &str, from: &str, to: &str) -> Result<bool> {
    db.with_conn(|conn| {
        let changed = conn.execute(
            "UPDATE company_service_requests
                SET status=?3,decided_at=datetime('now') WHERE id=?1 AND status=?2",
            rusqlite::params![id, from, to],
        )?;
        Ok(changed == 1)
    })
    .map_err(Into::into)
}

fn encode_segment(value: &str) -> String {
    let mut out = String::new();
    for byte in value.as_bytes() {
        if byte.is_ascii_alphanumeric() || matches!(*byte, b'-' | b'_' | b'.' | b'~') {
            out.push(*byte as char);
        } else {
            out.push_str(&format!("%{byte:02X}"));
        }
    }
    out
}

fn scalar_string(value: &Value) -> Result<String> {
    match value {
        Value::String(v) => Ok(v.clone()),
        Value::Number(v) => Ok(v.to_string()),
        Value::Bool(v) => Ok(v.to_string()),
        Value::Null => Ok(String::new()),
        _ => serde_json::to_string(value).map_err(Into::into),
    }
}

fn build_url(
    service: &ServiceDefinition,
    operation: &ServiceOperation,
    input: &mut Map<String, Value>,
) -> Result<Url> {
    let mut path = operation.path.clone();
    let keys: Vec<String> = input.keys().cloned().collect();
    for key in keys {
        let marker = format!("{{{key}}}");
        if path.contains(&marker) {
            let value = input.remove(&key).unwrap_or(Value::Null);
            path = path.replace(&marker, &encode_segment(&scalar_string(&value)?));
        }
    }
    if path.contains('{') || path.contains('}') {
        return Err(anyhow!("faltam parâmetros de path em {}", operation.path));
    }
    let raw = format!(
        "{}/{}",
        service.base_url.trim_end_matches('/'),
        path.trim_start_matches('/')
    );
    validate_base_url(&raw)
}

fn parse_mcp_payload(content_type: &str, body: &str) -> Result<Value> {
    if !content_type.contains("text/event-stream") {
        return serde_json::from_str(body).context("resposta JSON inválida do OmniMemory MCP");
    }
    let normalized = body.replace("\r\n", "\n");
    let mut last = None;
    for event in normalized.split("\n\n") {
        let data = event
            .lines()
            .filter_map(|line| line.strip_prefix("data:").map(str::trim_start))
            .collect::<Vec<_>>()
            .join("\n");
        if !data.is_empty() {
            last =
                Some(serde_json::from_str(&data).context("evento SSE inválido do OmniMemory MCP")?);
        }
    }
    last.ok_or_else(|| anyhow!("OmniMemory MCP respondeu sem evento JSON"))
}

async fn mcp_json_request(
    client: &reqwest::Client,
    endpoint: &str,
    token: &str,
    session_id: Option<&str>,
    body: &Value,
) -> Result<(Value, Option<String>)> {
    let mut request = client
        .post(endpoint)
        .bearer_auth(token)
        .header("Accept", "application/json, text/event-stream")
        .json(body);
    if let Some(session_id) = session_id {
        request = request.header("Mcp-Session-Id", session_id);
    }
    let response = request.send().await?;
    let status = response.status();
    let response_session = response
        .headers()
        .get("mcp-session-id")
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned);
    let content_type = response
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_owned();
    let text = response.text().await.unwrap_or_default();
    if !status.is_success() {
        // Nunca inclua o corpo: uma falha do cofre pode carregar dados sensíveis.
        return Err(anyhow!("OmniMemory MCP retornou HTTP {}", status.as_u16()));
    }
    Ok((parse_mcp_payload(&content_type, &text)?, response_session))
}

#[derive(Clone)]
struct CachedOmniMcpSession {
    endpoint: String,
    /// Fingerprint do token (não o segredo) — invalida a sessão se a conexão mudar.
    token_fp: u64,
    session_id: String,
    client: reqwest::Client,
    opened_at: Instant,
}

struct CachedSecret {
    value: String,
    stored_at: Instant,
}

fn omni_mcp_cache() -> &'static Mutex<Option<CachedOmniMcpSession>> {
    static CACHE: OnceLock<Mutex<Option<CachedOmniMcpSession>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(None))
}

fn omni_secret_cache() -> &'static Mutex<HashMap<String, CachedSecret>> {
    static CACHE: OnceLock<Mutex<HashMap<String, CachedSecret>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// Invalida sessão MCP reutilizada + secret cache em memória.
/// Chamar em `memory_connect` / `memory_set_active` (e qualquer troca de conexão ativa)
/// para não reaproveitar credencial/sessão stale após mudar provider/token/endpoint.
pub fn invalidate_omni_credential_caches() {
    if let Ok(mut guard) = omni_secret_cache().lock() {
        guard.clear();
    }
    if let Ok(mut guard) = omni_mcp_cache().lock() {
        *guard = None;
    }
}

fn token_fingerprint(token: &str) -> u64 {
    use std::hash::{Hash, Hasher};
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    token.hash(&mut hasher);
    hasher.finish()
}

fn secret_cache_key(endpoint: &str, token_fp: u64, project: &str, key: &str) -> String {
    // Inclui identidade da conexão: troca de endpoint/token não reaproveita segredo alheio.
    format!("{endpoint}\0{token_fp}\0{project}\0{key}")
}

fn secret_cache_get(endpoint: &str, token: &str, project: &str, key: &str) -> Option<String> {
    let mut guard = omni_secret_cache().lock().ok()?;
    let cache_key = secret_cache_key(endpoint, token_fingerprint(token), project, key);
    let Some(entry) = guard.get(&cache_key) else {
        return None;
    };
    if entry.stored_at.elapsed() > OMNI_SECRET_CACHE_TTL {
        guard.remove(&cache_key);
        return None;
    }
    Some(entry.value.clone())
}

fn secret_cache_put(endpoint: &str, token: &str, project: &str, key: &str, value: &str) {
    let Ok(mut guard) = omni_secret_cache().lock() else {
        return;
    };
    // Cap defensivo: evita crescer sem bound se muitas refs distintas forem usadas.
    if guard.len() > 64 {
        guard.retain(|_, entry| entry.stored_at.elapsed() <= OMNI_SECRET_CACHE_TTL);
        if guard.len() > 64 {
            guard.clear();
        }
    }
    guard.insert(
        secret_cache_key(endpoint, token_fingerprint(token), project, key),
        CachedSecret {
            value: value.to_owned(),
            stored_at: Instant::now(),
        },
    );
}

async fn open_omni_mcp_session(endpoint: &str, token: &str) -> Result<CachedOmniMcpSession> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let initialize = json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "initialize",
        "params": {
            "protocolVersion": "2025-03-26",
            "capabilities": {},
            "clientInfo": { "name": "omnirift-company-services", "version": env!("CARGO_PKG_VERSION") }
        }
    });
    let (_, session_id) = mcp_json_request(&client, endpoint, token, None, &initialize).await?;
    let session_id = session_id.ok_or_else(|| anyhow!("OmniMemory MCP não criou sessão"))?;
    let initialized = client
        .post(endpoint)
        .bearer_auth(token)
        .header("Accept", "application/json, text/event-stream")
        .header("Mcp-Session-Id", &session_id)
        .json(&json!({
            "jsonrpc": "2.0",
            "method": "notifications/initialized"
        }))
        .send()
        .await?;
    if !initialized.status().is_success() {
        return Err(anyhow!("OmniMemory MCP recusou a inicialização da sessão"));
    }
    Ok(CachedOmniMcpSession {
        endpoint: endpoint.to_owned(),
        token_fp: token_fingerprint(token),
        session_id,
        client,
        opened_at: Instant::now(),
    })
}

fn session_reusable(session: &CachedOmniMcpSession, endpoint: &str, token: &str) -> bool {
    session.endpoint == endpoint
        && session.token_fp == token_fingerprint(token)
        && session.opened_at.elapsed() <= OMNI_MCP_SESSION_TTL
}

async fn call_get_secret(
    session: &CachedOmniMcpSession,
    endpoint: &str,
    token: &str,
    project: &str,
    key: &str,
) -> Result<String> {
    let call = json!({
        "jsonrpc": "2.0",
        "id": 2,
        "method": "tools/call",
        "params": {
            "name": "get_secret",
            "arguments": { "project": project, "key": key }
        }
    });
    let (response, _) = mcp_json_request(
        &session.client,
        endpoint,
        token,
        Some(&session.session_id),
        &call,
    )
    .await?;
    secret_from_tool_response(&response)
}

fn secret_from_tool_response(response: &Value) -> Result<String> {
    if response
        .pointer("/result/isError")
        .and_then(Value::as_bool)
        .unwrap_or(false)
    {
        return Err(anyhow!("OmniMemory recusou a leitura da credencial"));
    }
    if let Some(value) = response
        .pointer("/result/structuredContent/result/value")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
    {
        return Ok(value.to_owned());
    }
    if let Some(blocks) = response
        .pointer("/result/content")
        .and_then(Value::as_array)
    {
        for block in blocks {
            let Some(text) = block.get("text").and_then(Value::as_str) else {
                continue;
            };
            let Ok(value) = serde_json::from_str::<Value>(text) else {
                continue;
            };
            if let Some(secret) = value
                .get("value")
                .and_then(Value::as_str)
                .filter(|secret| !secret.is_empty())
            {
                return Ok(secret.to_owned());
            }
        }
    }
    Err(anyhow!(
        "credencial não disponível no OmniMemory; verifique referência e capability"
    ))
}

async fn fetch_omnimemory_credential(
    registry: &crate::memory::MemoryRegistry,
    project: &str,
    key: &str,
) -> Result<String> {
    let cfg = registry.connection(crate::memory::ProviderKind::OmniMemory)?;
    let endpoint = cfg
        .endpoint
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("conexão OmniMemory sem endpoint"))?
        .to_owned();
    let token = cfg
        .token
        .as_deref()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| anyhow!("conexão OmniMemory sem token"))?
        .to_owned();

    if let Some(cached) = secret_cache_get(&endpoint, &token, project, key) {
        return Ok(cached);
    }

    // 1ª tentativa: reusar sessão MCP em cache (sem initialize).
    let reused = {
        let guard = omni_mcp_cache()
            .lock()
            .map_err(|_| anyhow!("cache MCP OmniMemory indisponível"))?;
        guard
            .as_ref()
            .filter(|session| session_reusable(session, &endpoint, &token))
            .cloned()
    };
    if let Some(session) = reused {
        match call_get_secret(&session, &endpoint, &token, project, key).await {
            Ok(secret) => {
                secret_cache_put(&endpoint, &token, project, key, &secret);
                return Ok(secret);
            }
            Err(_) => {
                // Sessão stale/recusada → invalida e abre de novo abaixo.
                if let Ok(mut guard) = omni_mcp_cache().lock() {
                    *guard = None;
                }
            }
        }
    }

    // initialize completo só quando não há sessão reutilizável.
    let session = open_omni_mcp_session(&endpoint, &token).await?;
    let secret = call_get_secret(&session, &endpoint, &token, project, key).await?;
    secret_cache_put(&endpoint, &token, project, key, &secret);
    if let Ok(mut guard) = omni_mcp_cache().lock() {
        *guard = Some(session);
    }
    Ok(secret)
}

async fn resolve_credential(
    service: &ServiceDefinition,
    registry: Option<&crate::memory::MemoryRegistry>,
) -> Result<Option<String>> {
    if service.auth_kind == "none" {
        return Ok(None);
    }
    // Keychain só para credencial EXPLICITAMENTE salva no serviço — nunca espelhar
    // get_secret do OmniMemory (rotação/troca de conexão ficariam pinadas).
    if let Some(secret) = crate::memory::secret_store::get(&credential_account(&service.id)) {
        return Ok(Some(secret));
    }
    if !service.credential_key.is_empty() {
        let registry = registry.ok_or_else(|| anyhow!("registry OmniMemory indisponível"))?;
        return fetch_omnimemory_credential(
            registry,
            &service.credential_project,
            &service.credential_key,
        )
        .await
        .map(Some);
    }
    Err(anyhow!("credencial ausente para {}", service.name))
}

async fn execute(
    service: &ServiceDefinition,
    operation: &ServiceOperation,
    input: Value,
    registry: Option<&crate::memory::MemoryRegistry>,
) -> Result<(u16, Value, u128)> {
    let mut object = input
        .as_object()
        .cloned()
        .ok_or_else(|| anyhow!("input precisa ser um objeto JSON"))?;
    let mut url = build_url(service, operation, &mut object)?;
    let method = Method::from_bytes(operation.method.as_bytes())?;
    if method == Method::GET {
        let mut query = url.query_pairs_mut();
        for (key, value) in &object {
            query.append_pair(key, &scalar_string(value)?);
        }
    }

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()?;
    let mut request = client
        .request(method.clone(), url)
        .header("Accept", "application/json");
    let credential = resolve_credential(service, registry).await?;
    if let Some(secret) = credential.as_deref() {
        request = match service.auth_kind.as_str() {
            "bearer" => request.bearer_auth(secret),
            "header" => request.header(
                HeaderName::from_str(&service.auth_header)?,
                format!("{}{}", service.auth_prefix, secret),
            ),
            _ => request,
        };
    }
    if method != Method::GET {
        request = request.json(&Value::Object(object));
    }

    let started = Instant::now();
    let response = request.send().await?;
    let status = response.status();
    if response.content_length().unwrap_or(0) > MAX_RESPONSE_BYTES {
        return Err(anyhow!("resposta excede 1 MiB"));
    }
    let bytes = response.bytes().await?;
    if bytes.len() as u64 > MAX_RESPONSE_BYTES {
        return Err(anyhow!("resposta excede 1 MiB"));
    }
    let mut text = String::from_utf8_lossy(&bytes).to_string();
    if let Some(secret) = credential.as_deref().filter(|v| !v.is_empty()) {
        text = text.replace(secret, "[REDACTED]");
    }
    let body = serde_json::from_str(&text).unwrap_or(Value::String(text));
    if !status.is_success() {
        return Err(anyhow!("HTTP {}: {}", status.as_u16(), body));
    }
    Ok((status.as_u16(), body, started.elapsed().as_millis()))
}

fn find_operation<'a>(
    service: &'a ServiceDefinition,
    operation_id: &str,
) -> Result<&'a ServiceOperation> {
    service
        .operations
        .iter()
        .find(|op| op.id == operation_id)
        .ok_or_else(|| anyhow!("operação não encontrada: {operation_id}"))
}

fn value_matches_type(value: &Value, expected: &str) -> bool {
    match expected {
        "string" => value.is_string(),
        "number" => value.is_number(),
        "integer" => value.as_i64().is_some() || value.as_u64().is_some(),
        "boolean" => value.is_boolean(),
        "object" => value.is_object(),
        "array" => value.is_array(),
        "null" => value.is_null(),
        _ => false,
    }
}

fn validate_input(operation: &ServiceOperation, input: &Value) -> Result<()> {
    let object = input
        .as_object()
        .ok_or_else(|| anyhow!("input precisa ser um objeto JSON"))?;
    let schema = operation
        .input_schema
        .as_object()
        .ok_or_else(|| anyhow!("inputSchema inválido em {}", operation.id))?;
    if let Some(required) = schema.get("required").and_then(Value::as_array) {
        for key in required.iter().filter_map(Value::as_str) {
            if !object.contains_key(key) || object.get(key).is_some_and(Value::is_null) {
                return Err(anyhow!("campo obrigatório ausente: {key}"));
            }
        }
    }
    if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
        for (key, value) in object {
            if let Some(expected) = properties
                .get(key)
                .and_then(Value::as_object)
                .and_then(|property| property.get("type"))
                .and_then(Value::as_str)
            {
                if !value_matches_type(value, expected) {
                    return Err(anyhow!("campo {key} deveria ser {expected}"));
                }
            } else if schema.get("additionalProperties") == Some(&Value::Bool(false)) {
                return Err(anyhow!("campo não declarado: {key}"));
            }
        }
    }
    Ok(())
}

pub async fn call(
    db: &Db,
    service_id: &str,
    operation_id: &str,
    input: Value,
    source: &str,
    registry: Option<&crate::memory::MemoryRegistry>,
) -> Result<ServiceCallResult> {
    let service =
        get(db, service_id)?.ok_or_else(|| anyhow!("serviço não encontrado: {service_id}"))?;
    if !service.enabled {
        return Err(anyhow!("serviço desabilitado: {}", service.name));
    }
    let operation = find_operation(&service, operation_id)?.clone();
    validate_input(&operation, &input)?;
    match operation.execution_mode.as_str() {
        "catalog" => Err(anyhow!(
            "operação disponível apenas para consulta do contrato"
        )),
        "approval" => {
            let id = insert_request(db, service_id, operation_id, &input, source, "pending")?;
            Ok(ServiceCallResult {
                request_id: id,
                status: "pending_approval".into(),
                http_status: None,
                body: None,
                duration_ms: None,
            })
        }
        "auto" => {
            let id = insert_request(db, service_id, operation_id, &input, source, "executing")?;
            match execute(&service, &operation, input, registry).await {
                Ok((http_status, body, duration_ms)) => {
                    let preview = serde_json::to_string(&body).unwrap_or_default();
                    update_request(
                        db,
                        &id,
                        "executed",
                        Some(&preview.chars().take(2000).collect::<String>()),
                    )?;
                    Ok(ServiceCallResult {
                        request_id: id,
                        status: "executed".into(),
                        http_status: Some(http_status),
                        body: Some(body),
                        duration_ms: Some(duration_ms),
                    })
                }
                Err(error) => {
                    update_request(db, &id, "failed", Some(&error.to_string()))?;
                    Err(error)
                }
            }
        }
        _ => Err(anyhow!("modo de execução inválido")),
    }
}

pub async fn decide(
    db: &Db,
    request_id: &str,
    approve: bool,
    registry: Option<&crate::memory::MemoryRegistry>,
) -> Result<ServiceCallResult> {
    let request = requests(db, None)?
        .into_iter()
        .find(|item| item.id == request_id)
        .ok_or_else(|| anyhow!("solicitação não encontrada"))?;
    if request.status != "pending" {
        return Err(anyhow!("solicitação já decidida: {}", request.status));
    }
    if !approve {
        if !transition_request(db, request_id, "pending", "denied")? {
            return Err(anyhow!("solicitação já foi decidida por outra ação"));
        }
        return Ok(ServiceCallResult {
            request_id: request_id.into(),
            status: "denied".into(),
            http_status: None,
            body: None,
            duration_ms: None,
        });
    }

    if !transition_request(db, request_id, "pending", "executing")? {
        return Err(anyhow!("solicitação já foi decidida por outra ação"));
    }
    let service = get(db, &request.service_id)?.ok_or_else(|| anyhow!("serviço não encontrado"))?;
    let operation = find_operation(&service, &request.operation_id)?.clone();
    match execute(&service, &operation, request.input, registry).await {
        Ok((http_status, body, duration_ms)) => {
            let preview = serde_json::to_string(&body).unwrap_or_default();
            update_request(
                db,
                request_id,
                "executed",
                Some(&preview.chars().take(2000).collect::<String>()),
            )?;
            Ok(ServiceCallResult {
                request_id: request_id.into(),
                status: "executed".into(),
                http_status: Some(http_status),
                body: Some(body),
                duration_ms: Some(duration_ms),
            })
        }
        Err(error) => {
            update_request(db, request_id, "failed", Some(&error.to_string()))?;
            Err(error)
        }
    }
}

pub fn catalog_for_agents(db: &Db) -> Result<Value> {
    let services = list(db, true)?;
    Ok(json!({
        "services": services.into_iter().map(|service| json!({
            "id": service.id,
            "name": service.name,
            "category": service.category,
            "description": service.description,
            "operations": service.operations,
        })).collect::<Vec<_>>()
    }))
}

pub fn mcp_tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "services_catalog",
            "description": "Lista a Biblioteca de Serviços da empresa: pagamentos, consultas, processos, propostas, orçamentos e sistemas internos. Mostra somente contratos e modos de execução; credenciais nunca são expostas.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "category": {
                        "type": "string",
                        "enum": ["payment", "consultation", "process", "proposal", "quote", "internal", "other"]
                    }
                }
            }
        }),
        json!({
            "name": "services_call",
            "description": "Solicita uma operação declarada da Biblioteca de Serviços. GET auto pode executar; pagamentos e mutações viram pedido de aprovação humana no OmniRift. Nunca aceita URL ou credencial arbitrária.",
            "inputSchema": {
                "type": "object",
                "properties": {
                    "service": { "type": "string", "description": "id do serviço (use services_catalog)" },
                    "operation": { "type": "string", "description": "id da operação declarada" },
                    "input": { "type": "object", "description": "payload conforme inputSchema da operação" }
                },
                "required": ["service", "operation"]
            }
        }),
    ]
}

pub async fn mcp_dispatch(state: &crate::mcp::server::McpState, tool: &str, args: Value) -> String {
    let db = state.app.state::<Db>();
    match tool {
        "services_catalog" => {
            let category = args
                .get("category")
                .and_then(Value::as_str)
                .filter(|v| !v.is_empty());
            match catalog_for_agents(&db) {
                Ok(mut catalog) => {
                    if let Some(category) = category {
                        if let Some(items) =
                            catalog.get_mut("services").and_then(Value::as_array_mut)
                        {
                            items.retain(|item| {
                                item.get("category").and_then(Value::as_str) == Some(category)
                            });
                        }
                    }
                    serde_json::to_string_pretty(&catalog)
                        .unwrap_or_else(|_| "{\"services\":[]}".into())
                }
                Err(error) => format!("❌ {error:#}"),
            }
        }
        "services_call" => {
            let service = args.get("service").and_then(Value::as_str).unwrap_or("");
            let operation = args.get("operation").and_then(Value::as_str).unwrap_or("");
            let input = args.get("input").cloned().unwrap_or_else(|| json!({}));
            if service.is_empty() || operation.is_empty() {
                return "❌ 'service' e 'operation' são obrigatórios".into();
            }
            match call(
                &db,
                service,
                operation,
                input,
                "agent",
                Some(state.memory_registry.as_ref()),
            )
            .await
            {
                Ok(result) => serde_json::to_string_pretty(&result).unwrap_or_else(|_| "{}".into()),
                Err(error) => format!("❌ {error:#}"),
            }
        }
        _ => format!("❌ tool de serviço desconhecida: {tool}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn service(method: &str, mode: &str) -> ServiceDefinition {
        ServiceDefinition {
            id: "consulta-cnpj".into(),
            name: "Consulta CNPJ".into(),
            category: "consultation".into(),
            description: "Cadastro empresarial".into(),
            base_url: "https://example.com/api".into(),
            auth_kind: "header".into(),
            auth_header: "X-Api-Key".into(),
            auth_prefix: String::new(),
            credential_project: String::new(),
            credential_key: String::new(),
            enabled: true,
            operations: vec![ServiceOperation {
                id: "buscar".into(),
                name: "Buscar".into(),
                description: String::new(),
                method: method.into(),
                path: "/companies/{cnpj}".into(),
                input_schema: empty_schema(),
                execution_mode: mode.into(),
            }],
            has_credential: false,
        }
    }

    #[test]
    fn validates_safe_read_service() {
        let mut item = service("GET", "auto");
        validate_service(&mut item).unwrap();
        assert_eq!(item.auth_header, "X-Api-Key");
    }

    #[test]
    fn blocks_automatic_mutation() {
        let mut item = service("POST", "auto");
        let error = validate_service(&mut item).unwrap_err().to_string();
        assert!(error.contains("somente GET"));
    }

    #[test]
    fn blocks_credentials_inside_url() {
        let mut item = service("GET", "catalog");
        item.base_url = "https://user:secret@example.com".into();
        assert!(validate_service(&mut item).is_err());
    }

    #[test]
    fn builds_path_without_allowing_url_override() {
        let item = service("GET", "auto");
        let op = item.operations[0].clone();
        let mut input = json!({ "cnpj": "12/34", "active": true })
            .as_object()
            .unwrap()
            .clone();
        let url = build_url(&item, &op, &mut input).unwrap();
        assert_eq!(url.as_str(), "https://example.com/api/companies/12%2F34");
        assert_eq!(input.get("active"), Some(&Value::Bool(true)));
    }

    #[test]
    fn validates_declared_input_contract() {
        let mut item = service("GET", "auto");
        item.operations[0].input_schema = json!({
            "type": "object",
            "properties": { "cnpj": { "type": "string" } },
            "required": ["cnpj"],
            "additionalProperties": false
        });
        let operation = &item.operations[0];
        assert!(validate_input(operation, &json!({ "cnpj": "123" })).is_ok());
        assert!(validate_input(operation, &json!({ "extra": true })).is_err());
        assert!(validate_input(operation, &json!({ "cnpj": 123 })).is_err());
    }

    #[tokio::test]
    async fn approval_is_decided_only_once() {
        let db = Db::open_in_memory().unwrap();
        let mut item = service("POST", "approval");
        item.auth_kind = "none".into();
        item.auth_header.clear();
        upsert(&db, item, None).unwrap();
        let queued = call(&db, "consulta-cnpj", "buscar", json!({}), "test", None)
            .await
            .unwrap();
        assert_eq!(queued.status, "pending_approval");
        let denied = decide(&db, &queued.request_id, false, None).await.unwrap();
        assert_eq!(denied.status, "denied");
        assert!(decide(&db, &queued.request_id, false, None).await.is_err());
    }

    #[test]
    fn parses_sse_secret_without_exposing_other_fields() {
        let body = concat!(
            "event: message\r\n",
            "data: {\"jsonrpc\":\"2.0\",\"id\":2,\"result\":{",
            "\"structuredContent\":{\"result\":{\"value\":\"fixture-secret\"}},",
            "\"isError\":false}}\r\n\r\n"
        );
        let value = parse_mcp_payload("text/event-stream", body).unwrap();
        assert_eq!(secret_from_tool_response(&value).unwrap(), "fixture-secret");
    }

    #[test]
    fn validates_complete_omnimemory_reference() {
        let mut item = service("GET", "auto");
        item.credential_project = "claude-memory".into();
        item.credential_key = "credential.example.api_token".into();
        validate_service(&mut item).unwrap();
        item.credential_key.clear();
        assert!(validate_service(&mut item).is_err());
    }

    #[test]
    fn preserves_auth_prefix_spacing() {
        let mut item = service("GET", "auto");
        item.auth_prefix = "token ".into();
        validate_service(&mut item).unwrap();
        assert_eq!(item.auth_prefix, "token ");
    }

    #[test]
    fn secret_cache_roundtrip_without_logging_value_in_key() {
        let endpoint = "https://memory.example/mcp";
        let token = "tok-cache-a";
        let project = "proj-cache-test";
        let key = "credential.cache.roundtrip";
        secret_cache_put(endpoint, token, project, key, "fixture-secret-value");
        assert_eq!(
            secret_cache_get(endpoint, token, project, key).as_deref(),
            Some("fixture-secret-value")
        );
        // Outra conexão (token diferente) NÃO reaproveita o segredo.
        assert!(secret_cache_get(endpoint, "tok-cache-b", project, key).is_none());
        let cache_key = secret_cache_key(endpoint, token_fingerprint(token), project, key);
        assert!(!cache_key.contains("fixture-secret-value"));
        assert!(!cache_key.contains(token));
    }

    #[test]
    fn invalidate_omni_credential_caches_drops_secret_and_session() {
        let endpoint = "https://memory.example/mcp";
        let token = "tok-invalidate";
        let project = "proj-invalidate";
        let key = "credential.cache.invalidate";
        secret_cache_put(endpoint, token, project, key, "stale-secret");
        {
            let mut guard = omni_mcp_cache().lock().expect("mcp cache lock");
            *guard = Some(CachedOmniMcpSession {
                endpoint: endpoint.into(),
                token_fp: token_fingerprint(token),
                session_id: "sess-stale".into(),
                client: reqwest::Client::new(),
                opened_at: Instant::now(),
            });
        }
        assert!(secret_cache_get(endpoint, token, project, key).is_some());
        assert!(omni_mcp_cache().lock().unwrap().is_some());

        invalidate_omni_credential_caches();

        // Próxima resolve não dá hit stale.
        assert!(secret_cache_get(endpoint, token, project, key).is_none());
        assert!(omni_mcp_cache().lock().unwrap().is_none());
    }

    #[test]
    fn mcp_session_reusable_checks_endpoint_token_and_ttl() {
        let client = reqwest::Client::new();
        let session = CachedOmniMcpSession {
            endpoint: "https://memory.example/mcp".into(),
            token_fp: token_fingerprint("tok-a"),
            session_id: "sess-1".into(),
            client,
            opened_at: Instant::now(),
        };
        assert!(session_reusable(
            &session,
            "https://memory.example/mcp",
            "tok-a"
        ));
        assert!(!session_reusable(
            &session,
            "https://memory.example/mcp",
            "tok-b"
        ));
        assert!(!session_reusable(
            &session,
            "https://other.example/mcp",
            "tok-a"
        ));
    }

    #[tokio::test]
    async fn resolves_real_omnimemory_reference_when_env_is_present() {
        let (Ok(endpoint), Ok(token), Ok(project), Ok(key)) = (
            std::env::var("OMNIRIFT_TEST_MEMORY_ENDPOINT"),
            std::env::var("OMNIRIFT_TEST_MEMORY_TOKEN"),
            std::env::var("OMNIRIFT_TEST_SECRET_PROJECT"),
            std::env::var("OMNIRIFT_TEST_SECRET_KEY"),
        ) else {
            return;
        };
        std::env::set_var("OMNIRIFT_NO_KEYCHAIN", "1");
        let dir = tempfile::tempdir().unwrap();
        let db = std::sync::Arc::new(Db::open(dir.path()).unwrap());
        let registry = crate::memory::MemoryRegistry::new(db);
        registry
            .upsert_connection(crate::memory::ConnectionConfig {
                kind: crate::memory::ProviderKind::OmniMemory,
                endpoint: Some(endpoint),
                token: Some(token),
            })
            .unwrap();
        let value = fetch_omnimemory_credential(&registry, &project, &key)
            .await
            .unwrap();
        assert!(!value.is_empty());
    }
}
