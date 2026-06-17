//! Login no GitHub via OAuth Device Flow (ideal p/ desktop — sem servidor de
//! redirect). O usuário registra um OAuth App "OmniRift" (client_id público) e
//! autoriza no navegador; o app recebe o access_token. Escopo: repo.

use serde::Serialize;
use std::time::Duration;

fn http() -> reqwest::Client {
    reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .user_agent("OmniRift")
        .build()
        .unwrap_or_else(|_| reqwest::Client::new())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceStart {
    pub device_code: String,
    pub user_code: String,
    pub verification_uri: String,
    pub interval: u64,
    pub expires_in: u64,
}

/// Passo 1: pede o device code. Devolve o code que o user digita + a URL.
#[tauri::command]
pub async fn github_device_start(client_id: String) -> Result<DeviceStart, String> {
    if client_id.trim().is_empty() {
        return Err("client_id vazio (registre um OAuth App no GitHub)".into());
    }
    let resp = http()
        .post("https://github.com/login/device/code")
        .header("Accept", "application/json")
        .form(&[("client_id", client_id.trim()), ("scope", "repo")])
        .send()
        .await
        .map_err(|e| format!("erro de rede: {e}"))?;
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("resposta inválida: {e}"))?;
    if let Some(err) = v.get("error").and_then(|x| x.as_str()) {
        return Err(format!("GitHub: {err} — {}", v.get("error_description").and_then(|x| x.as_str()).unwrap_or("")));
    }
    Ok(DeviceStart {
        device_code: v.get("device_code").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        user_code: v.get("user_code").and_then(|x| x.as_str()).unwrap_or("").to_string(),
        verification_uri: v.get("verification_uri").and_then(|x| x.as_str()).unwrap_or("https://github.com/login/device").to_string(),
        interval: v.get("interval").and_then(|x| x.as_u64()).unwrap_or(5),
        expires_in: v.get("expires_in").and_then(|x| x.as_u64()).unwrap_or(900),
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DevicePoll {
    /// "ok" (tem token) | "pending" | "slow_down" | "error".
    pub status: String,
    pub token: Option<String>,
    pub error: Option<String>,
}

/// Passo 2: faz UM poll do token. O frontend repete a cada `interval`s até "ok".
#[tauri::command]
pub async fn github_device_poll(client_id: String, device_code: String) -> Result<DevicePoll, String> {
    let resp = http()
        .post("https://github.com/login/oauth/access_token")
        .header("Accept", "application/json")
        .form(&[
            ("client_id", client_id.trim()),
            ("device_code", device_code.trim()),
            ("grant_type", "urn:ietf:params:oauth:grant-type:device_code"),
        ])
        .send()
        .await
        .map_err(|e| format!("erro de rede: {e}"))?;
    let v: serde_json::Value = resp.json().await.map_err(|e| format!("resposta inválida: {e}"))?;
    if let Some(tok) = v.get("access_token").and_then(|x| x.as_str()) {
        return Ok(DevicePoll { status: "ok".into(), token: Some(tok.to_string()), error: None });
    }
    let err = v.get("error").and_then(|x| x.as_str()).unwrap_or("");
    let status = match err {
        "authorization_pending" => "pending",
        "slow_down" => "slow_down",
        _ => "error",
    };
    Ok(DevicePoll { status: status.into(), token: None, error: if status == "error" { Some(err.to_string()) } else { None } })
}
