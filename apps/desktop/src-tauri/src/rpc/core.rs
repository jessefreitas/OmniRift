//! Núcleo do registro RPC (ref #8 — substrato CLI/mobile).
//!
//! Um **único registro** em Rust que mora dentro do app Tauri e é o portão entre
//! frames de fio crus (socket local agora; WebSocket mobile na fase 2) e o estado
//! do app. Os `#[tauri::command]` do renderer continuam à parte (boca confiável) —
//! este registro só serve callers de fio que provam posse do token da sessão.
//!
//! Contrato de fio (1 linha JSON `\n`-delimitada):
//!   req  `{id, token, method, params}`
//!   resp `{id, ok, result?, error?}`
//!
//! Sem estado global: o handler recebe tudo pelo [`RpcContext`] (acesso ao estado
//! via `ctx.app.state::<T>()`). A validação/parse dos params vive no handler (serde
//! tipado), espelhando o `safeParse` do ref — uma vez, reusável por CLI + mobile.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use tauri::AppHandle;

/// Erro de um método RPC. Vira `{ok:false, error:<message>}` no fio. `code` é um
/// rótulo curto e estável (`invalid_argument`, `not_found`, `internal`, …) embutido
/// na mensagem pro caller poder discriminar sem um campo extra no envelope MVP.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RpcError {
    pub code: String,
    pub message: String,
}

impl RpcError {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        Self { code: code.into(), message: message.into() }
    }

    /// Params inválidos / faltando — espelha o `invalid_argument` do ref.
    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }

    /// Recurso não encontrado (sessão/agente inexistente).
    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    /// Falha interna do handler (estado indisponível, etc.).
    pub fn internal(message: impl Into<String>) -> Self {
        Self::new("internal", message)
    }
}

impl std::fmt::Display for RpcError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // `code: message` — o caller lê o código no prefixo; humano lê o todo.
        write!(f, "{}: {}", self.code, self.message)
    }
}

impl std::error::Error for RpcError {}

/// Açúcar: erros de `serde_json` na desserialização de params viram `invalid_argument`
/// com a mensagem do serde (campo faltando / tipo errado, legível). Permite
/// `serde_json::from_value(params)?` direto dentro de um handler.
impl From<serde_json::Error> for RpcError {
    fn from(e: serde_json::Error) -> Self {
        RpcError::invalid_argument(e.to_string())
    }
}

/// Envelope de **requisição** (1 frame JSON). `token` viaja no envelope (não em
/// header) — é o segredo da sessão gravado em `runtime.json` que prova acesso local.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcRequest {
    pub id: String,
    pub token: String,
    pub method: String,
    /// Ausente no fio = `Value::Null` (método sem params).
    #[serde(default)]
    pub params: Value,
}

/// Envelope de **resposta**. `ok` discrimina: sucesso traz `result`, falha traz
/// `error` (mensagem `code: message`). Os dois lados ficam `Option` e `skip` no fio
/// pra não poluir o JSON com `null`s.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RpcResponse {
    pub id: String,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none", default)]
    pub error: Option<String>,
}

impl RpcResponse {
    pub fn success(id: impl Into<String>, result: Value) -> Self {
        Self { id: id.into(), ok: true, result: Some(result), error: None }
    }

    pub fn failure(id: impl Into<String>, error: impl Into<String>) -> Self {
        Self { id: id.into(), ok: false, result: None, error: Some(error.into()) }
    }
}

/// Contexto injetado em todo handler — **sem globais**. Só o `AppHandle`: cada
/// handler alcança o estado que precisa via `ctx.app.state::<T>()` (PtyManager,
/// AgentRegistry, floor mirror, …), exatamente como os `#[tauri::command]`. Clonável
/// (AppHandle é barato de clonar) pra montar o ctx por conexão no transporte.
#[derive(Clone)]
pub struct RpcContext {
    pub app: AppHandle,
}

impl RpcContext {
    pub fn new(app: AppHandle) -> Self {
        Self { app }
    }
}

/// Assinatura de um handler: params crus (já desserializados do envelope, ainda
/// `Value`) + contexto → resultado JSON ou erro. O handler faz o parse tipado
/// (`serde_json::from_value`) — a validação mora aqui, uma vez.
///
/// `fn` ponteiro (não `Box<dyn>`): os métodos MVP são funções livres sem captura,
/// então `fn` basta, é `Copy`, e mantém o registro `Send + Sync` trivialmente.
pub type Handler = fn(Value, &RpcContext) -> Result<Value, RpcError>;

/// Registro de métodos. `register` **rejeita nome duplicado com panic** — é erro de
/// programação (dois grupos reivindicando o mesmo método), pego no boot/registro,
/// não em runtime. Espelha o `buildRegistry()` do ref (`core.ts:152`).
#[derive(Default)]
pub struct Registry {
    methods: HashMap<String, Handler>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    /// Registra `name → handler`. Panica se `name` já existe (rede contra dois
    /// grupos registrarem o mesmo método — falha alto, cedo).
    pub fn register(&mut self, name: impl Into<String>, handler: Handler) {
        let name = name.into();
        if self.methods.contains_key(&name) {
            panic!("RPC: método duplicado registrado: '{name}'");
        }
        self.methods.insert(name, handler);
    }

    /// Acha um método pelo nome (None = não registrado).
    pub fn get(&self, name: &str) -> Option<Handler> {
        self.methods.get(name).copied()
    }

    /// Nº de métodos registrados (introspecção/teste).
    pub fn len(&self) -> usize {
        self.methods.len()
    }

    pub fn is_empty(&self) -> bool {
        self.methods.is_empty()
    }
}

/// Despacha uma requisição validada: acha o método → chama o handler → embrulha em
/// `RpcResponse` ok/erro. **Não** valida token (isso é do transporte, antes daqui —
/// o dispatch é reusável in-process pelo renderer confiável). Método inexistente →
/// `method_not_found`. Erro do handler → `{ok:false, error}` com `code: message`.
pub fn dispatch(registry: &Registry, req: RpcRequest, ctx: &RpcContext) -> RpcResponse {
    match registry.get(&req.method) {
        None => RpcResponse::failure(
            req.id,
            RpcError::new("method_not_found", format!("método desconhecido: '{}'", req.method))
                .to_string(),
        ),
        Some(handler) => match handler(req.params, ctx) {
            Ok(result) => RpcResponse::success(req.id, result),
            Err(e) => RpcResponse::failure(req.id, e.to_string()),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ok_method(params: Value, _ctx: &RpcContext) -> Result<Value, RpcError> {
        Ok(json!({ "echo": params }))
    }

    fn dup_method(_params: Value, _ctx: &RpcContext) -> Result<Value, RpcError> {
        Ok(Value::Null)
    }

    // --- Registro rejeita duplicata (panic no registro) ---
    #[test]
    #[should_panic(expected = "método duplicado")]
    fn register_rejects_duplicate() {
        let mut reg = Registry::new();
        reg.register("status", ok_method);
        reg.register("status", dup_method); // mesmo nome → panic
    }

    #[test]
    fn register_distinct_names_ok() {
        let mut reg = Registry::new();
        reg.register("a", ok_method);
        reg.register("b", dup_method);
        assert_eq!(reg.len(), 2);
        assert!(reg.get("a").is_some());
        assert!(reg.get("missing").is_none());
    }

    // --- Envelope serde round-trip (req e resp) ---
    #[test]
    fn request_envelope_roundtrip() {
        let req = RpcRequest {
            id: "1".into(),
            token: "secret".into(),
            method: "status".into(),
            params: json!({ "rows": 80 }),
        };
        let wire = serde_json::to_string(&req).unwrap();
        let back: RpcRequest = serde_json::from_str(&wire).unwrap();
        assert_eq!(req, back);
    }

    #[test]
    fn request_envelope_defaults_params_to_null() {
        // params ausente no fio → Value::Null (método sem params).
        let back: RpcRequest =
            serde_json::from_str(r#"{"id":"1","token":"t","method":"status"}"#).unwrap();
        assert_eq!(back.params, Value::Null);
    }

    #[test]
    fn response_success_roundtrip_omits_error() {
        let resp = RpcResponse::success("9", json!({ "version": "0.1.0" }));
        let wire = serde_json::to_string(&resp).unwrap();
        assert!(!wire.contains("error"), "sucesso não deve serializar 'error': {wire}");
        let back: RpcResponse = serde_json::from_str(&wire).unwrap();
        assert_eq!(resp, back);
        assert!(back.ok);
    }

    #[test]
    fn response_failure_roundtrip_omits_result() {
        let resp = RpcResponse::failure("9", "invalid_argument: faltou x");
        let wire = serde_json::to_string(&resp).unwrap();
        assert!(!wire.contains("result"), "falha não deve serializar 'result': {wire}");
        let back: RpcResponse = serde_json::from_str(&wire).unwrap();
        assert_eq!(resp, back);
        assert!(!back.ok);
        assert_eq!(back.error.unwrap(), "invalid_argument: faltou x");
    }

    // --- Erro carrega code: message ---
    #[test]
    fn rpc_error_display_is_code_message() {
        assert_eq!(
            RpcError::invalid_argument("faltou session_id").to_string(),
            "invalid_argument: faltou session_id"
        );
    }

    #[test]
    fn serde_error_maps_to_invalid_argument() {
        // from_value num tipo incompatível → vira invalid_argument via From.
        let err: Result<i64, RpcError> =
            serde_json::from_value::<i64>(json!("not a number")).map_err(Into::into);
        let e = err.unwrap_err();
        assert_eq!(e.code, "invalid_argument");
    }
}
