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

/// Se `terminal` é um OmniAgent (ACP) registrado, roteia o texto como um PROMPT (turno)
/// via AcpManager e devolve `Some(resposta)`. Senão `None` (cai no caminho PTY normal).
/// Pra um agente ACP, "send_text" e "run" significam ambos "mande isto como prompt" —
/// não existe digitar-sem-enter numa sessão estruturada.
async fn acp_route_prompt(state: &McpState, terminal: &str, text: String) -> Option<String> {
    let mgr = state
        .app
        .state::<std::sync::Arc<crate::acp::AcpManager>>()
        .inner()
        .clone();
    let id = mgr.resolve_label(terminal)?;
    Some(match mgr.prompt(&id, text).await {
        Ok(()) => "ok — enviado ao OmniAgent (ACP)".into(),
        Err(e) => format!("❌ {e}"),
    })
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
        json!({ "name": "code_chunks",
            "description": "Fatia um arquivo de código por função/classe/método (AST). Retorna os pedaços com símbolo, linhas e texto — em vez de ler o arquivo cru inteiro. Suporta Rust, TS/TSX, Python, Go, Java, C, C++, C#, Ruby, PHP.",
            "inputSchema": { "type": "object", "properties": {
                "path": { "type": "string", "description": "Caminho do arquivo de código" },
                "target_tokens": { "type": "number", "description": "Tamanho-alvo aprox. do chunk (default 1000)" }
            }, "required": ["path"] } }),
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
        json!({ "name": "orchestration_send",
            "description": "FAN-OUT: injeta a mesma mensagem no PTY de um GRUPO de agentes de uma vez. \
                `group` é um endereço: @all (todos), @idle (só os ociosos), @worktree:<floor> (os de um Floor/branch), \
                ou @<role-ou-label> (ex: @claude, @Backend — casa por role/label, fronteira de palavra). \
                Resolve o grupo → escreve a mensagem + Enter em cada alvo → devolve quem recebeu. \
                Use pra mandar uma instrução pra vários agentes sem repetir terminal_run N vezes.",
            "inputSchema": { "type": "object", "properties": {
                "group": { "type": "string", "description": "Endereço do grupo: @all | @idle | @worktree:<floor> | @<role-ou-label>." },
                "message": { "type": "string", "description": "Texto a injetar (seguido de Enter) em cada agente do grupo." } },
                "required": ["group", "message"] } }),
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
            let acp = state
                .app
                .state::<std::sync::Arc<crate::acp::AcpManager>>()
                .labels_list();
            if agents.is_empty() && acp.is_empty() {
                return "Nenhum terminal-agente. Marque terminais na sidebar do OmniRift (ou ligue um OmniAgent num terminal).".into();
            }
            let mut lines: Vec<String> = agents
                .iter()
                .map(|(label, entry)| {
                    let st = state
                        .pty_manager
                        .agent_state(&entry.session_id)
                        .map(|s| format!("{s:?}").to_lowercase())
                        .unwrap_or_else(|| "unknown".into());
                    format!("• {label} [{st}]{} — {}", floor_suffix(&entry.floor), entry.description)
                })
                .collect();
            for (label, _id, ready) in acp {
                let st = if ready { "ready" } else { "starting" };
                lines.push(format!(
                    "• {label} [acp·{st}] — OmniAgent estruturado (ACP); comande igual a um terminal (terminal_send_text/terminal_run)."
                ));
            }
            lines.join("\n")
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
            // OmniAgent (ACP)? roteia como prompt. Senão, escreve no PTY (sem Enter).
            if let Some(r) = acp_route_prompt(state, &terminal, text.clone()).await {
                return r;
            }
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
            // OmniAgent (ACP)? roteia como prompt. Senão, envia comando + Enter no PTY.
            if let Some(r) = acp_route_prompt(state, &terminal, command.clone()).await {
                return r;
            }
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
            let _ = state.app.emit("canvas://spawn-on-parallel", json!({
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

// ── orchestration_send: fan-out de grupo (Parte B do #7) ─────────────────────────

/// Snapshot dos agentes endereçáveis: AgentRegistry (label/floor/session) +
/// AgentStateMap (estado via PtyManager). `role` não é persistido no registry
/// hoje → fica `None` (o match `@<token>` cai no label). Quando o registry passar
/// a guardar role, basta preencher aqui — `resolve_group` já consulta os dois.
fn agent_snapshot(state: &McpState) -> Vec<crate::mcp::AgentInfo> {
    state
        .agent_registry
        .list()
        .into_iter()
        .map(|(label, entry)| {
            let st = state
                .pty_manager
                .agent_state(&entry.session_id)
                .unwrap_or(crate::pty::AgentState::Idle);
            crate::mcp::AgentInfo {
                session_id: entry.session_id,
                label,
                role: None,
                floor: entry.floor,
                state: st,
            }
        })
        .collect()
}

/// Despacha `orchestration_send`: resolve o grupo e injeta a mensagem no PTY de
/// cada alvo. REUSA o mecanismo de envio do `do_send_task`/`terminal_run` — escreve
/// o texto e, ~200ms depois, o Enter sozinho (TUIs raw-mode tratam texto+\r colado
/// como paste e às vezes NÃO submetem). Devolve a lista de quem recebeu.
pub async fn orchestration_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    match tool {
        "orchestration_send" => {
            let group = arg_str(&args, "group");
            let message = arg_str(&args, "message");
            if group.is_empty() || message.is_empty() {
                return "❌ 'group' e 'message' são obrigatórios".into();
            }
            let agents = agent_snapshot(state);
            let targets = crate::mcp::resolve_group(&group, &agents);
            if targets.is_empty() {
                return format!(
                    "Nenhum agente casou '{group}'. Endereços: @all | @idle | @worktree:<floor> | @<role-ou-label>. \
                     Veja terminal_list pra os agentes ativos."
                );
            }
            // session_id → label (pra reportar quem recebeu de forma legível).
            let label_of = |sid: &str| -> String {
                agents
                    .iter()
                    .find(|a| a.session_id == sid)
                    .map(|a| a.label.clone())
                    .unwrap_or_else(|| sid.to_string())
            };

            let mut delivered: Vec<String> = Vec::new();
            let mut failed: Vec<String> = Vec::new();
            // Fan-out O(1) em vez de O(N×200ms): injeta o TEXTO em todos os alvos de uma
            // vez (writes independentes — PTYs distintos), espera a pausa texto→Enter do
            // do_send_task UMA vez pro grupo, e só então o Enter em quem recebeu o texto.
            // Antes era sequencial (sleep 200ms POR agente) → 10 agentes = 2s só pra despachar.
            let mut pending: Vec<&String> = Vec::new();
            for sid in &targets {
                match state.pty_manager.write(sid, message.as_bytes()) {
                    Ok(()) => pending.push(sid),
                    Err(e) => failed.push(format!("{} ({e})", label_of(sid))),
                }
            }
            if !pending.is_empty() {
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
            for sid in pending {
                match state.pty_manager.write(sid, b"\r") {
                    Ok(()) => delivered.push(label_of(sid)),
                    Err(e) => failed.push(format!("{} ({e})", label_of(sid))),
                }
            }

            let mut s = format!(
                "✅ fan-out '{group}' → {} agente(s): {}",
                delivered.len(),
                delivered.join(", ")
            );
            if !failed.is_empty() {
                s.push_str(&format!("\n⚠️ falhou em {}: {}", failed.len(), failed.join(", ")));
            }
            s
        }
        other => format!("❌ tool de orquestração desconhecida: {other}"),
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

/// Roda o review headless em DOIS estágios sobre o worktree do agente e devolve o
/// veredito consolidado:
///   - **Estágio 1 (pré-flight, determinístico):** gitleaks + semgrep + grep de
///     padrões perigosos, no working tree (aqui, em Rust). NÃO depende de LLM.
///   - **Estágio 2 (review por IA):** `local-review.py` (diff + LLM BYOK, inalterado).
/// Consolida os achados dos dois e aplica GO/NO-GO: 1+ CRITICAL OU 2+ WARNING = NO-GO.
/// Ferramenta ausente / timeout = pulada (NEUTRAL, não bloqueia).
pub async fn review_dispatch(state: &McpState, args: Value) -> String {
    let cwd = args.get("cwd").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
    if cwd.is_empty() {
        return "Erro: passe `cwd` (a pasta absoluta do seu worktree) para review_current.".into();
    }
    let base = args.get("base").and_then(|v| v.as_str()).unwrap_or("").to_string();

    // ── Estágio 1 — pré-flight determinístico (working tree do cwd) ──────────────
    let preflight = run_preflight(&cwd).await;

    // ── Estágio 2 — review por IA (local-review.py, contrato inalterado) ─────────
    let app = state.app.clone();
    let script = match crate::commands::review_cfg::ensure_review_script(&app) {
        Ok(p) => p,
        Err(e) => return format!("Erro ao preparar o review: {e}"),
    };
    let cfg = match app.path().app_data_dir() {
        Ok(d) => d.join("review-config.json"),
        Err(e) => return format!("Erro: app_data_dir indisponível: {e}"),
    };

    let cwd_py = cwd.clone();
    let result = tokio::task::spawn_blocking(move || {
        let mut cmd = std::process::Command::new("python3");
        cmd.arg(&script).arg("--cwd").arg(&cwd_py).arg("--config").arg(&cfg);
        if !base.is_empty() {
            cmd.arg("--base").arg(&base);
        }
        cmd.no_window().output()
    })
    .await;

    // Extrai o Estágio 2. Se o Python falhar (ou não devolver JSON), o Estágio 2 vira
    // NEUTRAL — não bloqueia sozinho, mas o pré-flight determinístico ainda gate-keia.
    let mut stage2_summary = String::new();
    let mut stage2_crit = 0i64;
    let mut stage2_warn = 0i64;
    let mut stage2_nogo = false;
    let mut stage2_note: Option<String> = None;
    match result {
        Ok(Ok(o)) => {
            let stdout = String::from_utf8_lossy(&o.stdout);
            match serde_json::from_str::<Value>(stdout.trim()) {
                Ok(v) => {
                    let verdict = v.get("verdict").and_then(|x| x.as_str()).unwrap_or("?");
                    stage2_nogo = verdict == "NO-GO";
                    stage2_crit = v.get("crit").and_then(|x| x.as_i64()).unwrap_or(0);
                    stage2_warn = v.get("warn").and_then(|x| x.as_i64()).unwrap_or(0);
                    stage2_summary =
                        v.get("summary").and_then(|x| x.as_str()).unwrap_or("").to_string();
                    if let Some(e) = v.get("llmError").and_then(|x| x.as_str()) {
                        stage2_note =
                            Some(format!("LLM indisponível: {e} — Estágio 2 rodou só o pré-flight interno"));
                    }
                }
                Err(_) => {
                    stage2_summary = format!("Estágio 2 (saída crua):\n{}", stdout.trim());
                    stage2_note = Some("Estágio 2 não retornou JSON — tratado como NEUTRAL".into());
                }
            }
        }
        Ok(Err(e)) => {
            stage2_note = Some(format!("Estágio 2 indisponível (python3 local-review.py: {e}) — NEUTRAL"))
        }
        Err(e) => stage2_note = Some(format!("Estágio 2 falhou na execução: {e} — NEUTRAL")),
    }

    // ── Consolidação + GO/NO-GO ─────────────────────────────────────────────────
    let verdict = decide_go_nogo(&preflight.findings, stage2_crit, stage2_warn, stage2_nogo);
    let mut s = format!("Code review: {verdict}\n{}", render_preflight(&preflight));
    if !stage2_summary.is_empty() {
        s.push('\n');
        s.push_str(&stage2_summary);
    }
    if let Some(note) = stage2_note {
        s.push_str(&format!("\n({note})"));
    }
    s
}

// ── Estágio 1 · pré-flight determinístico de segurança ──────────────────────────
//
// Roda ANTES do review por IA, direto no working tree do cwd (não no diff — pega
// secret/padrão perigoso mesmo que ainda não commitado). Três checks independentes:
//   1. gitleaks  (`--no-git`: só o working tree, NÃO o histórico) → secret = CRITICAL
//   2. semgrep   (p/security-audit + p/secrets, severity ERROR)   → regra  = CRITICAL
//   3. grep      (padrões perigosos determinísticos, conservador) → hit    = WARNING
// Cada achado reusa `crate::db::ReviewHistItem` (severity + category "security" +
// arquivo:linha no `file` + descrição no `title`). Degrada limpo: binário ausente /
// timeout / erro = registrado em `skipped` (NEUTRAL — não vira finding, não bloqueia).

use crate::db::ReviewHistItem;

/// Resultado do Estágio 1: achados + ferramentas puladas (NEUTRAL, não bloqueiam).
struct PreflightReport {
    findings: Vec<ReviewHistItem>,
    skipped: Vec<String>,
}

/// Desfecho de um binário externo do pré-flight.
enum ToolRun {
    Ran(std::process::Output),
    Missing,          // nenhum candidato existe no PATH (NEUTRAL)
    Failed(String),   // timeout ou erro de execução (NEUTRAL)
}

/// code_chunks — fatia um arquivo de código por AST (função/classe/método) e devolve os
/// pedaços em JSON, pra o agente receber o arquivo já em unidades semânticas em vez de
/// ler o arquivo cru. Falha limpo (string de erro) se path ausente/linguagem não suportada.
pub fn code_chunks_dispatch(args: Value) -> String {
    use crate::code::chunk::{chunk_code, ChunkLang, ChunkOpts};
    let path = arg_str(&args, "path");
    if path.is_empty() {
        return "❌ 'path' é obrigatório".into();
    }
    let p = std::path::Path::new(&path);
    let Some(lang) = ChunkLang::from_path(p) else {
        return format!("❌ linguagem não suportada: {path}");
    };
    let source = match std::fs::read_to_string(p) {
        Ok(s) => s,
        Err(e) => return format!("❌ não consegui ler {path}: {e}"),
    };
    let mut opts = ChunkOpts::default();
    if let Some(t) = args.get("target_tokens").and_then(|v| v.as_u64()) {
        opts.target_tokens = t as usize;
    }
    let chunks: Vec<_> = chunk_code(&source, lang, &opts)
        .into_iter()
        .map(|c| {
            json!({
                "symbol": c.symbol,
                "kind": format!("{:?}", c.kind),
                "start_line": c.start_line,
                "end_line": c.end_line,
                "text": c.text,
            })
        })
        .collect();
    serde_json::to_string(&json!({ "chunks": chunks })).unwrap_or_else(|_| "{}".into())
}

/// Candidatos de binário: nome no PATH (o app já herda o PATH do shell de login,
/// que inclui ~/.local/bin) + fallbacks absolutos conhecidos, pra degradar limpo
/// mesmo quando o PATH não foi propagado.
fn bin_candidates(name: &str) -> Vec<String> {
    let mut v = vec![name.to_string()];
    let home = std::env::var("HOME").unwrap_or_default();
    match name {
        "gitleaks" => v.push("/usr/local/bin/gitleaks".into()),
        "semgrep" => {
            if !home.is_empty() {
                v.push(format!("{home}/.local/bin/semgrep"));
            }
            v.push("/usr/local/bin/semgrep".into());
        }
        _ => {}
    }
    v
}

/// Roda um binário externo com timeout + kill_on_drop (sem leak de processo). Tenta
/// os candidatos em ordem até um spawnar; NotFound em todos = Missing. Não bloqueia o
/// executor async indefinidamente: no timeout, o future é dropado e o filho é morto.
async fn run_tool(cands: &[String], args: &[String], timeout: Duration) -> ToolRun {
    for (i, bin) in cands.iter().enumerate() {
        let mut cmd = tokio::process::Command::new(bin);
        cmd.args(args)
            .kill_on_drop(true)
            .stdin(std::process::Stdio::null());
        cmd.no_window();
        match tokio::time::timeout(timeout, cmd.output()).await {
            Ok(Ok(out)) => return ToolRun::Ran(out),
            Ok(Err(e)) if e.kind() == std::io::ErrorKind::NotFound => {
                if i + 1 < cands.len() {
                    continue; // tenta o próximo candidato
                }
                return ToolRun::Missing;
            }
            Ok(Err(e)) => return ToolRun::Failed(e.to_string()),
            Err(_) => return ToolRun::Failed(format!("timeout após {}s", timeout.as_secs())),
        }
    }
    ToolRun::Missing
}

/// Trunca uma string em `n` CHARS (não bytes) — nunca parte no meio de um code point.
fn truncate_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

/// Parser puro do report JSON do gitleaks (array de findings). Cada entrada vira um
/// CRITICAL "security" com `arquivo:linha`. O `--redact` já mascara o segredo no report.
fn parse_gitleaks(json: &str) -> Vec<ReviewHistItem> {
    let Ok(val) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    let Some(arr) = val.as_array() else {
        return Vec::new();
    };
    arr.iter()
        .map(|f| {
            let file = f.get("File").and_then(|v| v.as_str()).unwrap_or("?");
            let line = f.get("StartLine").and_then(|v| v.as_i64()).unwrap_or(0);
            let rule = f
                .get("RuleID")
                .and_then(|v| v.as_str())
                .filter(|s| !s.is_empty())
                .or_else(|| f.get("Description").and_then(|v| v.as_str()))
                .unwrap_or("secret");
            ReviewHistItem {
                file: format!("{file}:{line}"),
                category: "security".into(),
                severity: "CRITICAL".into(),
                title: format!("secret no working tree ({})", truncate_chars(rule, 80)),
            }
        })
        .collect()
}

/// Núcleo do parser do semgrep (`.results[]`). ERROR → CRITICAL, WARNING → WARNING,
/// resto → INFO. `arquivo:linha` + regra (`check_id`) no título.
fn semgrep_findings_from_value(v: &Value) -> Vec<ReviewHistItem> {
    let Some(results) = v.get("results").and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    results
        .iter()
        .map(|r| {
            let path = r.get("path").and_then(|v| v.as_str()).unwrap_or("?");
            let line = r
                .get("start")
                .and_then(|s| s.get("line"))
                .and_then(|v| v.as_i64())
                .unwrap_or(0);
            let rule = r.get("check_id").and_then(|v| v.as_str()).unwrap_or("semgrep");
            let extra = r.get("extra");
            let sev_raw = extra
                .and_then(|e| e.get("severity"))
                .and_then(|v| v.as_str())
                .unwrap_or("ERROR");
            let msg = extra
                .and_then(|e| e.get("message"))
                .and_then(|v| v.as_str())
                .unwrap_or(rule);
            let severity = match sev_raw.to_ascii_uppercase().as_str() {
                "ERROR" => "CRITICAL",
                "WARNING" => "WARNING",
                _ => "INFO",
            };
            let short = msg.lines().next().unwrap_or(msg);
            ReviewHistItem {
                file: format!("{path}:{line}"),
                category: "security".into(),
                severity: severity.into(),
                title: format!("{} [{}]", truncate_chars(short, 140), truncate_chars(rule, 80)),
            }
        })
        .collect()
}

/// Parser puro (str) da saída `--json` do semgrep — wrapper testável do núcleo acima.
#[cfg(test)]
fn parse_semgrep(json: &str) -> Vec<ReviewHistItem> {
    match serde_json::from_str::<Value>(json) {
        Ok(v) => semgrep_findings_from_value(&v),
        Err(_) => Vec::new(),
    }
}

/// Regexes compilados 1x dos padrões perigosos (parte determinística do grep).
fn danger_regexes() -> &'static Vec<(regex::Regex, &'static str)> {
    static RE: std::sync::OnceLock<Vec<(regex::Regex, &'static str)>> = std::sync::OnceLock::new();
    RE.get_or_init(|| {
        let p = |re: &str, d: &'static str| (regex::Regex::new(re).unwrap(), d);
        vec![
            p(r"\beval\s*\(", "uso de eval("),
            p(r"\bexec\s*\(", "uso de exec("),
            p(r"\bnew\s+Function\s*\(", "new Function("),
            p(r"shell\s*=\s*True", "subprocess shell=True"),
            p(r"\bpickle\.loads?\s*\(", "pickle.load (desserialização insegura)"),
            // hash fraco SÓ em contexto de chamada (conservador — evita FP em comentário/nome)
            p(r#"(?i)createHash\(\s*['"](md5|sha1)"#, "hash fraco (MD5/SHA1)"),
            p(r"(?i)hashlib\.(md5|sha1)\s*\(", "hash fraco (MD5/SHA1)"),
            p(r#"(?i)getInstance\(\s*"(md5|sha-?1)""#, "hash fraco (MD5/SHA1)"),
        ]
    })
}

/// Checagem determinística de padrões perigosos numa ÚNICA linha. Conservadora de
/// propósito (WARNING conta pro NO-GO em 2+). Pura → testável sem FS nem binários.
fn scan_line_dangers(line: &str) -> Vec<&'static str> {
    let mut hits: Vec<&'static str> = Vec::new();
    for (re, desc) in danger_regexes() {
        if re.is_match(line) && !hits.contains(desc) {
            hits.push(desc);
        }
    }
    // yaml.load sem Loader — o crate regex não tem lookahead, então checa em código.
    if line.contains("yaml.load(") && !line.contains("Loader") {
        hits.push("yaml.load sem Loader");
    }
    // SQL concatenada: `.query(`/`.execute(` com interpolação (`${`, `" +`, `' +`).
    let sql_call = line.contains(".query(") || line.contains(".execute(");
    let interp = line.contains("${")
        || line.contains("\" +")
        || line.contains("' +")
        || line.contains("`+");
    if sql_call && interp {
        hits.push("SQL concatenada (possível injeção)");
    }
    // Comparação de assinatura/HMAC com `==`/`===` (não-constante → timing attack).
    let lc = line.to_ascii_lowercase();
    if (lc.contains("signature") || lc.contains("hmac"))
        && (line.contains("===") || line.contains("!==") || line.contains("=="))
    {
        hits.push("comparação de assinatura não-constante (===)");
    }
    hits
}

/// Só varre extensões de código-fonte; pula testes/fixtures/.d.ts (baixo valor, FP alto).
fn is_scannable(path: &std::path::Path) -> bool {
    const CODE_EXT: [&str; 14] = [
        "rs", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rb", "java", "php", "cs", "sql",
    ];
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    if !CODE_EXT.contains(&ext.as_str()) {
        return false;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
    let full = path.to_string_lossy().to_ascii_lowercase();
    let is_test = full.contains("/test")
        || full.contains("test.")
        || full.contains(".test.")
        || full.contains("spec.")
        || full.contains(".spec.")
        || full.contains("__tests__")
        || full.contains("/fixtures/")
        || full.contains("/e2e/")
        || name.ends_with(".d.ts");
    !is_test
}

/// Varre o working tree por padrões perigosos determinísticos. Honra `.gitignore`,
/// pula dirs canônicos (node_modules/target/…), testes/fixtures/.md e arquivos grandes.
/// Bounded (nº de arquivos e achados) pra nunca travar. Sync → chamado via spawn_blocking.
fn grep_dangers(cwd: &str) -> Vec<ReviewHistItem> {
    const MAX_FILES: usize = 4000;
    const MAX_FINDINGS: usize = 60;
    const MAX_FILE_BYTES: u64 = 1_000_000;
    let mut out: Vec<ReviewHistItem> = Vec::new();
    let walker = ignore::WalkBuilder::new(cwd)
        .hidden(false)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        .require_git(false)
        .parents(true)
        .filter_entry(|e| {
            if e.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(n) = e.file_name().to_str() {
                    return !matches!(
                        n,
                        "node_modules"
                            | "target"
                            | "dist"
                            | ".git"
                            | "build"
                            | ".next"
                            | "vendor"
                            | "__pycache__"
                            | ".venv"
                            | "venv"
                            | "coverage"
                    );
                }
            }
            true
        })
        .build();
    let mut seen_files = 0usize;
    for res in walker {
        if out.len() >= MAX_FINDINGS {
            break;
        }
        let entry = match res {
            Ok(e) => e,
            Err(_) => continue,
        };
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if !is_scannable(path) {
            continue;
        }
        if entry.metadata().map(|m| m.len() > MAX_FILE_BYTES).unwrap_or(true) {
            continue;
        }
        seen_files += 1;
        if seen_files > MAX_FILES {
            break;
        }
        let content = match std::fs::read_to_string(path) {
            Ok(c) => c,
            Err(_) => continue, // binário/ilegível → ignora
        };
        let rel = path
            .strip_prefix(cwd)
            .unwrap_or(path)
            .to_string_lossy()
            .into_owned();
        for (i, line) in content.lines().enumerate() {
            if line.len() > 4000 {
                continue; // minificado / linhão → pula (evita FP e custo)
            }
            for desc in scan_line_dangers(line) {
                out.push(ReviewHistItem {
                    file: format!("{rel}:{}", i + 1),
                    category: "security".into(),
                    severity: "WARNING".into(),
                    title: desc.to_string(),
                });
                if out.len() >= MAX_FINDINGS {
                    break;
                }
            }
            if out.len() >= MAX_FINDINGS {
                break;
            }
        }
    }
    out
}

/// gitleaks — só o working tree (`--no-git`), redigido. Report JSON em arquivo temp
/// (parse robusto de arquivo:linha); fallback a 1 CRITICAL genérico se exit sinaliza
/// leak sem report legível. Erro de execução real = NEUTRAL (skipped).
async fn preflight_gitleaks(cwd: &str, report: &mut PreflightReport) {
    let tmp = std::env::temp_dir().join(format!("omnirift-gitleaks-{}.json", uuid::Uuid::new_v4()));
    let args: Vec<String> = vec![
        "detect".into(),
        "--source".into(),
        cwd.into(),
        "--no-git".into(),
        "--redact".into(),
        "--report-format".into(),
        "json".into(),
        "--report-path".into(),
        tmp.to_string_lossy().into_owned(),
        "--exit-code".into(),
        "1".into(),
    ];
    match run_tool(&bin_candidates("gitleaks"), &args, Duration::from_secs(60)).await {
        ToolRun::Missing => report.skipped.push("gitleaks: ferramenta ausente".into()),
        ToolRun::Failed(e) => report.skipped.push(format!("gitleaks: {e}")),
        ToolRun::Ran(out) => {
            let json = std::fs::read_to_string(&tmp).unwrap_or_default();
            let _ = std::fs::remove_file(&tmp);
            let mut found = parse_gitleaks(&json);
            let code = out.status.code().unwrap_or(-1);
            if !found.is_empty() {
                report.findings.append(&mut found);
            } else if code == 1 {
                // exit 1 = leak sinalizado, mas sem report parseável → não perde o gate.
                report.findings.push(ReviewHistItem {
                    file: "(working tree)".into(),
                    category: "security".into(),
                    severity: "CRITICAL".into(),
                    title: "secret no working tree (gitleaks exit 1)".into(),
                });
            } else if code != 0 {
                report
                    .skipped
                    .push(format!("gitleaks: execução inconclusiva (código {code})"));
            }
            // code == 0 sem achados → working tree limpo, nada a fazer.
        }
    }
}

/// semgrep — rulesets de segurança (severity ERROR), saída `--json` parseada. Falha
/// de rede/download de regras (saída não-JSON) = NEUTRAL (skipped), não bloqueia.
async fn preflight_semgrep(cwd: &str, report: &mut PreflightReport) {
    let args: Vec<String> = [
        "scan",
        "--config",
        "p/security-audit",
        "--config",
        "p/secrets",
        "--severity",
        "ERROR",
        "--error",
        "--json",
        "--quiet",
        "--metrics=off",
        "--disable-version-check",
        cwd,
    ]
    .iter()
    .map(|s| s.to_string())
    .collect();
    match run_tool(&bin_candidates("semgrep"), &args, Duration::from_secs(120)).await {
        ToolRun::Missing => report.skipped.push("semgrep: ferramenta ausente".into()),
        ToolRun::Failed(e) => report.skipped.push(format!("semgrep: {e}")),
        ToolRun::Ran(out) => {
            let stdout = String::from_utf8_lossy(&out.stdout);
            match serde_json::from_str::<Value>(stdout.trim()) {
                Ok(v) if v.get("results").and_then(|r| r.as_array()).is_some() => {
                    let mut f = semgrep_findings_from_value(&v);
                    report.findings.append(&mut f);
                }
                _ => {
                    // sem JSON válido → provável falha de rede/download de regras → NEUTRAL
                    let err = String::from_utf8_lossy(&out.stderr);
                    let snip = err.trim().lines().last().unwrap_or("saída não-JSON");
                    report
                        .skipped
                        .push(format!("semgrep: saída inconclusiva ({})", truncate_chars(snip, 100)));
                }
            }
        }
    }
}

/// Orquestra o Estágio 1: gitleaks + semgrep (subprocessos, timeout+kill_on_drop) +
/// grep (sync IO-bound → spawn_blocking, pra não travar o executor async).
async fn run_preflight(cwd: &str) -> PreflightReport {
    let mut report = PreflightReport { findings: Vec::new(), skipped: Vec::new() };
    preflight_gitleaks(cwd, &mut report).await;
    preflight_semgrep(cwd, &mut report).await;
    let cwd_owned = cwd.to_string();
    match tokio::task::spawn_blocking(move || grep_dangers(&cwd_owned)).await {
        Ok(mut g) => report.findings.append(&mut g),
        Err(e) => report.skipped.push(format!("grep: {e}")),
    }
    report
}

/// Decisão consolidada GO/NO-GO. Regra: **1+ CRITICAL OU 2+ WARNING = NO-GO** sobre os
/// achados do pré-flight SOMADOS aos contadores do Estágio 2. O NO-GO da IA nunca é
/// rebaixado. INFO/style não conta. Pura → testável sem os binários.
fn decide_go_nogo(
    preflight: &[ReviewHistItem],
    stage2_crit: i64,
    stage2_warn: i64,
    stage2_nogo: bool,
) -> &'static str {
    let crit = preflight.iter().filter(|f| f.severity == "CRITICAL").count() as i64 + stage2_crit;
    let warn = preflight.iter().filter(|f| f.severity == "WARNING").count() as i64 + stage2_warn;
    if stage2_nogo || crit >= 1 || warn >= 2 {
        "NO-GO"
    } else {
        "GO"
    }
}

/// Seção legível do Estágio 1 (achados por severidade + ferramentas puladas/NEUTRAL).
fn render_preflight(report: &PreflightReport) -> String {
    let n = report.findings.len();
    let mut lines = vec![format!(
        "Pré-flight (Estágio 1 · gitleaks+semgrep+grep): {n} achado(s)"
    )];
    for sev in ["CRITICAL", "WARNING", "INFO"] {
        for f in report.findings.iter().filter(|f| f.severity == sev) {
            lines.push(format!("  [{sev}/{}] {}: {}", f.category, f.file, f.title));
        }
    }
    for s in &report.skipped {
        lines.push(format!("  (pulado: {s})"));
    }
    lines.join("\n")
}

// ---- Kanban: acompanhamento visual do projeto — os AGENTES movem os cards ----

pub fn kanban_tool_defs() -> Vec<Value> {
    vec![
        json!({
            "name": "kanban_list",
            "description": "Lista as colunas do fluxo do projeto E os cards do Kanban (acompanhamento visual no painel do OmniRift). Retorna {\"columns\":[...],\"cards\":[...]} — use pra ver o fluxo, o que está em cada coluna e achar o id do SEU card.",
            "inputSchema": { "type": "object", "properties": {
                "project": { "type": "string", "description": "Caminho (cwd) do projeto." }
            }, "required": ["project"] }
        }),
        json!({
            "name": "kanban_card_create",
            "description": "Cria um card no Kanban do projeto (aparece no painel visual do OmniRift).",
            "inputSchema": { "type": "object", "properties": {
                "project": { "type": "string", "description": "Caminho (cwd) do projeto." },
                "title": { "type": "string", "description": "Título curto do card." },
                "column": { "type": "string", "description": "coluna do fluxo do projeto — veja kanban_list (default: a primeira coluna)." },
                "body": { "type": "string", "description": "Descrição opcional." },
                "agent": { "type": "string", "description": "Seu papel/nome de agente." }
            }, "required": ["project", "title"] }
        }),
        json!({
            "name": "kanban_card_move",
            "description": "Move um card do Kanban pra outra coluna (ao começar sua fatia → em andamento; ao terminar → review).",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "number", "description": "ID do card (veja kanban_list)." },
                "column": { "type": "string", "description": "coluna do fluxo do projeto — veja kanban_list" }
            }, "required": ["id", "column"] }
        }),
        json!({
            "name": "kanban_card_note",
            "description": "Adiciona uma nota curta de progresso ao card do Kanban (vira bullet no corpo).",
            "inputSchema": { "type": "object", "properties": {
                "id": { "type": "number", "description": "ID do card." },
                "note": { "type": "string", "description": "Nota de progresso." }
            }, "required": ["id", "note"] }
        }),
    ]
}

pub fn kanban_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    let db = state.app.state::<crate::db::Db>();
    match tool {
        "kanban_list" => {
            let Some(project) = args.get("project").and_then(|v| v.as_str()).filter(|p| !p.is_empty()) else {
                return "parâmetro 'project' é obrigatório".into();
            };
            match db.kanban_list(project) {
                Ok(cards) => {
                    // Colunas efetivas do projeto (custom, ou default de 6) na frente:
                    // é assim que o agente descobre o fluxo válido pro create/move.
                    let columns: Vec<Value> = crate::db::kanban_effective_columns(&db, project)
                        .into_iter()
                        .map(|(col, label)| json!({ "col": col, "label": label }))
                        .collect();
                    serde_json::to_string_pretty(&json!({ "columns": columns, "cards": cards }))
                        .unwrap_or_else(|_| r#"{"columns":[],"cards":[]}"#.into())
                }
                Err(e) => format!("erro ao listar cards: {e:#}"),
            }
        }
        "kanban_card_create" => {
            let Some(project) = args.get("project").and_then(|v| v.as_str()).filter(|p| !p.is_empty()) else {
                return "parâmetro 'project' é obrigatório".into();
            };
            let Some(title) = args.get("title").and_then(|v| v.as_str()).filter(|t| !t.is_empty()) else {
                return "parâmetro 'title' é obrigatório".into();
            };
            let column = match args.get("column").and_then(|v| v.as_str()).filter(|c| !c.is_empty()) {
                Some(c) => c.to_string(),
                None => crate::db::kanban_first_col(&db, project),
            };
            if !crate::db::kanban_valid_col(&db, project, &column) {
                return format!("coluna inválida: use {}", crate::db::kanban_cols_hint(&db, project));
            }
            let body = args.get("body").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            let agent = args.get("agent").and_then(|v| v.as_str()).filter(|s| !s.is_empty());
            match db.kanban_create(project, &column, title, body, agent, None) {
                Ok(id) => {
                    let _ = state.app.emit("kanban://changed", ());
                    format!("card #{id} criado em {column}")
                }
                Err(e) => format!("erro ao criar card: {e:#}"),
            }
        }
        "kanban_card_move" => {
            let Some(id) = args.get("id").and_then(|v| v.as_i64()).filter(|i| *i > 0) else {
                return "parâmetro 'id' deve ser um número positivo".into();
            };
            let Some(column) = args.get("column").and_then(|v| v.as_str()).filter(|c| !c.is_empty()) else {
                return "parâmetro 'column' é obrigatório".into();
            };
            let project = match db.kanban_card_project(id) {
                Ok(Some(p)) => p,
                Ok(None) => return format!("card #{id} não existe (veja kanban_list)"),
                Err(e) => return format!("erro ao buscar card: {e:#}"),
            };
            if !crate::db::kanban_valid_col(&db, &project, column) {
                return format!("coluna inválida: use {}", crate::db::kanban_cols_hint(&db, &project));
            }
            match db.kanban_move(id, column) {
                Ok(()) => {
                    let _ = state.app.emit("kanban://changed", ());
                    format!("card #{id} movido para {column}")
                }
                Err(e) => format!("erro ao mover card: {e:#}"),
            }
        }
        "kanban_card_note" => {
            let Some(id) = args.get("id").and_then(|v| v.as_i64()).filter(|i| *i > 0) else {
                return "parâmetro 'id' deve ser um número positivo".into();
            };
            let Some(note) = args.get("note").and_then(|v| v.as_str()).filter(|n| !n.is_empty()) else {
                return "parâmetro 'note' é obrigatório".into();
            };
            match db.kanban_note(id, note) {
                Ok(()) => {
                    let _ = state.app.emit("kanban://changed", ());
                    format!("nota adicionada ao card #{id}")
                }
                Err(e) => format!("erro ao anotar card: {e:#}"),
            }
        }
        _ => "tool kanban desconhecida".into(),
    }
}

// ---- Ciclo de vida de agentes: sleep/wake (task #10) -------------------------
//
// O PROCESSO morre/nasce; o NÓ do canvas fica. Sleep mata o PTY (economia real de
// CPU/RAM — cada claude ~350MB); wake pede ao FRONT pra re-spawnar, porque é o front
// (TerminalNode) quem guarda command/args/env do nó e tem o reconnect().

pub fn agent_lifecycle_tool_defs() -> Vec<Value> {
    vec![
        json!({ "name": "agent_sleep",
            "description": "Coloca um agente pra dormir: mata o processo (libera CPU/RAM — cada claude ~350MB) mas PRESERVA o nó no canvas com command/args/env. Acorde depois com agent_wake. O agente dormindo aparece como 'dead' no terminal_list/StatusDot.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string", "description": "Label do agente (veja terminal_list)." } },
                "required": ["terminal"] } }),
        json!({ "name": "agent_wake",
            "description": "Acorda um agente dormindo (agent_sleep): o nó do canvas re-spawna o processo com o MESMO command/args/env (a persona do role vive nos args). Aguarde alguns segundos e confira com terminal_list/terminal_wait_status.",
            "inputSchema": { "type": "object", "properties": {
                "terminal": { "type": "string", "description": "Label do agente (veja terminal_list)." } },
                "required": ["terminal"] } }),
    ]
}

/// Despacha `agent_sleep`/`agent_wake`. Roteado por match EXATO no server (não por
/// prefixo `agent_`): labels de agente viram tools dinâmicas via `to_tool_name`
/// ("Agent 01" → `agent_01`), e um prefixo capturaria essas tools por engano.
pub fn agent_lifecycle_dispatch(state: &McpState, tool: &str, args: Value) -> String {
    let terminal = arg_str(&args, "terminal");
    if terminal.is_empty() {
        return "❌ 'terminal' é obrigatório (use terminal_list)".into();
    }
    let id = match resolve(state, &terminal) {
        Ok(i) => i,
        Err(e) => return format!("❌ {e}"),
    };
    match tool {
        "agent_sleep" => match state.pty_manager.kill(&id) {
            Ok(()) => format!(
                "agente '{terminal}' dormindo — processo encerrado (RAM/CPU liberadas), \
                 nó preservado no canvas. Aparece como 'dead' no status enquanto dorme; \
                 acorde com agent_wake."
            ),
            Err(e) => format!("❌ não consegui dormir '{terminal}': {e:#} (já estava dormindo?)"),
        },
        "agent_wake" => {
            // O front re-spawna: TerminalNode escuta canvas://agent-wake (via
            // orchestration-client) e chama reconnect() quando o sessionId bate.
            let _ = state.app.emit("canvas://agent-wake", json!({
                "sessionId": id, "label": terminal
            }));
            format!(
                "pedido de wake enviado pra '{terminal}' — o nó re-spawna o processo com o \
                 mesmo command/args/env. Confirme com terminal_wait_status (idle/working)."
            )
        }
        other => format!("❌ tool de ciclo de vida desconhecida: {other}"),
    }
}

// ── Evict de tool-output grande (context management — steal #2 do deepagents) ──
//
// Qualquer tool que devolva texto acima do limiar tem o conteúdo COMPLETO gravado
// em `<app_data_dir>/tool-results/<timestamp>-<tool>.txt` e o agente recebe um STUB
// (caminho + primeiras/últimas 5 linhas numeradas + instrução de leitura paginada).
// O IO fica no server.rs (precisa do AppHandle); aqui vivem os helpers PUROS.

/// Limiar de evict em bytes (~20k chars ≈ 5k tokens). Barato de propósito: conta
/// `len()` em vez de tokenizar, igual ao deepagents (chars como proxy de tokens).
pub(crate) const EVICT_THRESHOLD_CHARS: usize = 20_000;

/// Nome do arquivo de resultado evictado: `<timestamp>-<tool>.txt`. O nome da tool
/// é sanitizado (só alfanumérico/`_`/`-`) — labels de agente viram tools dinâmicas
/// e não podem injetar separador de path no filename.
pub(crate) fn evict_file_name(tool: &str, timestamp_ms: u128) -> String {
    let safe: String = tool
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '_' || c == '-' { c } else { '_' })
        .collect();
    let safe = if safe.is_empty() { "tool".to_string() } else { safe };
    format!("{timestamp_ms}-{safe}.txt")
}

/// Puro (sem IO): monta o STUB que substitui um output grande já gravado em `path`.
/// Formato: aviso + caminho do arquivo + primeiras 5 linhas + últimas 5 linhas
/// (ambas NUMERADAS com o nº real da linha) + instrução de leitura paginada.
pub(crate) fn evict_stub(tool: &str, path: &str, text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let total = lines.len();
    let number = |i: usize, l: &str| format!("{:>6}\t{}", i + 1, l);
    let head = lines
        .iter()
        .take(5)
        .enumerate()
        .map(|(i, l)| number(i, l))
        .collect::<Vec<_>>()
        .join("\n");
    // Cauda só quando não sobrepõe a cabeça (≤10 linhas = cabeça já cobre tudo).
    let tail = if total > 10 {
        Some(
            lines
                .iter()
                .enumerate()
                .skip(total - 5)
                .map(|(i, l)| number(i, l))
                .collect::<Vec<_>>()
                .join("\n"),
        )
    } else {
        None
    };
    let mut out = format!(
        "⚠️ Saída da tool `{tool}` grande demais ({} bytes, {total} linhas) — gravada em disco pra não estourar seu contexto.\n\n\
         Arquivo completo: {path}\n\n\
         Primeiras linhas:\n{head}",
        text.len(),
    );
    if let Some(tail) = tail {
        out.push_str(&format!("\n  …\nÚltimas linhas:\n{tail}"));
    }
    out.push_str(
        "\n\nLeia PAGINADO com read_file(path, offset, limit) — NÃO leia o arquivo inteiro de uma vez.",
    );
    out
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

    // ── Evict de tool-output grande (helpers puros, sem IO) ─────────────────

    #[test]
    fn evict_stub_has_path_head_tail_and_instruction() {
        let text = (1..=100).map(|i| format!("linha {i}")).collect::<Vec<_>>().join("\n");
        let stub = evict_stub("terminal_read", "/data/tool-results/123-terminal_read.txt", &text);
        // caminho do arquivo completo
        assert!(stub.contains("Arquivo completo: /data/tool-results/123-terminal_read.txt"));
        // primeiras 5 linhas numeradas (nº real da linha)
        assert!(stub.contains("     1\tlinha 1"));
        assert!(stub.contains("     5\tlinha 5"));
        assert!(!stub.contains("\tlinha 6"), "cabeça deve parar na 5ª linha");
        // últimas 5 linhas numeradas
        assert!(stub.contains("    96\tlinha 96"));
        assert!(stub.contains("   100\tlinha 100"));
        assert!(!stub.contains("\tlinha 95"), "cauda deve começar na antepenúltima janela (96)");
        // metadados + instrução de leitura paginada
        assert!(stub.contains("terminal_read"));
        assert!(stub.contains("100 linhas"));
        assert!(stub.contains("read_file(path, offset, limit)"));
        assert!(stub.contains("NÃO leia o arquivo inteiro"));
    }

    #[test]
    fn evict_stub_short_text_has_no_tail() {
        // ≤10 linhas: a cabeça já cobre tudo — sem seção "Últimas linhas" duplicada.
        let text = "a\nb\nc";
        let stub = evict_stub("kanban_list", "/tmp/x.txt", text);
        assert!(stub.contains("     1\ta"));
        assert!(!stub.contains("Últimas linhas"));
        assert!(stub.contains("read_file(path, offset, limit)"));
    }

    #[test]
    fn evict_file_name_sanitizes_tool() {
        // Tool dinâmica (label de agente) não pode injetar path no filename.
        assert_eq!(evict_file_name("terminal_read", 42), "42-terminal_read.txt");
        assert_eq!(evict_file_name("../../etc/passwd", 42), "42-______etc_passwd.txt");
        assert_eq!(evict_file_name("", 7), "7-tool.txt");
    }

    #[test]
    fn evict_threshold_is_about_20k_chars() {
        // Guard de regressão: ~5k tokens por proxy de chars (deepagents-style).
        assert_eq!(EVICT_THRESHOLD_CHARS, 20_000);
    }

    // ── Estágio 1 · pré-flight determinístico (parsers puros + decisão GO/NO-GO) ──

    fn item(sev: &str) -> ReviewHistItem {
        ReviewHistItem {
            file: "x:1".into(),
            category: "security".into(),
            severity: sev.into(),
            title: "t".into(),
        }
    }

    #[test]
    fn decide_1_critical_is_nogo() {
        // 1+ CRITICAL (do pré-flight) já derruba.
        assert_eq!(decide_go_nogo(&[item("CRITICAL")], 0, 0, false), "NO-GO");
    }

    #[test]
    fn decide_2_warnings_is_nogo() {
        // 2+ WARNING = NO-GO; 1 sozinho ainda é GO.
        assert_eq!(decide_go_nogo(&[item("WARNING")], 0, 0, false), "GO");
        assert_eq!(decide_go_nogo(&[item("WARNING"), item("WARNING")], 0, 0, false), "NO-GO");
    }

    #[test]
    fn decide_combines_stages_and_info_is_go() {
        // 1 WARNING do pré-flight + 1 WARNING do Estágio 2 = 2 → NO-GO (contagens somam).
        assert_eq!(decide_go_nogo(&[item("WARNING")], 0, 1, false), "NO-GO");
        // Só INFO/style não bloqueia.
        assert_eq!(decide_go_nogo(&[item("INFO"), item("INFO")], 0, 0, false), "GO");
        // Nada em nenhum estágio → GO.
        assert_eq!(decide_go_nogo(&[], 0, 0, false), "GO");
    }

    #[test]
    fn decide_never_downgrades_ai_nogo() {
        // NO-GO da IA (Estágio 2) nunca é rebaixado, mesmo sem achado no pré-flight.
        assert_eq!(decide_go_nogo(&[], 0, 0, true), "NO-GO");
        // CRITICAL do Estágio 2 (contador) também derruba sem achado no pré-flight.
        assert_eq!(decide_go_nogo(&[], 1, 0, false), "NO-GO");
    }

    #[test]
    fn parse_gitleaks_maps_each_leak_to_critical() {
        let sample = r#"[
            {"RuleID":"aws-access-token","File":"src/cfg.rs","StartLine":42,"Description":"AWS key"},
            {"RuleID":"","File":"lib/db.ts","StartLine":7,"Description":"Generic API Key"}
        ]"#;
        let got = parse_gitleaks(sample);
        assert_eq!(got.len(), 2);
        assert!(got.iter().all(|f| f.severity == "CRITICAL" && f.category == "security"));
        assert_eq!(got[0].file, "src/cfg.rs:42");
        assert!(got[0].title.contains("aws-access-token"));
        // RuleID vazio → cai na Description.
        assert_eq!(got[1].file, "lib/db.ts:7");
        assert!(got[1].title.contains("Generic API Key"));
    }

    #[test]
    fn parse_gitleaks_empty_and_garbage_are_no_findings() {
        assert!(parse_gitleaks("[]").is_empty());
        assert!(parse_gitleaks("not json").is_empty());
        assert!(parse_gitleaks("").is_empty());
    }

    #[test]
    fn parse_semgrep_maps_error_to_critical_with_file_line_rule() {
        let sample = r#"{"results":[
            {"check_id":"python.lang.security.audit.dangerous-exec",
             "path":"app/run.py",
             "start":{"line":13},
             "extra":{"severity":"ERROR","message":"Detected exec usage"}},
            {"check_id":"js.weak","path":"a.js","start":{"line":1},
             "extra":{"severity":"WARNING","message":"weak"}}
        ]}"#;
        let got = parse_semgrep(sample);
        assert_eq!(got.len(), 2);
        assert_eq!(got[0].severity, "CRITICAL");
        assert_eq!(got[0].category, "security");
        assert_eq!(got[0].file, "app/run.py:13");
        assert!(got[0].title.contains("Detected exec usage"));
        assert!(got[0].title.contains("dangerous-exec"));
        // WARNING do semgrep preserva a severidade.
        assert_eq!(got[1].severity, "WARNING");
    }

    #[test]
    fn parse_semgrep_no_results_and_garbage_are_empty() {
        assert!(parse_semgrep(r#"{"results":[]}"#).is_empty());
        assert!(parse_semgrep("boom not json").is_empty());
    }

    #[test]
    fn scan_line_dangers_flags_known_patterns() {
        assert!(scan_line_dangers("const r = eval(userInput);").contains(&"uso de eval("));
        assert!(scan_line_dangers("out = subprocess.run(cmd, shell=True)").contains(&"subprocess shell=True"));
        assert!(scan_line_dangers("data = pickle.loads(buf)").contains(&"pickle.load (desserialização insegura)"));
        assert!(scan_line_dangers("cfg = yaml.load(f)").contains(&"yaml.load sem Loader"));
        // yaml.load COM Loader → não flaga.
        assert!(scan_line_dangers("cfg = yaml.load(f, Loader=SafeLoader)").is_empty());
        // SQL concatenada.
        assert!(scan_line_dangers("db.query(`SELECT * FROM u WHERE id=${id}`)")
            .contains(&"SQL concatenada (possível injeção)"));
        // Comparação de assinatura não-constante.
        assert!(scan_line_dangers("if (signature === expected) {")
            .contains(&"comparação de assinatura não-constante (===)"));
        // hash fraco em contexto de chamada.
        assert!(scan_line_dangers("crypto.createHash('md5')").contains(&"hash fraco (MD5/SHA1)"));
    }

    #[test]
    fn scan_line_dangers_conservative_no_false_positives() {
        // Menção em comentário/nome de variável não deve flagar (conservador).
        assert!(scan_line_dangers("// avoid md5 and sha1 for passwords").is_empty());
        assert!(scan_line_dangers("let evaluation = computeEval();").is_empty());
        assert!(scan_line_dangers("const signatureLabel = 'ok';").is_empty());
        assert!(scan_line_dangers("db.query('SELECT 1')").is_empty());
    }

    #[test]
    fn is_scannable_filters_code_and_skips_tests() {
        use std::path::Path;
        assert!(is_scannable(Path::new("/proj/src/main.rs")));
        assert!(is_scannable(Path::new("/proj/app/handler.ts")));
        // não-código.
        assert!(!is_scannable(Path::new("/proj/README.md")));
        assert!(!is_scannable(Path::new("/proj/data.json")));
        // testes/fixtures/.d.ts.
        assert!(!is_scannable(Path::new("/proj/src/main.test.ts")));
        assert!(!is_scannable(Path::new("/proj/__tests__/x.ts")));
        assert!(!is_scannable(Path::new("/proj/fixtures/sample.py")));
        assert!(!is_scannable(Path::new("/proj/types/api.d.ts")));
    }

    #[test]
    fn render_preflight_lists_findings_and_skips() {
        let report = PreflightReport {
            findings: vec![item("CRITICAL"), item("WARNING")],
            skipped: vec!["semgrep: ferramenta ausente".into()],
        };
        let out = render_preflight(&report);
        assert!(out.contains("2 achado(s)"));
        assert!(out.contains("[CRITICAL/security]"));
        assert!(out.contains("[WARNING/security]"));
        assert!(out.contains("(pulado: semgrep: ferramenta ausente)"));
    }

    #[test]
    fn code_chunks_tool_returns_chunks_for_a_file() {
        let dir = std::env::temp_dir().join(format!("omnirift-chunktool-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sample.rs");
        std::fs::write(&file, "fn alpha() {}\nfn beta() {}\n").unwrap();

        let args = serde_json::json!({ "path": file.to_str().unwrap() });
        let out = super::code_chunks_dispatch(args);
        let v: serde_json::Value = serde_json::from_str(&out).expect("JSON válido");
        let arr = v.get("chunks").and_then(|c| c.as_array()).expect("chunks[]");
        assert!(!arr.is_empty(), "sem chunks: {out}");
        let joined = out.as_str();
        assert!(joined.contains("alpha") && joined.contains("beta"), "faltou símbolo: {out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn code_chunks_tool_errors_clean_on_missing_path() {
        let out = super::code_chunks_dispatch(serde_json::json!({}));
        assert!(out.contains("path"), "erro deve mencionar path: {out}");
    }
}
