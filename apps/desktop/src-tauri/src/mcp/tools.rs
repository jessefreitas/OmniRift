//! Tools MCP de orquestração (surface herdr). Helpers puros + dispatch.

/// Traduz nomes de tecla (separados por espaço) em bytes; tokens não-reconhecidos
/// são enviados literais.
pub fn keys_to_bytes(keys: &str) -> Vec<u8> {
    let mut out = Vec::new();
    for tok in keys.split_whitespace() {
        match tok.to_lowercase().as_str() {
            "enter" | "return" => out.push(b'\r'),
            "tab" => out.push(b'\t'),
            "esc" | "escape" => out.push(0x1b),
            "space" => out.push(b' '),
            "up" => out.extend_from_slice(b"\x1b[A"),
            "down" => out.extend_from_slice(b"\x1b[B"),
            "right" => out.extend_from_slice(b"\x1b[C"),
            "left" => out.extend_from_slice(b"\x1b[D"),
            "ctrl-c" => out.push(0x03),
            "ctrl-d" => out.push(0x04),
            "ctrl-z" => out.push(0x1a),
            "backspace" => out.push(0x7f),
            other => out.extend_from_slice(other.as_bytes()),
        }
    }
    out
}

/// Procura `pattern` (substring ou regex) linha a linha; devolve a linha que casou.
pub fn output_matches(buf: &str, pattern: &str, use_regex: bool) -> Option<String> {
    if use_regex {
        let re = regex::Regex::new(pattern).ok()?;
        buf.lines().find(|l| re.is_match(l)).map(|s| s.to_string())
    } else {
        buf.lines().find(|l| l.contains(pattern)).map(|s| s.to_string())
    }
}

use crate::mcp::server::McpState;
use crate::proc_ext::NoWindow;
use serde_json::{json, Value};
use std::sync::Mutex as StdMutex;
use std::time::Duration;
use tauri::{Emitter, Listener, Manager};
use tokio::sync::oneshot;

/// Resolve o handle (label do registry) → session_id.
fn resolve(state: &McpState, terminal: &str) -> Result<String, String> {
    state
        .agent_registry
        .get_session_id(terminal)
        .ok_or_else(|| format!("terminal '{terminal}' não encontrado (use terminal_list)"))
}

fn arg_str(args: &Value, key: &str) -> String {
    args.get(key).and_then(|v| v.as_str()).unwrap_or("").to_string()
}

/// Como `arg_str`, mas None quando ausente/vazio (pra colunas opcionais).
fn arg_opt(args: &Value, key: &str) -> Option<String> {
    args.get(key)
        .and_then(|v| v.as_str())
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// Últimas `n` linhas da tela renderizada (sem as linhas em branco do rodapé).
fn last_lines(screen: &str, n: usize) -> String {
    let trimmed = screen.trim_end();
    let lines: Vec<&str> = trimmed.lines().collect();
    let start = lines.len().saturating_sub(n);
    lines[start..].join("\n")
}

/// Schemas das tools de orquestração (concatenados no tools/list do server).
pub fn terminal_tool_defs() -> Vec<Value> {
    vec![
        json!({ "name": "terminal_list",
            "description": "Lista os terminais-agente do canvas com seu estado (idle/working/blocked/done/dead).",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "terminal_read",
            "description": "Lê as últimas linhas da tela de um terminal sem enviar nada.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "lines": { "type": "number" } },
                "required": ["terminal"] } }),
        json!({ "name": "terminal_send_text",
            "description": "Injeta texto no terminal (sem Enter).",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "text": { "type": "string" } },
                "required": ["terminal", "text"] } }),
        json!({ "name": "terminal_run",
            "description": "Envia um comando seguido de Enter.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "command": { "type": "string" } },
                "required": ["terminal", "command"] } }),
        json!({ "name": "terminal_send_keys",
            "description": "Envia teclas nomeadas (enter, tab, esc, up/down/left/right, ctrl-c, ctrl-d, backspace), separadas por espaço.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" }, "keys": { "type": "string" } },
                "required": ["terminal", "keys"] } }),
        json!({ "name": "terminal_wait_status",
            "description": "Bloqueia até o terminal atingir um estado (idle/working/blocked/done/dead) ou timeout.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" },
                "status": { "type": "string" },
                "timeout_ms": { "type": "number" } },
                "required": ["terminal", "status"] } }),
        json!({ "name": "terminal_wait_output",
            "description": "Bloqueia até o output do terminal casar um padrão (substring ou regex) ou timeout.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string" },
                "pattern": { "type": "string" },
                "regex": { "type": "boolean" },
                "timeout_ms": { "type": "number" } },
                "required": ["terminal", "pattern"] } }),
        json!({ "name": "terminal_spawn",
            "description": "Cria um novo terminal no canvas e o registra como agente addressável.",
            "inputSchema": { "type": "object", "properties": {
                "command": { "type": "string" },
                "label": { "type": "string" },
                "role": { "type": "string" },
                "cwd": { "type": "string" },
                "position": { "type": "object", "properties": {
                    "x": { "type": "number" }, "y": { "type": "number" } } } },
                "required": ["command", "label"] } }),
        json!({ "name": "terminal_spawn_on_floor",
            "description": "Cria um Floor novo (branch git + worktree isolado por padrão) e spawna um agente nele já com a tarefa. Use para paralelizar: cada agente trabalha na sua branch sem conflito. Depois faça 'Land' do floor quando a tarefa verificar.",
            "inputSchema": { "type": "object", "properties": {
                "branch": { "type": "string", "description": "Nome da branch/floor (ex: feature/auth)." },
                "command": { "type": "string", "description": "CLI do agente (ex: claude)." },
                "label": { "type": "string", "description": "Label do agente no registry." },
                "role": { "type": "string" },
                "task": { "type": "string", "description": "Tarefa enviada ao agente após subir." },
                "git": { "type": "boolean", "description": "Floor como branch git (default true). false = floor comum." } },
                "required": ["branch", "command", "label"] } }),
        json!({ "name": "workspace_list",
            "description": "Lista os floors (workspaces) do canvas e qual está ativo.",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "workspace_create",
            "description": "Cria um novo floor (workspace) no canvas.",
            "inputSchema": { "type": "object", "properties": {
                "name": { "type": "string" } }, "required": ["name"] } }),
        json!({ "name": "workspace_focus",
            "description": "Troca o floor ativo (por id ou nome).",
            "inputSchema": { "type": "object", "properties": {
                "target": { "type": "string" } }, "required": ["target"] } }),
        json!({ "name": "workspace_rename",
            "description": "Renomeia um floor.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" }, "name": { "type": "string" } },
                "required": ["id", "name"] } }),
        json!({ "name": "workspace_close",
            "description": "Fecha (exclui) um floor.",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "string" } }, "required": ["id"] } }),
        json!({ "name": "spec_read",
            "description": "Lê uma spec/plan e devolve as Tasks já cortadas (### Task N). Use no dispatch paralelo: agrupe as Tasks INDEPENDENTES e dispare uma por terminal_spawn_on_floor (1 branch por grupo).",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Caminho absoluto do .md da spec/plan." } },
                "required": ["path"] } }),
        json!({ "name": "memory_recall",
            "description": "ANTES de codar/decidir: busca memórias relevantes (fatos do blackboard + erros já cometidos) pra não repetir engano. Faça isso no começo de cada tarefa.",
            "inputSchema": { "type": "object", "properties": {
                "query": { "type": "string", "description": "Termos do que você vai fazer (ex: 'auth jwt refresh')." },
                "kind": { "type": "string", "description": "Filtra: fact | error | note (opcional)." },
                "scope": { "type": "string", "description": "Filtra por floor/projeto (opcional)." },
                "limit": { "type": "number" } },
                "required": ["query"] } }),
        json!({ "name": "memory_remember",
            "description": "Grava um fato durável no blackboard compartilhado entre agentes (ex: decisão de arquitetura, convenção, endpoint). Outro agente recupera com memory_recall.",
            "inputSchema": { "type": "object", "properties": {
                "value": { "type": "string", "description": "O fato a lembrar." },
                "key": { "type": "string", "description": "Chave curta (opcional)." },
                "kind": { "type": "string", "description": "fact (default) | note." },
                "tags": { "type": "string" },
                "scope": { "type": "string" },
                "agent": { "type": "string" } },
                "required": ["value"] } }),
        json!({ "name": "memory_remember_error",
            "description": "Registra um ERRO cometido + causa + correção, pra que nenhum agente repita. Chame sempre que descobrir que algo deu errado e como consertou.",
            "inputSchema": { "type": "object", "properties": {
                "what": { "type": "string", "description": "O que deu errado." },
                "why": { "type": "string", "description": "Causa raiz." },
                "fix": { "type": "string", "description": "Como corrigir / o jeito certo." },
                "tags": { "type": "string" },
                "scope": { "type": "string" },
                "agent": { "type": "string" } },
                "required": ["what", "fix"] } }),
        json!({ "name": "memory_list",
            "description": "Lista as memórias gravadas (filtro opcional por kind/scope).",
            "inputSchema": { "type": "object", "properties": {
                "kind": { "type": "string" }, "scope": { "type": "string" }, "limit": { "type": "number" } } } }),
        json!({ "name": "memory_forget",
            "description": "Apaga uma memória por id (ex: fato obsoleto).",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "number" } }, "required": ["id"] } }),
        json!({ "name": "claim_acquire",
            "description": "COORDENAÇÃO: reivindica um arquivo ANTES de editá-lo. Recusa (conflito) se OUTRO agente já reivindicou o mesmo path. Use no começo de cada edição; libere com claim_release ao terminar. Substitui o claim textual antigo por enforcement real.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Caminho do arquivo a reivindicar (relativo ou absoluto)." },
                "agent": { "type": "string", "description": "Seu label de agente (ex: Backend)." },
                "floor": { "type": "string", "description": "Sua branch/floor (opcional)." } },
                "required": ["path", "agent"] } }),
        json!({ "name": "claim_release",
            "description": "Libera um arquivo que VOCÊ reivindicou (claim_acquire). Só o dono libera. Chame ao terminar de editar pra liberar pros outros.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string" },
                "agent": { "type": "string", "description": "Seu label de agente." } },
                "required": ["path", "agent"] } }),
        json!({ "name": "claim_list",
            "description": "Lista todos os claims ativos (quem está editando o quê, em qual floor).",
            "inputSchema": { "type": "object", "properties": {} } }),
        json!({ "name": "claim_check",
            "description": "ANTES de tocar em arquivos compartilhados: verifica se algum dos paths já está reivindicado por OUTRO agente. Devolve os conflitos pra você recuar/alinhar antes de editar.",
            "inputSchema": { "type": "object", "properties": {
                "paths": { "type": "array", "items": { "type": "string" }, "description": "Lista de paths a checar." },
                "agent": { "type": "string", "description": "Seu label (claims SEUS não contam como conflito)." },
                "floor": { "type": "string" } },
                "required": ["paths"] } }),
        json!({ "name": "spec_path_conflicts",
            "description": "PRÓ-ATIVO (antes do fan-out): cruza os `paths:` declarados nas specs ATIVAS e devolve as sobreposições. Use ANTES de spawnar agentes pra avisar quando duas specs mexem nos mesmos arquivos (serialize ou redesenhe o escopo).",
            "inputSchema": { "type": "object", "properties": {
                "dir": { "type": "string", "description": "Raiz do projeto (onde vivem docs/superpowers)." },
                "extra_roots": { "type": "array", "items": { "type": "string" }, "description": "Raízes extras de spec (opcional)." } },
                "required": ["dir"] } }),
    ]
}

/// Despacha as tools `spec_*` (Fase C — dispatch dirigido por spec). Não precisa
/// de estado: lê o arquivo e devolve as Tasks cortadas pro Orquestrador agrupar.
pub fn spec_dispatch(tool: &str, args: Value) -> String {
    match tool {
        "spec_read" => {
            let path = arg_str(&args, "path");
            if path.is_empty() {
                return "❌ 'path' é obrigatório".into();
            }
            let content = match std::fs::read_to_string(&path) {
                Ok(c) => c,
                Err(e) => return format!("❌ não consegui ler '{path}': {e}"),
            };
            let title = crate::spec::spec_title(&content);
            let tasks = crate::spec::parse_tasks(&content);
            if tasks.is_empty() {
                return format!(
                    "Spec '{title}' ({path}) não tem Tasks no formato '### Task N'. Conteúdo bruto:\n\n{content}"
                );
            }
            let mut s = format!("Spec: {title} ({path})\n{} tasks:\n", tasks.len());
            for t in &tasks {
                s.push_str(&format!("\n--- Task {} : {} ---\n{}\n", t.n, t.title, t.body));
            }
            s.push_str(
                "\nAgora agrupe as Tasks INDEPENDENTES e, pra cada grupo, chame \
                 terminal_spawn_on_floor (branch única, command=\"claude\", role=\"claude-code\", \
                 task=os passos do grupo). Depois acompanhe com terminal_list.",
            );
            s
        }
        other => format!("❌ tool de spec desconhecida: {other}"),
    }
}

/// Despacha as tools de coordenação (Bloco E): `claim_acquire/release/list/check`
/// + `spec_path_conflicts`. Estado puro no `ClaimsRegistry` (sem IO, exceto a
/// leitura de specs em spec_path_conflicts).
pub fn claim_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    let claims = &state.claims;
    match tool {
        "claim_acquire" => {
            let path = arg_str(&args, "path");
            let agent = arg_str(&args, "agent");
            if path.is_empty() || agent.is_empty() {
                return "❌ 'path' e 'agent' são obrigatórios".into();
            }
            // floor explícito > floor ativo do espelho.
            let floor = arg_opt(&args, "floor").or_else(|| active_floor_name(state));
            match claims.acquire(&path, &agent, floor) {
                Ok(e) => format!(
                    "✅ claim adquirido: '{}'{} por {agent}",
                    e.raw_path,
                    floor_suffix(&e.floor)
                ),
                Err(c) => format!(
                    "❌ CONFLITO: '{}' já reivindicado por {}{}. Recue ou alinhe (não edite ainda).",
                    c.path,
                    c.holder,
                    floor_suffix(&c.holder_floor)
                ),
            }
        }
        "claim_release" => {
            let path = arg_str(&args, "path");
            let agent = arg_str(&args, "agent");
            if path.is_empty() || agent.is_empty() {
                return "❌ 'path' e 'agent' são obrigatórios".into();
            }
            if claims.release(&path, &agent) {
                format!("✅ claim liberado: '{path}'")
            } else {
                format!("nada a liberar: '{path}' não é seu claim (ou não existe)")
            }
        }
        "claim_list" => {
            let list = claims.list();
            if list.is_empty() {
                return "Nenhum claim ativo.".into();
            }
            list.iter()
                .map(|e| format!("• '{}'{} — {}", e.raw_path, floor_suffix(&e.floor), e.agent_label))
                .collect::<Vec<_>>()
                .join("\n")
        }
        "claim_check" => {
            let paths: Vec<String> = args
                .get("paths")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            if paths.is_empty() {
                return "❌ 'paths' (lista) é obrigatório".into();
            }
            let agent = arg_str(&args, "agent");
            let floor = arg_opt(&args, "floor");
            let conflicts = claims.check(&paths, &agent, floor.as_deref());
            if conflicts.is_empty() {
                return "✅ Livre: nenhum dos paths está reivindicado por outro agente.".into();
            }
            let mut s = format!("⚠️ {} conflito(s) — NÃO edite ainda:\n", conflicts.len());
            for c in &conflicts {
                s.push_str(&format!(
                    "• '{}' reivindicado por {}{}\n",
                    c.path,
                    c.holder,
                    floor_suffix(&c.holder_floor)
                ));
            }
            s
        }
        "spec_path_conflicts" => {
            let dir = arg_str(&args, "dir");
            if dir.is_empty() {
                return "❌ 'dir' (raiz do projeto) é obrigatório".into();
            }
            let extra: Vec<String> = args
                .get("extra_roots")
                .and_then(|v| v.as_array())
                .map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect())
                .unwrap_or_default();
            let conflicts =
                crate::spec::spec_path_conflicts(std::path::Path::new(&dir), &extra);
            if conflicts.is_empty() {
                return "✅ Nenhuma sobreposição entre os `paths:` das specs ativas.".into();
            }
            let mut s = format!(
                "⚠️ {} sobreposição(ões) entre specs ativas — serialize ou redesenhe o escopo ANTES do fan-out:\n",
                conflicts.len()
            );
            for c in &conflicts {
                s.push_str(&format!(
                    "• '{}' tocado por '{}' E '{}'\n",
                    c.path, c.holder, c.requester
                ));
            }
            s
        }
        other => format!("❌ tool de coordenação desconhecida: {other}"),
    }
}

/// Formata uma lista de memórias pro agente ler.
fn fmt_memories(rows: &[crate::db::MemoryRow], title: &str) -> String {
    if rows.is_empty() {
        return format!("Nada na memória pra '{title}'.");
    }
    let mut s = format!("{} resultado(s) — {title}:\n", rows.len());
    for m in rows {
        let key = m.mem_key.as_deref().map(|k| format!(" [{k}]")).unwrap_or_default();
        s.push_str(&format!("\n#{} ({}){key}\n{}\n", m.id, m.kind, m.value));
    }
    s
}

/// Despacha as tools `memory_*`. Local (default) = blackboard rico INALTERADO;
/// provider remoto ativo = roteia pelo MemoryProvider.
pub async fn memory_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    if state.memory_registry.active_kind() == crate::memory::ProviderKind::Local {
        memory_dispatch_local(state, tool, args)
    } else {
        memory_dispatch_provider(state, tool, args).await
    }
}

/// Caminho Local — blackboard SQLite com semântica rica (fact/error/scope/tags).
/// Corpo original, comportamento idêntico (zero regressão).
fn memory_dispatch_local(state: &McpState, tool: &str, args: Value) -> String {
    let db = state.app.state::<crate::db::Db>();
    match tool {
        "memory_remember" => {
            let value = arg_str(&args, "value");
            if value.is_empty() {
                return "❌ 'value' é obrigatório".into();
            }
            let kind = arg_opt(&args, "kind").unwrap_or_else(|| "fact".into());
            match db.memory_remember(
                arg_opt(&args, "scope").as_deref(),
                arg_opt(&args, "agent").as_deref(),
                &kind,
                arg_opt(&args, "key").as_deref(),
                &value,
                arg_opt(&args, "tags").as_deref(),
            ) {
                Ok(id) => format!("✅ memória #{id} gravada ({kind})"),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_remember_error" => {
            let what = arg_str(&args, "what");
            let fix = arg_str(&args, "fix");
            if what.is_empty() || fix.is_empty() {
                return "❌ 'what' e 'fix' são obrigatórios".into();
            }
            let why = arg_str(&args, "why");
            let value = format!("ERRO: {what}\nCAUSA: {why}\nFIX: {fix}");
            match db.memory_remember(
                arg_opt(&args, "scope").as_deref(),
                arg_opt(&args, "agent").as_deref(),
                "error",
                Some(&what),
                &value,
                arg_opt(&args, "tags").as_deref(),
            ) {
                Ok(id) => format!("✅ erro #{id} registrado — outros agentes não vão repetir"),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_recall" => {
            let query = arg_str(&args, "query");
            if query.is_empty() {
                return "❌ 'query' é obrigatório".into();
            }
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(10);
            match db.memory_recall(
                &query,
                arg_opt(&args, "kind").as_deref(),
                arg_opt(&args, "scope").as_deref(),
                limit,
            ) {
                Ok(rows) => fmt_memories(&rows, &format!("recall '{query}'")),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_list" => {
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(50);
            match db.memory_list(
                arg_opt(&args, "kind").as_deref(),
                arg_opt(&args, "scope").as_deref(),
                limit,
            ) {
                Ok(rows) => fmt_memories(&rows, "memórias"),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_forget" => {
            let id = args.get("id").and_then(|v| v.as_i64()).unwrap_or(0);
            if id <= 0 {
                return "❌ 'id' inválido".into();
            }
            match db.memory_forget(id) {
                Ok(_) => format!("🗑 memória #{id} apagada"),
                Err(e) => format!("❌ {e}"),
            }
        }
        other => format!("❌ tool de memória desconhecida: {other}"),
    }
}

/// Caminho provider remoto — mapeia o blackboard pra superfície MemoryProvider
/// (value→content, kind→category, scope→project). Usado quando o provider ativo
/// não é o Local (ex.: OmniMemory).
async fn memory_dispatch_provider(state: &McpState, tool: &str, args: Value) -> String {
    use crate::memory::{MemoryQuery, NewMemory};
    let p = state.memory_registry.active_provider();
    let kind = state.memory_registry.active_kind();
    match tool {
        "memory_remember" => {
            let value = arg_str(&args, "value");
            if value.is_empty() {
                return "❌ 'value' é obrigatório".into();
            }
            let category = arg_opt(&args, "kind").unwrap_or_else(|| "fact".into());
            match p
                .save(NewMemory { content: value, category, project: arg_opt(&args, "scope") })
                .await
            {
                Ok(id) => format!("✅ memória {id} gravada ({kind:?})"),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_remember_error" => {
            let what = arg_str(&args, "what");
            let fix = arg_str(&args, "fix");
            if what.is_empty() || fix.is_empty() {
                return "❌ 'what' e 'fix' são obrigatórios".into();
            }
            let why = arg_str(&args, "why");
            let value = format!("ERRO: {what}\nCAUSA: {why}\nFIX: {fix}");
            match p
                .save(NewMemory { content: value, category: "error".into(), project: arg_opt(&args, "scope") })
                .await
            {
                Ok(id) => format!("✅ erro {id} registrado ({kind:?})"),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_recall" => {
            let query = arg_str(&args, "query");
            if query.is_empty() {
                return "❌ 'query' é obrigatório".into();
            }
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(10).max(1) as usize;
            match p
                .search(MemoryQuery { query: query.clone(), project: arg_opt(&args, "scope"), limit })
                .await
            {
                Ok(recs) => fmt_records(&recs, &format!("recall '{query}'")),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_list" => {
            let limit = args.get("limit").and_then(|v| v.as_i64()).unwrap_or(50).max(1) as usize;
            match p
                .search(MemoryQuery { query: String::new(), project: arg_opt(&args, "scope"), limit })
                .await
            {
                Ok(recs) => fmt_records(&recs, "memórias"),
                Err(e) => format!("❌ {e}"),
            }
        }
        "memory_forget" => {
            // ids de provider remoto são string; aceita number também.
            let id = arg_opt(&args, "id").unwrap_or_else(|| {
                args.get("id").and_then(|v| v.as_i64()).map(|n| n.to_string()).unwrap_or_default()
            });
            if id.is_empty() {
                return "❌ 'id' inválido".into();
            }
            match p.forget(&id).await {
                Ok(true) => format!("🗑 memória {id} apagada"),
                Ok(false) => format!("memória {id} não encontrada (ou forget não suportado por {kind:?})"),
                Err(e) => format!("❌ {e}"),
            }
        }
        other => format!("❌ tool de memória desconhecida: {other}"),
    }
}

/// Formata MemoryRecords (provider remoto) pro agente ler.
fn fmt_records(recs: &[crate::memory::MemoryRecord], title: &str) -> String {
    if recs.is_empty() {
        return format!("Nada na memória pra '{title}'.");
    }
    let mut s = format!("{} resultado(s) — {title}:\n", recs.len());
    for m in recs {
        s.push_str(&format!("\n#{} ({})\n{}\n", m.id, m.category, m.content));
    }
    s
}

/// Nome do floor ativo, lido do espelho (floor_mirror) que o frontend mantém.
/// Usado pra anotar a topologia cross-floor dos agentes (em qual branch cada um vive).
pub(crate) fn active_floor_name(state: &McpState) -> Option<String> {
    let m = state.floor_mirror.lock();
    let active_id = m.get("activeFloorId")?.as_str()?;
    let floors = m.get("floors")?.as_array()?;
    floors
        .iter()
        .find(|f| f.get("id").and_then(|v| v.as_str()) == Some(active_id))
        .and_then(|f| f.get("name").and_then(|v| v.as_str()))
        .map(|s| s.to_string())
}

/// Sufixo de floor pra exibição: ` @<floor>` ou vazio.
fn floor_suffix(floor: &Option<String>) -> String {
    floor.as_deref().map(|f| format!(" @{f}")).unwrap_or_default()
}

/// Despacha as tools `terminal_*`. Devolve o texto do envelope MCP.
/// Devolve Some(erro) se já bateu o teto de agentes simultâneos.
fn over_agent_cap(state: &McpState) -> Option<String> {
    let active = state.agent_registry.list().len();
    let cap = state.max_agents.load(std::sync::atomic::Ordering::Relaxed);
    if active >= cap {
        Some(format!(
            "❌ Teto de {cap} agentes simultâneos atingido ({active} ativos). Rode em ONDAS: \
             aguarde um agente encerrar (terminal_wait_status) antes do próximo, ou peça ao \
             usuário pra aumentar o teto."
        ))
    } else {
        None
    }
}

pub async fn terminal_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    match tool {
        "terminal_list" => {
            let agents = state.agent_registry.list();
            if agents.is_empty() {
                return "Nenhum terminal-agente. Marque terminais na sidebar do OmniRift.".into();
            }
            agents
                .iter()
                .map(|(label, entry)| {
                    let st = state
                        .pty_manager
                        .agent_state(&entry.session_id)
                        .map(|s| format!("{s:?}").to_lowercase())
                        .unwrap_or_else(|| "unknown".into());
                    format!("• {label} [{st}]{} — {}", floor_suffix(&entry.floor), entry.description)
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "terminal_read" => {
            let terminal = arg_str(&args, "terminal");
            let lines = args.get("lines").and_then(|v| v.as_u64()).unwrap_or(40) as usize;
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.read_screen(&id) {
                    Ok(screen) => {
                        let text = last_lines(&screen, lines);
                        if text.is_empty() { "(tela vazia)".into() } else { text }
                    }
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_send_text" => {
            let terminal = arg_str(&args, "terminal");
            let text = arg_str(&args, "text");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, text.as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_run" => {
            let terminal = arg_str(&args, "terminal");
            let command = arg_str(&args, "command");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, format!("{command}\r").as_bytes()) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_send_keys" => {
            let terminal = arg_str(&args, "terminal");
            let keys = arg_str(&args, "keys");
            match resolve(state, &terminal) {
                Ok(id) => match state.pty_manager.write(&id, &keys_to_bytes(&keys)) {
                    Ok(()) => "ok".into(),
                    Err(e) => format!("❌ {e}"),
                },
                Err(e) => format!("❌ {e}"),
            }
        }
        "terminal_wait_status" => {
            let terminal = arg_str(&args, "terminal");
            let target = arg_str(&args, "status").to_lowercase();
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
            let id = match resolve(state, &terminal) { Ok(i) => i, Err(e) => return format!("❌ {e}") };

            let matches = |s: &crate::pty::AgentState| format!("{s:?}").to_lowercase() == target;
            if state.pty_manager.agent_state(&id).map(|s| matches(&s)).unwrap_or(false) {
                return format!("reached {target}");
            }
            let mut rx = state.pty_manager.subscribe_state();
            let wait = async {
                loop {
                    match rx.recv().await {
                        Ok((sid, st)) if sid == id && matches(&st) => return,
                        Ok(_) => continue,
                        Err(_) => return,
                    }
                }
            };
            match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
                Ok(()) => format!("reached {target}"),
                Err(_) => {
                    let cur = state.pty_manager.agent_state(&id)
                        .map(|s| format!("{s:?}").to_lowercase()).unwrap_or_else(|| "unknown".into());
                    format!("timeout após {timeout_ms}ms (estado atual: {cur})")
                }
            }
        }
        "terminal_wait_output" => {
            let terminal = arg_str(&args, "terminal");
            let pattern = arg_str(&args, "pattern");
            let use_regex = args.get("regex").and_then(|v| v.as_bool()).unwrap_or(false);
            let timeout_ms = args.get("timeout_ms").and_then(|v| v.as_u64()).unwrap_or(30000);
            let id = match resolve(state, &terminal) { Ok(i) => i, Err(e) => return format!("❌ {e}") };
            let mut rx = match state.pty_manager.subscribe_by_id(&id) {
                Ok(r) => r, Err(e) => return format!("❌ {e}"),
            };
            // Casa contra a tela renderizada (não o stream cru — TUIs redesenham).
            let check = || {
                state.pty_manager.read_screen(&id).ok()
                    .and_then(|s| output_matches(&s, &pattern, use_regex))
            };
            if let Some(line) = check() {
                return format!("matched: {line}");
            }
            let wait = async {
                loop {
                    match rx.recv().await {
                        Ok(_) => {
                            if let Some(line) = check() { return Some(line); }
                        }
                        Err(_) => return None,
                    }
                }
            };
            match tokio::time::timeout(Duration::from_millis(timeout_ms), wait).await {
                Ok(Some(line)) => format!("matched: {line}"),
                Ok(None) => "❌ canal fechado antes do match".into(),
                Err(_) => format!("timeout após {timeout_ms}ms sem casar o padrão"),
            }
        }
        "terminal_spawn" => {
            let command = arg_str(&args, "command");
            let label = arg_str(&args, "label");
            if command.is_empty() || label.is_empty() {
                return "❌ 'command' e 'label' são obrigatórios".into();
            }
            if let Some(msg) = over_agent_cap(state) {
                return msg;
            }
            let role = arg_str(&args, "role");
            let cwd = args.get("cwd").and_then(|v| v.as_str()).map(|s| s.to_string());
            let position = args.get("position").cloned();
            let id = uuid::Uuid::new_v4().to_string();

            // Ouvir o ack pty://ready ANTES de pedir o spawn, filtrando pelo id.
            let (tx, rx) = oneshot::channel::<()>();
            let tx = std::sync::Arc::new(StdMutex::new(Some(tx)));
            let want = id.clone();
            let listener_id = state.app.listen_any("pty://ready", move |event| {
                if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
                    if v.get("id").and_then(|x| x.as_str()) == Some(want.as_str()) {
                        if let Some(s) = tx.lock().unwrap().take() {
                            let _ = s.send(());
                        }
                    }
                }
            });

            let _ = state.app.emit("canvas://spawn-request", json!({
                "id": id, "command": command, "label": label,
                "role": role, "cwd": cwd, "position": position
            }));

            let acked = tokio::time::timeout(Duration::from_secs(8), rx).await.is_ok();
            state.app.unlisten(listener_id);

            let floor = active_floor_name(state);
            state.agent_registry.register(label.clone(), id.clone(), command.clone(), floor);

            if acked {
                format!("criado: {label} (id {id})")
            } else {
                format!("criado: {label} (id {id}) — aviso: terminal não confirmou prontidão em 8s")
            }
        }
        "terminal_spawn_on_floor" => {
            let branch = arg_str(&args, "branch");
            let command = arg_str(&args, "command");
            let label = arg_str(&args, "label");
            if branch.is_empty() || command.is_empty() || label.is_empty() {
                return "❌ 'branch', 'command' e 'label' são obrigatórios".into();
            }
            if let Some(msg) = over_agent_cap(state) {
                return msg;
            }
            let role = arg_str(&args, "role");
            let task = arg_str(&args, "task");
            let git = args.get("git").and_then(|v| v.as_bool()).unwrap_or(true);
            let id = uuid::Uuid::new_v4().to_string();

            // Ack pty://ready filtrado por id (mesmo protocolo do terminal_spawn).
            let (tx, rx) = oneshot::channel::<()>();
            let tx = std::sync::Arc::new(StdMutex::new(Some(tx)));
            let want = id.clone();
            let listener_id = state.app.listen_any("pty://ready", move |event| {
                if let Ok(v) = serde_json::from_str::<Value>(event.payload()) {
                    if v.get("id").and_then(|x| x.as_str()) == Some(want.as_str()) {
                        if let Some(s) = tx.lock().unwrap().take() {
                            let _ = s.send(());
                        }
                    }
                }
            });

            // Frontend: cria o floor (git worktree) + foca + spawna o terminal com este id.
            let _ = state.app.emit("canvas://spawn-on-floor", json!({
                "id": id, "branch": branch, "command": command,
                "label": label, "role": role, "git": git
            }));

            // worktree add + spawn demora mais que um spawn simples → timeout maior.
            let acked = tokio::time::timeout(Duration::from_secs(15), rx).await.is_ok();
            state.app.unlisten(listener_id);

            // Registra com floor = branch (topologia cross-floor pro Orquestrador).
            state.agent_registry.register(label.clone(), id.clone(), command.clone(), Some(branch.clone()));

            // Injeta a tarefa depois que o agente sobe (deixa a TUI assentar).
            if acked && !task.is_empty() {
                tokio::time::sleep(Duration::from_millis(1500)).await;
                let _ = state.pty_manager.write(&id, format!("{task}\r").as_bytes());
            }

            if acked {
                format!("criado: {label} no floor '{branch}' (id {id})")
            } else {
                format!("criado: {label} no floor '{branch}' (id {id}) — aviso: não confirmou prontidão em 15s")
            }
        }
        other => format!("❌ tool de terminal desconhecida: {other}"),
    }
}

/// Despacha as tools `workspace_*` (floors). `list` lê o espelho; o resto emite eventos.
pub async fn workspace_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    match tool {
        "workspace_list" => {
            let mirror = state.floor_mirror.lock().clone();
            let floors = mirror.get("floors").and_then(|v| v.as_array()).cloned().unwrap_or_default();
            if floors.is_empty() {
                return "Nenhum floor no espelho ainda.".into();
            }
            let active = mirror.get("activeFloorId").and_then(|v| v.as_str()).unwrap_or("");
            floors
                .iter()
                .map(|f| {
                    let id = f.get("id").and_then(|v| v.as_str()).unwrap_or("?");
                    let name = f.get("name").and_then(|v| v.as_str()).unwrap_or("?");
                    let n = f.get("nodes").and_then(|v| v.as_u64()).unwrap_or(0);
                    let mark = if id == active { " (ativo)" } else { "" };
                    format!("• {name} [{id}]{mark} — {n} nós")
                })
                .collect::<Vec<_>>()
                .join("\n")
        }
        "workspace_create" => {
            let name = arg_str(&args, "name");
            let _ = state.app.emit("canvas://floor-create", json!({ "name": name }));
            format!("solicitado: criar floor '{name}'")
        }
        "workspace_focus" => {
            let target = arg_str(&args, "target");
            let _ = state.app.emit("canvas://floor-focus", json!({ "target": target }));
            format!("solicitado: focar floor '{target}'")
        }
        "workspace_rename" => {
            let id = arg_str(&args, "id");
            let name = arg_str(&args, "name");
            let _ = state.app.emit("canvas://floor-rename", json!({ "id": id, "name": name }));
            format!("solicitado: renomear floor '{id}' → '{name}'")
        }
        "workspace_close" => {
            let id = arg_str(&args, "id");
            let _ = state.app.emit("canvas://floor-close", json!({ "id": id }));
            format!("solicitado: fechar floor '{id}'")
        }
        other => format!("❌ tool de workspace desconhecida: {other}"),
    }
}

// ── review_current ─────────────────────────────────────────────────────────────

/// Tool MCP que deixa o agente se AUTO-REVISAR (mesmo motor do Stop hook / gate).
pub fn review_tool_def() -> Value {
    json!({
        "name": "review_current",
        "description": "Roda o code review (mesmo motor do gate/Stop hook) sobre o diff do SEU worktree. \
            Chame ANTES de declarar a tarefa pronta — se reprovar (NO-GO), corrija e rode de novo. \
            Passe `cwd` = a pasta absoluta onde você está trabalhando (o worktree do floor).",
        "inputSchema": {
            "type": "object",
            "properties": {
                "cwd": { "type": "string", "description": "Caminho absoluto do seu worktree (a pasta do floor)." },
                "base": { "type": "string", "description": "Branch base pra comparar (opcional; detecta sozinho se omitir)." }
            },
            "required": ["cwd"]
        }
    })
}

/// Roda o `local-review.py` headless sobre o worktree do agente e devolve o veredito.
pub async fn review_dispatch(state: &McpState, args: Value) -> String {
    let cwd = args.get("cwd").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if cwd.is_empty() {
        return "Erro: passe `cwd` (a pasta absoluta do seu worktree) para review_current.".into();
    }
    let base = args.get("base").and_then(|v| v.as_str()).unwrap_or("").to_string();
    let app = state.app.clone();
    let script = match crate::commands::review_cfg::ensure_review_script(&app) {
        Ok(p) => p,
        Err(e) => return format!("Erro ao preparar o review: {e}"),
    };
    let cfg = match app.path().app_data_dir() {
        Ok(d) => d.join("review-config.json"),
        Err(e) => return format!("Erro: app_data_dir indisponível: {e}"),
    };

    let result = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("python3");
        cmd.arg(&script).arg("--cwd").arg(&cwd).arg("--config").arg(&cfg);
        if !base.is_empty() {
            cmd.arg("--base").arg(&base);
        }
        cmd.no_window().output()
    })
    .await;

    match result {
        Ok(Ok(o)) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            match serde_json::from_str::<Value>(stdout.trim()) {
                Ok(v) => {
                    let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("?");
                    let summary = v.get("summary").and_then(|x| x.as_str()).unwrap_or("");
                    let mut s = format!("Code review: {verdict}\n{summary}");
                    if let Some(e) = v.get("llmError").and_then(|x| x.as_str()) {
                        s.push_str(&format!("\n(LLM indisponível: {e} — só o pré-flight rodou)"));
                    }
                    s
                }
                Err(_) => format!("review (saída crua):\n{}", stdout.trim()),
            }
        }
        Ok(Err(e)) => format!("Erro ao rodar python3 local-review.py: {e}"),
        Err(e) => format!("Erro de execução do review: {e}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_named_sequences() {
        assert_eq!(keys_to_bytes("enter"), b"\r");
        assert_eq!(keys_to_bytes("ctrl-c"), b"\x03");
        assert_eq!(keys_to_bytes("up down"), b"\x1b[A\x1b[B");
        assert_eq!(keys_to_bytes("esc"), b"\x1b");
    }

    #[test]
    fn keys_literal_passthrough() {
        assert_eq!(keys_to_bytes("hi"), b"hi");
    }

    #[test]
    fn output_substring_returns_line() {
        let buf = "linha um\nfoo bar baz\nfim";
        assert_eq!(output_matches(buf, "bar", false).as_deref(), Some("foo bar baz"));
        assert_eq!(output_matches(buf, "ausente", false), None);
    }

    #[test]
    fn output_regex_returns_line() {
        let buf = "abc\nerror: 42\nxyz";
        assert_eq!(output_matches(buf, r"error: \d+", true).as_deref(), Some("error: 42"));
        assert_eq!(output_matches(buf, r"^never$", true), None);
    }
}
