use crate::db::Db;
use crate::mcp::{registry::to_tool_name, AgentRegistry};
use tauri::State;

#[tauri::command]
pub fn mcp_register_agent(
    label: String,
    session_id: String,
    description: String,
    floor: Option<String>,
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) {
    registry.register(label, session_id, description, floor);
}

#[tauri::command]
pub fn mcp_unregister_agent(
    label: String,
    registry: State<'_, std::sync::Arc<AgentRegistry>>,
) {
    registry.unregister(&label);
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

#[tauri::command]
pub fn mcp_server_url() -> String {
    "http://127.0.0.1:7844/sse".to_string()
}

#[tauri::command]
pub fn floor_mirror_set(
    floors: serde_json::Value,
    mirror: State<'_, std::sync::Arc<parking_lot::Mutex<serde_json::Value>>>,
) {
    *mirror.lock() = floors;
}

/// Detecta o binário do Serena (MCP de estrutura de código por linguagem).
fn which(bin: &str) -> Option<String> {
    // `which` no Unix, `where` no Windows (resolve binário via PATH em ambos).
    let finder = if cfg!(windows) { "where" } else { "which" };
    let out = std::process::Command::new(finder).arg(bin).output().ok()?;
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

    // Merge da wiring do provider de memória ativo (ex.: omnimemory). Local =
    // wiring vazia → mapa inalterado (zero regressão pro default).
    for (name, spec) in memory_registry.active_provider().agent_wiring().mcp_servers {
        servers.insert(name, spec);
    }

    // MCP servers custom habilitados pelo usuário (Postgres/GitHub/filesystem/…).
    crate::commands::mcp_servers::merge_enabled_into(&db, &mut servers);

    let dir = app.path().app_data_dir().ok()?;
    std::fs::create_dir_all(&dir).ok()?;
    let cfg = serde_json::json!({ "mcpServers": serde_json::Value::Object(servers) });
    let path = dir.join("agent-mcp.json");
    std::fs::write(&path, serde_json::to_string_pretty(&cfg).ok()?).ok()?;
    Some(path.to_string_lossy().to_string())
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
