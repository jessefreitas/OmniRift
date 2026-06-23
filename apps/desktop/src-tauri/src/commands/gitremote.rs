//! Conexões com provedores git remotos (GitHub / Forgejo): listar repos + clonar.
//! Roda no processo nativo (reqwest/git), fora do WebKit. Token vem do frontend
//! por chamada (config em localStorage; keychain = fase futura).

use crate::proc_ext::NoWindow;
use serde::Serialize;
use std::time::Duration;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteRepo {
    pub name: String,
    pub full_name: String,
    /// URL de clone (https).
    pub clone_url: String,
    pub private: bool,
    pub description: String,
    pub default_branch: String,
}

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .user_agent("OmniRift")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

/// Lista os repos do usuário num provider. `kind` = "github" | "forgejo".
/// `base_url` p/ forgejo (ex: https://git.omnimemory.com.br); github usa api.github.com.
#[tauri::command]
pub async fn git_list_repos(kind: String, base_url: String, token: String) -> Result<Vec<RemoteRepo>, String> {
    let token = token.trim().to_string();
    if token.is_empty() {
        return Err("token vazio".into());
    }
    let (url, auth_header, auth_value) = match kind.as_str() {
        "github" => (
            "https://api.github.com/user/repos?per_page=100&sort=updated".to_string(),
            "Authorization",
            format!("Bearer {token}"),
        ),
        "gitlab" => (
            format!("{}/api/v4/projects?membership=true&per_page=100&order_by=last_activity_at", base_url.trim_end_matches('/')),
            "PRIVATE-TOKEN",
            token.clone(),
        ),
        // forgejo / gitea
        _ => (
            format!("{}/api/v1/repos/search?limit=50&exclusive=false", base_url.trim_end_matches('/')),
            "Authorization",
            format!("token {token}"),
        ),
    };
    let resp = http()
        .get(&url)
        .header(auth_header, auth_value)
        .header("Accept", "application/json")
        .send()
        .await
        .map_err(|e| format!("erro de rede: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("{kind} retornou {status}: {}", text.chars().take(200).collect::<String>()));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("resposta não-JSON: {e}"))?;
    // GitHub/GitLab: array no topo. Forgejo search: { data: [...] }.
    let arr = v.as_array().cloned().or_else(|| v.get("data").and_then(|x| x.as_array().cloned())).unwrap_or_default();
    let gitlab = kind == "gitlab"; // GitLab usa nomes de campo próprios.
    let repos = arr
        .iter()
        .map(|r| RemoteRepo {
            name: r.get("name").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            full_name: r
                .get(if gitlab { "path_with_namespace" } else { "full_name" })
                .and_then(|x| x.as_str()).unwrap_or("").to_string(),
            clone_url: r
                .get(if gitlab { "http_url_to_repo" } else { "clone_url" })
                .and_then(|x| x.as_str()).unwrap_or("").to_string(),
            private: if gitlab {
                r.get("visibility").and_then(|x| x.as_str()).map(|vis| vis != "public").unwrap_or(true)
            } else {
                r.get("private").and_then(|x| x.as_bool()).unwrap_or(false)
            },
            description: r.get("description").and_then(|x| x.as_str()).unwrap_or("").to_string(),
            default_branch: r.get("default_branch").and_then(|x| x.as_str()).unwrap_or("main").to_string(),
        })
        .filter(|r| !r.clone_url.is_empty())
        .collect();
    Ok(repos)
}

/// Clona um repo em `dest/<name>`. Embute o token na URL p/ repos privados.
/// Devolve o caminho local do clone. Se já existir, devolve o caminho (não re-clona).
#[tauri::command]
pub fn git_clone(clone_url: String, dest_dir: String, token: Option<String>) -> Result<String, String> {
    let name = clone_url
        .trim_end_matches(".git")
        .rsplit('/')
        .next()
        .unwrap_or("repo")
        .to_string();
    let target = std::path::Path::new(&dest_dir).join(&name);
    if target.exists() {
        return Ok(target.to_string_lossy().to_string());
    }
    std::fs::create_dir_all(&dest_dir).map_err(|e| format!("criar dest: {e}"))?;
    // Token na URL (https://<token>@host/...) p/ clonar privado sem prompt.
    let auth_url = match token.as_deref().map(str::trim).filter(|t| !t.is_empty()) {
        Some(t) if clone_url.starts_with("https://") => clone_url.replacen("https://", &format!("https://{t}@"), 1),
        _ => clone_url.clone(),
    };
    let out = std::process::Command::new("git")
        .args(["clone", "--depth", "50", &auth_url, &target.to_string_lossy()])
        .env("GIT_TERMINAL_PROMPT", "0")
        .no_window()
        .output()
        .map_err(|e| format!("falha ao rodar git: {e}"))?;
    if !out.status.success() {
        // Não vaza o token no erro.
        let err = String::from_utf8_lossy(&out.stderr).replace(&auth_url, &clone_url);
        return Err(format!("git clone falhou: {err}"));
    }
    Ok(target.to_string_lossy().to_string())
}
