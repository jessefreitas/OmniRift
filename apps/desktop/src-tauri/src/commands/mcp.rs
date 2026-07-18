use crate::db::Db;
use crate::mcp::{registry::to_tool_name, AgentRegistry};
use crate::proc_ext::NoWindow;
use tauri::State;

#[tauri::command]
pub fn mcp_register_agent(
    label: String,
    session_id: String,
    description: String,
    floor: Option<String>,
    // Papel do agente (Frontend/Backend/QA…). O guard anti-duplicata casa por papel
    // além do nome, então quem registra sem role fica fora dessa proteção — aceitável
    // pra nós criados à mão, mas o caminho do orquestrador SEMPRE deve mandar.
    role: Option<String>,
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) {
    registry.register(label, session_id, description, floor, role);
}

/// Desregistra um agente. Prefira SEMPRE mandar o `session_id`: o label pode ter sido
/// SUFIXADO no registro (quando outra sessão viva já ocupava o nome), e desregistrar pelo
/// label original removeria a entrada do OUTRO agente. Sem session_id, cai no label (legado).
#[tauri::command]
pub fn mcp_unregister_agent(
    label: String,
    session_id: Option<String>,
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) {
    match session_id {
        Some(sid) if !sid.is_empty() => {
            registry.unregister_by_session(&sid);
        }
        _ => {
            registry.unregister(&label);
        }
    }
}

#[tauri::command]
pub fn mcp_list_agents(
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) -> Vec<(String, String, String)> {
    registry
        .list()
        .into_iter()
        .map(|(label, entry)| (label.clone(), to_tool_name(&label), entry.description))
        .collect()
}

/// URL SSE do MCP server local, JÁ com o token de auth (`?token=`). É a mesma URL
/// que vai pro agent-mcp.json — o server exige o token em /sse e /message (auditoria #1).
#[tauri::command]
pub fn mcp_server_url(
    token: State<'_, std::sync::Arc<crate::mcp::server::McpAuthToken>>,
) -> String {
    mcp_sse_url(&token.0)
}

/// Monta a URL SSE (loopback) com o token de auth embutido. Fonte única usada pelo
/// comando `mcp_server_url` e pelo `agent_mcp_config` (entrada `omnirift-agents`).
fn mcp_sse_url(token: &str) -> String {
    format!("http://127.0.0.1:{}/sse?token={}", crate::mcp::MCP_PORT, token)
}

/// Salva uma imagem colada (Ctrl+V) em arquivo PNG temporário e devolve o caminho.
/// Os `bytes` já são um PNG válido (encodado no front via <canvas>); aqui só gravamos.
/// Contorna o paste de imagem quebrado no WebKitGTK — o terminal insere o caminho
/// devolvido no stdin do agente (mesma convenção do file-drop).
#[tauri::command]
pub fn save_paste_image(bytes: Vec<u8>) -> Result<String, String> {
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);

    let dir = std::env::temp_dir().join("omnirift-pastes");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    let path = dir.join(format!("paste-{millis}.png"));
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    Ok(path.to_string_lossy().to_string())
}

/// Espelha o estado dos paralelos do front no mirror do backend (lido por
/// `workspace_list`). Comando renomeado floor→parallel (Fase 2 · #6); o ARG
/// `floors` é wire — o front envia `{ floors: { floors, activeParallelId } }`.
#[tauri::command]
pub fn parallel_mirror_set(
    floors: serde_json::Value,
    mirror: State<'_, std::sync::Arc<parking_lot::Mutex<serde_json::Value>>>,
) {
    *mirror.lock() = floors;
}

/// Espelho dos agentes do CANVAS (todos os terminais), separado do `AgentRegistry`
/// (que é o canal CURADO do Orquestrador). O mobile (`agents.list`) lê ESTE espelho
/// pra ver todos os agentes rodando — sem o usuário precisar ativar cada um no canal
/// MCP. Newtype só pra não colidir com o `Arc<Mutex<Value>>` do `parallel_mirror`.
pub struct CanvasAgentsMirror(pub std::sync::Arc<parking_lot::Mutex<serde_json::Value>>);

/// O front espelha aqui TODOS os terminais do canvas — `[{sessionId, label, role, floor}]`.
/// O `state` (working/idle/…) o `agents.list` resolve na hora via `PtyManager`.
#[tauri::command]
pub fn canvas_agents_set(
    agents: serde_json::Value,
    mirror: State<'_, CanvasAgentsMirror>,
) {
    *mirror.0.lock() = agents;
}

/// Detecta o binário do Serena (MCP de estrutura de código por linguagem).
fn which(bin: &str) -> Option<String> {
    // `which` no Unix, `where` no Windows (resolve binário via PATH em ambos).
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = std::process::Command::new(finder).arg(bin).no_window().output().ok()?;
    if !out.status.success() {
        return None;
    }
    // `where` pode devolver múltiplas linhas — fica com a primeira.
    let p = String::from_utf8_lossy(&out.stdout)
        .lines()
        .next()
        .unwrap_or("")
        .trim()
        .to_string();
    if p.is_empty() { None } else { Some(p) }
}

/// Binário `serena` instalado (PATH, uv tools, ou snap do VS Code).
fn serena_binary() -> Option<String> {
    if let Some(p) = which("serena") {
        return Some(p);
    }
    let home = std::env::var("HOME").ok()?;
    for c in [
        format!("{home}/.local/share/uv/tools/serena-agent/bin/serena"),
        format!("{home}/.local/bin/serena"),
    ] {
        if std::path::Path::new(&c).exists() {
            return Some(c);
        }
    }
    // Fallback: dev sob o snap do VS Code (~/snap/code/<rev>/.local/share/uv/...).
    if let Ok(revs) = std::fs::read_dir(format!("{home}/snap/code")) {
        for rev in revs.flatten() {
            let c = rev.path().join(".local/share/uv/tools/serena-agent/bin/serena");
            if c.exists() {
                return Some(c.to_string_lossy().to_string());
            }
        }
    }
    None
}

fn find_uvx() -> Option<String> {
    if let Some(p) = which("uvx") {
        return Some(p);
    }
    let home = std::env::var("HOME").ok()?;
    for c in [format!("{home}/.local/bin/uvx"), format!("{home}/.cargo/bin/uvx")] {
        if std::path::Path::new(&c).exists() {
            return Some(c);
        }
    }
    None
}

/// Como rodar o Serena MCP: (comando, args_prefixo). Tenta o binário instalado;
/// senão cai pro `uvx --from serena-agent serena` (uvx auto-baixa na 1ª execução,
/// então o Serena fica disponível AUTOMATICAMENTE sem instalação manual).
fn find_serena() -> Option<(String, Vec<String>)> {
    if let Some(bin) = serena_binary() {
        return Some((bin, vec![]));
    }
    if let Some(uvx) = find_uvx() {
        return Some((uvx, vec!["--from".into(), "serena-agent".into(), "serena".into()]));
    }
    None
}

/// Monta (e devolve o caminho de) o mcp-config dos agentes claude com o perfil
/// universal de desenvolvimento — independe da linguagem do projeto:
///   - serena   → estrutura de código por linguagem (LSP, 50+ langs), se instalado;
///                --project-from-cwd detecta a linguagem/projeto da pasta do agente.
///   - context7   → documentação ao vivo de libs/frameworks (HTTP remoto, sem creds).
///   - playwright → o agente dirige um browser real (navega/clica/screenshot), headed.
///   - omnicompress → tools de compressão agressiva sob demanda (compress/retrieve/stats),
///                quando o sidecar do MCP existe; o proxy lossless segue transparente.
/// Sempre devolve Some: o Context7 não exige instalação local. Os MCPs de banco
/// (Postgres/MS SQL/Firebase/SQLite) entram como add-on configurável à parte.
#[tauri::command]
pub fn agent_mcp_config(
    app: tauri::AppHandle,
    memory_registry: tauri::State<'_, std::sync::Arc<crate::memory::MemoryRegistry>>,
    db: State<'_, Db>,
    mcp_token: State<'_, std::sync::Arc<crate::mcp::server::McpAuthToken>>,
    allowed: Option<Vec<String>>,
) -> Option<String> {
    use tauri::Manager;
    let mut servers = serde_json::Map::new();

    if let Some((command, prefix)) = find_serena() {
        // prefix = [] (binário direto) OU ["--from","serena-agent","serena"] (uvx).
        let mut args: Vec<serde_json::Value> =
            prefix.into_iter().map(serde_json::Value::from).collect();
        for a in [
            "start-mcp-server", "--transport", "stdio",
            "--project-from-cwd", "--context", "ide-assistant",
            // --open-web-dashboard False: NÃO abre a dashboard do Serena no
            // navegador a cada agente (senão reabre 127.0.0.1:<porta>/dashboard toda hora).
            "--open-web-dashboard", "False",
        ] {
            args.push(serde_json::Value::from(a));
        }
        servers.insert(
            "serena".into(),
            serde_json::json!({ "command": command, "args": args }),
        );
    }
    // Context7: docs ao vivo de qualquer lib via endpoint remoto — sem npx, sem credencial.
    servers.insert(
        "context7".into(),
        serde_json::json!({ "type": "http", "url": "https://mcp.context7.com/mcp" }),
    );
    // Playwright: o agente DIRIGE um browser real (navega/clica/screenshot) em qualquer
    // site, sem o limite de X-Frame do portal. --headed (janela visível) + viewport grande
    // ("maior"). Roda no processo do claude (rede normal, não o WebKitGTK).
    servers.insert(
        "playwright".into(),
        serde_json::json!({
            "command": "npx",
            "args": ["-y", "@playwright/mcp@latest", "--headed", "--viewport-size", "1440,900"]
        }),
    );

    // OmniCompress MCP: tools omnicompress_compress/_retrieve/_stats — compressão
    // AGRESSIVA (lossy + CCR retrievable) sob demanda. Presente em todo agente quando
    // o sidecar existe (igual ao serena), mas só atua quando o agente decide chamar —
    // o proxy lossless segue como camada transparente default. stdio JSON-RPC.
    if let Some(bin) = crate::compress::find_sidecar("omnicompress-mcp") {
        servers.insert(
            "omnicompress".into(),
            serde_json::json!({ "command": bin.to_string_lossy(), "args": [] }),
        );
    }

    // OmniFS MCP (F1): busca semântica + snapshot/log versionados do drive dos
    // agentes. SÓ em modo CLIENTE (`--connect <sock>`) contra o daemon vivo —
    // NUNCA modo direto (o redb do store é SINGLE-WRITER: um 2º processo abrindo
    // o mesmo store corrompe o lock). Gated como o omnicompress: binário presente
    // E socket respondendo; sem daemon o server nem entra no config (fail-soft).
    // ⚠️ `omnifs_rollback` é GLOBAL e NÃO chega aos agentes: o agent-mcp.json só
    // filtra por SERVER (não por tool), então o bloqueio vive no
    // `--disallowed-tools mcp__omnifs__omnifs_rollback` (DENY_DESTRUCTIVE em
    // agent-contract.ts), aplicado a todo agente claude spawnado pelo app.
    {
        let sock = crate::omnifs::socket_path();
        if let Some(bin) = crate::omnifs::find_omnifs_bin() {
            if crate::omnifs::socket_alive(&sock) {
                servers.insert(
                    "omnifs".into(),
                    serde_json::json!({
                        "command": bin.to_string_lossy(),
                        "args": ["--connect", sock.to_string_lossy()]
                    }),
                );
            }
        }
    }

    // Merge da wiring do provider de memória ativo (ex.: omnimemory). Local =
    // wiring vazia → mapa inalterado (zero regressão pro default).
    for (name, spec) in memory_registry.active_provider().agent_wiring().mcp_servers {
        servers.insert(name, spec);
    }

    // MCP servers custom habilitados pelo usuário (Postgres/GitHub/filesystem/…).
    crate::commands::mcp_servers::merge_enabled_into(&db, &mut servers);

    // O PRÓPRIO server de orquestração do OmniRift (SSE @ 127.0.0.1:MCP_PORT):
    // expõe terminal_spawn/terminal_run, claim_*, memory_*, review_current,
    // spec_path_conflicts e a equipe (frontend/backend/…) como tools. Sem esta
    // entrada o config nunca aponta pro server → NEM o Orquestrador NEM os
    // agentes-filho recebem as tools de orquestração (a "equipe via MCP" é
    // anunciada, mas o canal não existe). Reusa o helper mcp_server_url().
    servers.insert(
        "omnirift-agents".into(),
        serde_json::json!({ "type": "sse", "url": mcp_sse_url(&mcp_token.0) }),
    );

    // Curadoria de MCP por-role (budget de contexto → resolve o estouro de 200k):
    // se `allowed` veio, mantém só os servers selecionados e grava num arquivo com
    // nome estável-por-set (FNV-1a, evita corrida entre spawns com filtros diferentes).
    // `None` = todos os servers no `agent-mcp.json` de sempre (zero regressão).
    let (servers, filename) = match &allowed {
        Some(allow) => {
            let keep: std::collections::HashSet<&str> = allow.iter().map(String::as_str).collect();
            let servers: serde_json::Map<String, serde_json::Value> =
                servers.into_iter().filter(|(k, _)| keep.contains(k.as_str())).collect();
            let mut keys: Vec<&str> = servers.keys().map(String::as_str).collect();
            keys.sort_unstable();
            let mut h: u64 = 0xcbf2_9ce4_8422_2325;
            for b in keys.join("\0").bytes() {
                h ^= b as u64;
                h = h.wrapping_mul(0x0000_0100_0000_01b3);
            }
            (servers, format!("agent-mcp-{h:016x}.json"))
        }
        None => (servers, "agent-mcp.json".to_string()),
    };

    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let cfg = serde_json::json!({ "mcpServers": serde_json::Value::Object(servers) });
    let path = dir.join(filename);
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).ok()?).ok()?;
    // 0600: o arquivo carrega o token do MCP control plane (e possível Bearer de
    // provider remoto de memória) → só o dono lê/escreve. Espelha rpc/metadata.rs
    // (runtime.json). Unix-only; no Windows a ACL do app data dir já restringe. (Auditoria #3.)
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o600));
    }
    Some(path.to_string_lossy().to_string())
}

/// Um MCP server que o [`agent_mcp_config`] injetaria, com estimativa de custo de
/// contexto (tokens de schema das tools). Alimenta o medidor de budget do RoleEdit.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpInventoryItem {
    pub key: String,
    pub label: String,
    pub est_tokens: u32,
    /// "builtin" | "memory" | "custom" | "orchestration".
    pub source: String,
    /// false p/ serena/omnicompress não instalados (mostra cinza, não conta no budget).
    pub available: bool,
}

/// Inventário dos MCP servers disponíveis + custo estimado em tokens. Read-only:
/// só LISTA (o gating real vive no `agent_mcp_config(allowed)`). Os números são
/// estimativas de schema (nº de tools × ~tamanho médio) — o omnimemory (~100 tools)
/// é o maior consumidor e o principal responsável pelo estouro de 200k.
#[tauri::command]
pub fn mcp_inventory(
    memory_registry: tauri::State<'_, std::sync::Arc<crate::memory::MemoryRegistry>>,
    db: State<'_, Db>,
) -> Vec<McpInventoryItem> {
    let mut out = vec![
        McpInventoryItem { key: "serena".into(), label: "Serena — estrutura de código (LSP, 50+ langs)".into(), est_tokens: 7000, source: "builtin".into(), available: find_serena().is_some() },
        McpInventoryItem { key: "context7".into(), label: "Context7 — docs ao vivo de libs".into(), est_tokens: 700, source: "builtin".into(), available: true },
        McpInventoryItem { key: "playwright".into(), label: "Playwright — dirige um browser real".into(), est_tokens: 8000, source: "builtin".into(), available: true },
    ];
    if crate::compress::find_sidecar("omnicompress-mcp").is_some() {
        out.push(McpInventoryItem { key: "omnicompress".into(), label: "OmniCompress — compressão sob demanda".into(), est_tokens: 900, source: "builtin".into(), available: true });
    }
    // OmniFS: 5 tools (~900 tokens de schema). `available` = daemon respondendo no
    // socket (o gate real do agent_mcp_config) — binário sem daemon fica cinza.
    if crate::omnifs::find_omnifs_bin().is_some() {
        out.push(McpInventoryItem { key: "omnifs".into(), label: "OmniFS — drive versionado + busca semântica".into(), est_tokens: 900, source: "builtin".into(), available: crate::omnifs::socket_alive(&crate::omnifs::socket_path()) });
    }
    // Provider de memória ativo (omnimemory ~100 tools = o gigante do contexto).
    for (name, _spec) in memory_registry.active_provider().agent_wiring().mcp_servers {
        let est = if name.to_lowercase().contains("memory") || name.to_lowercase().contains("omnimemory") { 32000 } else { 4000 };
        out.push(McpInventoryItem { key: name.clone(), label: format!("Memória — {name}"), est_tokens: est, source: "memory".into(), available: true });
    }
    // MCP servers custom habilitados pelo usuário.
    if let Ok(rows) = db.mcp_list() {
        for r in rows.into_iter().filter(|r| r.enabled) {
            out.push(McpInventoryItem { key: r.name.clone(), label: format!("Custom — {}", r.name), est_tokens: 2500, source: "custom".into(), available: true });
        }
    }
    out.push(McpInventoryItem { key: "omnirift-agents".into(), label: "OmniRift — orquestração (equipe, claims, review)".into(), est_tokens: 3500, source: "orchestration".into(), available: true });
    out
}

/// Define o teto de agentes simultâneos do Orquestrador (clamp 1–16).
#[tauri::command]
pub fn set_max_agents(n: usize, max_agents: State<'_, std::sync::Arc<std::sync::atomic::AtomicUsize>>) {
    max_agents.store(n.clamp(1, 16), std::sync::atomic::Ordering::Relaxed);
}

/// Teto atual de agentes simultâneos.
#[tauri::command]
pub fn get_max_agents(max_agents: State<'_, std::sync::Arc<std::sync::atomic::AtomicUsize>>) -> usize {
    max_agents.load(std::sync::atomic::Ordering::Relaxed)
}
