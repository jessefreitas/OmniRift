//! Query runner pro DB node (SQLite). Usa o rusqlite (já bundleado). SELECT/PRAGMA/
//! EXPLAIN/WITH devolvem colunas+linhas; o resto devolve nº de linhas afetadas.

use rusqlite::types::{Value, ValueRef};
use rusqlite::Connection;
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<String>>,
    pub row_count: usize,
    pub affected: Option<usize>,
    pub duration_ms: u64,
}

fn value_to_string(v: ValueRef<'_>) -> String {
    match v.into() {
        Value::Null => "NULL".to_string(),
        Value::Integer(i) => i.to_string(),
        Value::Real(f) => f.to_string(),
        Value::Text(s) => s,
        Value::Blob(b) => format!("<{} bytes>", b.len()),
    }
}

/// Roda uma query SQL num arquivo SQLite e devolve o resultado tabular.
#[tauri::command]
pub fn db_query(path: String, sql: String) -> Result<QueryResult, String> {
    let conn = Connection::open(&path).map_err(|e| format!("não consegui abrir '{path}': {e}"))?;
    let start = std::time::Instant::now();
    let head = sql.trim_start().to_lowercase();
    let is_read = head.starts_with("select")
        || head.starts_with("with")
        || head.starts_with("pragma")
        || head.starts_with("explain");

    if is_read {
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let columns: Vec<String> = stmt.column_names().iter().map(|s| s.to_string()).collect();
        let ncols = columns.len();
        let mut rows: Vec<Vec<String>> = Vec::new();
        let mut q = stmt.query([]).map_err(|e| e.to_string())?;
        while let Some(row) = q.next().map_err(|e| e.to_string())? {
            let mut vals = Vec::with_capacity(ncols);
            for i in 0..ncols {
                vals.push(value_to_string(row.get_ref(i).map_err(|e| e.to_string())?));
            }
            rows.push(vals);
        }
        let row_count = rows.len();
        Ok(QueryResult {
            columns,
            rows,
            row_count,
            affected: None,
            duration_ms: start.elapsed().as_millis() as u64,
        })
    } else {
        let affected = conn.execute(&sql, []).map_err(|e| e.to_string())?;
        Ok(QueryResult {
            columns: vec![],
            rows: vec![],
            row_count: 0,
            affected: Some(affected),
            duration_ms: start.elapsed().as_millis() as u64,
        })
    }
}
