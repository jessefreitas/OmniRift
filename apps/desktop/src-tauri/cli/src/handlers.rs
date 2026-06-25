//! Camada **handlers** — porta dos handlers puros do ref (RE 05 §2.2). Cada comando
//! tem um handler `(args) -> params` (monta o `params` JSON das flags/posicionais) e um
//! formatador `(result, json) -> String` (texto humano ou JSON cru). O `main` cola:
//! valida → monta params → `client::call` → formata.
//!
//! "Puro" = sem socket nem IO: build de params e format de result são funções de
//! dados → dados, 100% testáveis. O único efeito (a chamada de socket) mora no `client`.

use crate::client::ClientError;
use crate::specs::{ArgError, ParsedArgs};
use serde_json::{json, Value};

/// Plano de uma chamada: o método RPC + os params montados das flags. O `main` usa isto
/// pra `client::call(plan.method, plan.params)` e depois formata com `format_result`.
#[derive(Debug, Clone, PartialEq)]
pub struct CallPlan {
    pub method: &'static str,
    pub params: Value,
}

/// Monta o `CallPlan` (método + params) a partir do comando já validado. Erros aqui são
/// de **argumento** (ex.: `--rows` não é número) → `ArgError`, distinto de erro de
/// runtime. Puro: não toca em socket.
pub fn build_call(command: &str, args: &ParsedArgs) -> Result<CallPlan, ArgError> {
    match command {
        "status" => Ok(CallPlan { method: "status", params: Value::Null }),
        "agents" => Ok(CallPlan { method: "agents.list", params: Value::Null }),
        "snapshot" => build_snapshot(args),
        other => Err(ArgError(format!("sem handler para '{other}' (bug de wiring)"))),
    }
}

/// `snapshot <sessionId> [--rows N]` → params `{sessionId, rows?}` (o contrato do
/// `pty.snapshot` do #8A). `--rows` precisa ser inteiro positivo.
fn build_snapshot(args: &ParsedArgs) -> Result<CallPlan, ArgError> {
    let session_id = args
        .positionals
        .first()
        .ok_or_else(|| ArgError("snapshot exige <sessionId>".into()))?;
    let mut params = json!({ "sessionId": session_id });
    if let Some(rows_raw) = args.flag_str("rows") {
        let rows: u64 = rows_raw
            .parse()
            .map_err(|_| ArgError(format!("--rows precisa ser um inteiro: '{rows_raw}'")))?;
        params["rows"] = json!(rows);
    }
    Ok(CallPlan { method: "pty.snapshot", params })
}

/// Formata o `result` de um comando: `--json` → JSON cru (pretty); senão, texto humano
/// por comando. Puro: result + flag → string.
pub fn format_result(command: &str, result: &Value, json: bool) -> String {
    if json {
        return serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string());
    }
    match command {
        "status" => format_status(result),
        "agents" => format_agents(result),
        "snapshot" => format_snapshot(result),
        // Comando sem formatador humano dedicado → JSON pretty (degrade seguro).
        _ => serde_json::to_string_pretty(result).unwrap_or_else(|_| result.to_string()),
    }
}

fn format_status(r: &Value) -> String {
    let version = r.get("version").and_then(|v| v.as_str()).unwrap_or("?");
    let agents = r.get("agents").and_then(|v| v.as_u64()).unwrap_or(0);
    let floors = r.get("floors").and_then(|v| v.as_u64()).unwrap_or(0);
    format!("OmniRift v{version}\n  agentes: {agents}\n  floors:  {floors}")
}

fn format_agents(r: &Value) -> String {
    let Some(list) = r.get("agents").and_then(|v| v.as_array()) else {
        return "nenhum agente (resposta sem 'agents')".into();
    };
    if list.is_empty() {
        return "nenhum agente ativo".into();
    }
    let mut out = format!("{} agente(s):\n", list.len());
    for a in list {
        let label = a.get("label").and_then(|v| v.as_str()).unwrap_or("?");
        let session = a.get("sessionId").and_then(|v| v.as_str()).unwrap_or("?");
        let state = a
            .get("state")
            .and_then(|v| v.as_str())
            .unwrap_or("desconhecido");
        let floor = a.get("floor").and_then(|v| v.as_str());
        let floor_str = floor.map(|f| format!(" @{f}")).unwrap_or_default();
        out.push_str(&format!("  • {label}  [{state}]  ({session}){floor_str}\n"));
    }
    out.trim_end().to_string()
}

fn format_snapshot(r: &Value) -> String {
    // O snapshot do #6 é `{data, cols, rows, seq}`. Em texto, imprime só o `data`
    // (a tela renderizada); o resto vai no `--json`.
    match r.get("data").and_then(|v| v.as_str()) {
        Some(data) => data.to_string(),
        None => serde_json::to_string_pretty(r).unwrap_or_else(|_| r.to_string()),
    }
}

/// Formata um `ClientError` de runtime numa linha amigável pro stderr (o `main` já
/// imprime o `Display` do erro; este helper existe pra testes de contrato da mensagem
/// e pra fase 2 quando o render de erro divergir do `Display`).
#[allow(dead_code)] // usado nos testes; parte da superfície pública dos handlers.
pub fn describe_runtime_error(err: &ClientError) -> String {
    err.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::specs::{parse_args, validate};

    fn parse(tokens: &[&str]) -> ParsedArgs {
        let v: Vec<String> = tokens.iter().map(|s| s.to_string()).collect();
        let p = parse_args(&v).unwrap();
        validate(&p).unwrap();
        p
    }

    // --- build_call: monta os params certos por comando ---
    #[test]
    fn status_has_null_params() {
        let plan = build_call("status", &parse(&["status"])).unwrap();
        assert_eq!(plan.method, "status");
        assert_eq!(plan.params, Value::Null);
    }

    #[test]
    fn agents_maps_to_agents_list() {
        let plan = build_call("agents", &parse(&["agents"])).unwrap();
        assert_eq!(plan.method, "agents.list");
    }

    #[test]
    fn snapshot_builds_session_id_param() {
        let plan = build_call("snapshot", &parse(&["snapshot", "sess9"])).unwrap();
        assert_eq!(plan.method, "pty.snapshot");
        assert_eq!(plan.params, json!({ "sessionId": "sess9" }));
    }

    #[test]
    fn snapshot_with_rows_adds_rows_param() {
        let plan = build_call("snapshot", &parse(&["snapshot", "s", "--rows", "40"])).unwrap();
        assert_eq!(plan.params, json!({ "sessionId": "s", "rows": 40 }));
    }

    #[test]
    fn snapshot_rejects_non_numeric_rows() {
        // parse aceita string; build_call rejeita.
        let p = parse_args(&["snapshot".into(), "s".into(), "--rows".into(), "abc".into()]).unwrap();
        validate(&p).unwrap();
        let err = build_call("snapshot", &p).unwrap_err();
        assert!(err.0.contains("inteiro"), "msg: {}", err.0);
    }

    // --- format_result: humano vs json ---
    #[test]
    fn json_flag_returns_raw_pretty() {
        let r = json!({ "version": "0.1.34", "agents": 2 });
        let out = format_result("status", &r, true);
        assert!(out.contains("\"version\""));
        assert!(out.contains("0.1.34"));
    }

    #[test]
    fn status_human_format() {
        let r = json!({ "version": "0.1.34", "agents": 2, "floors": 1 });
        let out = format_result("status", &r, false);
        assert!(out.contains("v0.1.34"));
        assert!(out.contains("agentes: 2"));
        assert!(out.contains("floors:  1"));
    }

    #[test]
    fn agents_human_format_lists_each() {
        let r = json!({ "agents": [
            { "label": "alpha", "sessionId": "s1", "state": "working", "floor": "main" },
            { "label": "beta",  "sessionId": "s2", "state": "idle" }
        ]});
        let out = format_result("agents", &r, false);
        assert!(out.contains("alpha"));
        assert!(out.contains("[working]"));
        assert!(out.contains("@main"));
        assert!(out.contains("beta"));
        assert!(out.contains("(s2)"));
    }

    #[test]
    fn agents_human_format_empty() {
        let r = json!({ "agents": [] });
        assert!(format_result("agents", &r, false).contains("nenhum agente"));
    }

    #[test]
    fn snapshot_human_prints_data_field() {
        let r = json!({ "data": "linha1\nlinha2", "cols": 80, "rows": 24, "seq": 7 });
        let out = format_result("snapshot", &r, false);
        assert_eq!(out, "linha1\nlinha2");
    }

    #[test]
    fn snapshot_json_keeps_full_envelope() {
        let r = json!({ "data": "x", "cols": 80, "rows": 24, "seq": 7 });
        let out = format_result("snapshot", &r, true);
        assert!(out.contains("\"seq\""));
        assert!(out.contains("\"cols\""));
    }

    #[test]
    fn describe_runtime_error_passes_message() {
        let e = ClientError::Rpc("not_found: x".into());
        assert_eq!(describe_runtime_error(&e), "not_found: x");
    }
}
