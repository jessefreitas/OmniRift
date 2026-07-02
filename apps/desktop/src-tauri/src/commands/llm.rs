//! Cliente LLM multi-provider (BYOK) — roda no processo nativo (reqwest), fora do
//! WebKitGTK (TLS quebrado). Suporta OpenAI-compat (OpenAI/Groq/OpenRouter/Ollama-/v1),
//! Anthropic (Messages API) e Ollama nativo. Usado pelo Code Review (e reusável).

use crate::db::Db;
use serde::Deserialize;
use std::time::Duration;
use tauri::State;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LlmConfig {
    /// "openai" (compat) | "anthropic" | "ollama".
    pub provider: String,
    /// Base URL do provider (preset preenche; ex: https://api.openai.com/v1).
    pub base_url: String,
    pub api_key: Option<String>,
    pub model: String,
}

/// Atribuição da chamada nativa pro ledger (projeto + tipo de uso).
#[derive(Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct LlmMeta {
    /// cwd do projeto ativo (funde com o by_project do usage_scan) ou nome.
    pub project: Option<String>,
    /// "review" | "companion" | "test" | … — pra fatiar o gasto nativo.
    pub kind: Option<String>,
}

/// Resposta do LLM + a usage extraída (tokens entrada/saída).
#[derive(Debug)]
pub struct ChatOut {
    pub text: String,
    pub input: i64,
    pub output: i64,
}

fn client() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(120))
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

fn key(cfg: &LlmConfig) -> &str {
    cfg.api_key.as_deref().unwrap_or("").trim()
}

/// Manda system+prompt pro LLM configurado, grava a chamada no ledger nativo e
/// devolve o texto. O ledger é best-effort — falha de gravação nunca quebra o chat.
#[tauri::command]
pub async fn llm_chat(
    config: LlmConfig,
    system: Option<String>,
    prompt: String,
    meta: Option<LlmMeta>,
    db: State<'_, Db>,
) -> Result<String, String> {
    let out = chat_core(&config, system.as_deref().unwrap_or(""), &prompt).await?;
    let at = chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S").to_string();
    let cost = crate::commands::usage::cost_usd(&config.model, out.input, out.output, 0, 0);
    let m = meta.unwrap_or_default();
    let _ = db.ledger_add(
        &at,
        &config.provider,
        &config.model,
        m.project.as_deref(),
        m.kind.as_deref(),
        out.input,
        out.output,
        cost,
    );
    Ok(out.text)
}

/// Núcleo do chat (sem ledger/State) — roteia pro provider e extrai texto + usage.
/// Separado do command pra ser testável sem o State do Tauri.
async fn chat_core(config: &LlmConfig, sys: &str, prompt: &str) -> Result<ChatOut, String> {
    let base = config.base_url.trim_end_matches('/');
    match config.provider.as_str() {
        "anthropic" => anthropic_chat(base, config, sys, prompt).await,
        "ollama" => ollama_chat(base, config, sys, prompt).await,
        // openai e qualquer OpenAI-compatible (groq/openrouter/together/ollama-/v1)
        _ => openai_chat(base, config, sys, prompt).await,
    }
}

/// Lista os modelos disponíveis no provider configurado (pra escolher na UI).
#[tauri::command]
pub async fn llm_list_models(config: LlmConfig) -> Result<Vec<String>, String> {
    let base = config.base_url.trim_end_matches('/');
    let k = key(&config);
    let req = match config.provider.as_str() {
        "anthropic" => client()
            .get(format!("{base}/v1/models"))
            .header("x-api-key", k)
            .header("anthropic-version", "2023-06-01"),
        "ollama" => {
            let r = client().get(format!("{base}/api/tags"));
            if k.is_empty() { r } else { r.bearer_auth(k) }
        }
        // openai-compat (openai/gemini/groq/openrouter/…)
        _ => {
            let r = client().get(format!("{base}/models"));
            if k.is_empty() { r } else { r.bearer_auth(k) }
        }
    };
    let v = send(req).await?;
    // openai/anthropic → data[].id ; ollama → models[].name
    let mut out: Vec<String> = if let Some(data) = v.get("data").and_then(|x| x.as_array()) {
        data.iter().filter_map(|m| m.get("id").and_then(|x| x.as_str()).map(String::from)).collect()
    } else if let Some(models) = v.get("models").and_then(|x| x.as_array()) {
        models.iter().filter_map(|m| m.get("name").and_then(|x| x.as_str()).map(String::from)).collect()
    } else {
        Vec::new()
    };
    out.sort();
    out.dedup();
    Ok(out)
}

/// Roda o CLI local headless (`claude -p "<prompt>"`) e devolve o stdout — caminho
/// SEM CHAVE: usa a subscription que o usuário já paga no próprio CLI (Claude Code,
/// wrappers como claude-glm52) em vez de BYOK/Central. Spawn DIRETO, sem shell
/// (zero problema de quoting); o PATH do shell de login já foi adotado no boot
/// (inherit_login_shell_path), então acha o mesmo binário do terminal do usuário.
#[tauri::command]
pub async fn llm_via_cli(prompt: String, cli: Option<String>, cwd: Option<String>) -> Result<String, String> {
    let bin = cli.unwrap_or_else(|| "claude".to_string());
    cli_run(&bin, &prompt, Duration::from_secs(180), cwd.as_deref()).await
}

/// Núcleo do CLI (testável sem o State do Tauri): spawna, espera com timeout e
/// resume o erro. `kill_on_drop(true)`: se o timeout cancelar o wait, o filho morre
/// junto do drop — sem leak de processo (mesma lição do clone_killer do pty_kill).
/// `cwd`: diretório de trabalho do CLI (opcional) — o Aprender ancora o tutor no
/// projeto do aprendiz; `None` = comportamento original (cwd do app).
async fn cli_run(bin: &str, prompt: &str, timeout: Duration, cwd: Option<&str>) -> Result<String, String> {
    use std::process::Stdio;
    let mut cmd = tokio::process::Command::new(bin);
    cmd.args(["-p", prompt])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    let child = cmd
        .spawn()
        .map_err(|e| format!("não consegui rodar `{bin}`: {e}"))?;
    let out = tokio::time::timeout(timeout, child.wait_with_output())
        .await
        .map_err(|_| format!("`{bin}` estourou o timeout de {}s (processo finalizado)", timeout.as_secs()))?
        .map_err(|e| format!("falha lendo o output de `{bin}`: {e}"))?;
    let stdout = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if out.status.success() && !stdout.is_empty() {
        return Ok(stdout);
    }
    // Falhou (ou saiu limpo mas mudo): o stderr é onde o CLI explica — não logado,
    // flag desconhecida, wrapper quebrado… Resume pra caber no toast da UI.
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let brief: String = if stderr.is_empty() { stdout } else { stderr }.chars().take(500).collect();
    Err(format!("`{bin}` saiu com {}: {brief}", out.status))
}

async fn openai_chat(base: &str, cfg: &LlmConfig, sys: &str, prompt: &str) -> Result<ChatOut, String> {
    let mut messages = Vec::new();
    if !sys.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({ "model": cfg.model, "messages": messages, "temperature": 0.1 });
    let mut req = client().post(format!("{base}/chat/completions")).json(&body);
    let k = key(cfg);
    if !k.is_empty() {
        req = req.bearer_auth(k);
    }
    let v = send(req).await?;
    let text = v
        .pointer("/choices/0/message/content")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("resposta sem choices[0].message.content: {v}"))?;
    let input = v.pointer("/usage/prompt_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let output = v.pointer("/usage/completion_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    Ok(ChatOut { text, input, output })
}

async fn anthropic_chat(base: &str, cfg: &LlmConfig, sys: &str, prompt: &str) -> Result<ChatOut, String> {
    let body = serde_json::json!({
        "model": cfg.model,
        "max_tokens": 4096,
        "system": sys,
        "messages": [{ "role": "user", "content": prompt }],
    });
    let req = client()
        .post(format!("{base}/v1/messages"))
        .header("x-api-key", key(cfg))
        .header("anthropic-version", "2023-06-01")
        .json(&body);
    let v = send(req).await?;
    let text = v
        .pointer("/content/0/text")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("resposta sem content[0].text: {v}"))?;
    let input = v.pointer("/usage/input_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    let output = v.pointer("/usage/output_tokens").and_then(|x| x.as_i64()).unwrap_or(0);
    Ok(ChatOut { text, input, output })
}

async fn ollama_chat(base: &str, cfg: &LlmConfig, sys: &str, prompt: &str) -> Result<ChatOut, String> {
    let mut messages = Vec::new();
    if !sys.is_empty() {
        messages.push(serde_json::json!({ "role": "system", "content": sys }));
    }
    messages.push(serde_json::json!({ "role": "user", "content": prompt }));
    let body = serde_json::json!({ "model": cfg.model, "messages": messages, "stream": false });
    let mut req = client().post(format!("{base}/api/chat")).json(&body);
    // Ollama Cloud (ollama.com) exige Bearer; Ollama local não usa (key vazia → sem header).
    let k = key(cfg);
    if !k.is_empty() {
        req = req.bearer_auth(k);
    }
    let v = send(req).await?;
    let text = v
        .pointer("/message/content")
        .and_then(|x| x.as_str())
        .map(|s| s.to_string())
        .ok_or_else(|| format!("resposta sem message.content: {v}"))?;
    let input = v.pointer("/prompt_eval_count").and_then(|x| x.as_i64()).unwrap_or(0);
    let output = v.pointer("/eval_count").and_then(|x| x.as_i64()).unwrap_or(0);
    Ok(ChatOut { text, input, output })
}

/// Envia a request, valida status e devolve o JSON; erro carrega o corpo.
async fn send(req: reqwest::RequestBuilder) -> Result<serde_json::Value, String> {
    let resp = req.send().await.map_err(|e| format!("erro de rede: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("LLM retornou {status}: {text}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("resposta não-JSON ({e}): {text}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn openai_parses_completion_and_usage_against_stub() {
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(|| async {
                "{\"choices\":[{\"message\":{\"role\":\"assistant\",\"content\":\"ok-resposta\"}}],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":5}}"
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(Duration::from_millis(80)).await;

        let cfg = LlmConfig {
            provider: "openai".into(),
            base_url: format!("http://{addr}"),
            api_key: Some("k".into()),
            model: "m".into(),
        };
        let out = chat_core(&cfg, "sys", "oi").await.unwrap();
        assert_eq!(out.text, "ok-resposta");
        assert_eq!((out.input, out.output), (12, 5));
    }

    #[tokio::test]
    async fn http_error_carries_body() {
        let app = axum::Router::new().route(
            "/chat/completions",
            axum::routing::post(|| async {
                (axum::http::StatusCode::UNAUTHORIZED, "no auth")
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap();
        tokio::spawn(async move { axum::serve(listener, app).await.unwrap(); });
        tokio::time::sleep(Duration::from_millis(80)).await;

        let cfg = LlmConfig {
            provider: "openai".into(),
            base_url: format!("http://{addr}"),
            api_key: None,
            model: "m".into(),
        };
        let err = chat_core(&cfg, "", "x").await.unwrap_err();
        assert!(err.contains("401") && err.contains("no auth"), "err: {err}");
    }

    #[tokio::test]
    async fn cli_run_captures_stdout_without_shell() {
        // `echo -p <prompt>` imprime os args → prova spawn direto (sem shell) + captura
        // do stdout, inclusive com aspas/acentos no prompt (zero quoting).
        let out = cli_run("echo", "diga \"olá\" à equipe", Duration::from_secs(10), None).await.unwrap();
        assert!(out.contains("diga \"olá\" à equipe"), "out: {out}");
    }

    #[tokio::test]
    async fn cli_run_missing_binary_is_clear_error() {
        let err = cli_run("omnirift-cli-inexistente-xyz", "x", Duration::from_secs(5), None).await.unwrap_err();
        assert!(err.contains("não consegui rodar"), "err: {err}");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_run_honors_cwd() {
        use std::os::unix::fs::PermissionsExt;
        // script que imprime o getcwd → prova que `cwd: Some(dir)` ancora o processo
        // no diretório do projeto (é o que o tutor do Aprender usa).
        let dir = std::env::temp_dir().join(format!("omnirift-cli-cwd-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("pwdcli.sh");
        std::fs::write(&script, "#!/bin/sh\npwd -P\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let canon = std::fs::canonicalize(&dir).unwrap();
        let out = cli_run(script.to_str().unwrap(), "x", Duration::from_secs(10), canon.to_str()).await.unwrap();
        assert_eq!(out.trim(), canon.to_str().unwrap(), "out: {out}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn cli_run_timeout_kills_child_and_errors() {
        use std::os::unix::fs::PermissionsExt;
        // script que ignora os args e dorme → força o caminho do timeout (kill_on_drop).
        let dir = std::env::temp_dir().join(format!("omnirift-cli-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let script = dir.join("slowcli.sh");
        std::fs::write(&script, "#!/bin/sh\nsleep 30\n").unwrap();
        std::fs::set_permissions(&script, std::fs::Permissions::from_mode(0o755)).unwrap();

        let err = cli_run(script.to_str().unwrap(), "x", Duration::from_millis(300), None).await.unwrap_err();
        assert!(err.contains("timeout"), "err: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
