//! Screenshot de qualquer URL via Playwright (chromium) — SUPERA o portal iframe:
//! renderiza HTTPS externo que o iframe recusa (X-Frame-Options) e que o WebKitGTK
//! não carrega (TLS quebrado). Usa o MESMO Playwright que os agentes dirigem, então
//! é a base pro "browser dirigido por agente" visualizado no canvas.

use crate::proc_ext::NoWindow;
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

/// base64 padrão (sem dependência externa) pra devolver o PNG como data-URL.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for c in data.chunks(3) {
        let b = [c[0], *c.get(1).unwrap_or(&0), *c.get(2).unwrap_or(&0)];
        out.push(T[(b[0] >> 2) as usize] as char);
        out.push(T[(((b[0] & 3) << 4) | (b[1] >> 4)) as usize] as char);
        out.push(if c.len() > 1 { T[(((b[1] & 15) << 2) | (b[2] >> 6)) as usize] as char } else { '=' });
        out.push(if c.len() > 2 { T[(b[2] & 63) as usize] as char } else { '=' });
    }
    out
}

/// Tira um screenshot da URL e devolve um `data:image/png;base64,…` pra exibir no node.
#[tauri::command]
pub async fn browser_shot(url: String) -> Result<String, String> {
    let url = url.trim().to_string();
    if !(url.starts_with("http://") || url.starts_with("https://")) {
        return Err("URL deve começar com http:// ou https://".into());
    }
    let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("omnirift-shot-{nanos}.png"));
    let tmp_s = tmp.to_string_lossy().to_string();
    let url2 = url.clone();
    let tmp_run = tmp_s.clone();

    let out = tokio::task::spawn_blocking(move || {
        Command::new("playwright")
            .args([
                "screenshot",
                "--viewport-size=1280,800",
                "--wait-for-timeout=2500",
                &url2,
                &tmp_run,
            ])
            .no_window()
            .output()
    })
    .await
    .map_err(|e| format!("join: {e}"))?
    .map_err(|e| format!("playwright não encontrado no PATH: {e}"))?;

    if !out.status.success() {
        let _ = std::fs::remove_file(&tmp);
        let err = String::from_utf8_lossy(&out.stderr);
        return Err(format!("screenshot falhou: {}", err.lines().last().unwrap_or("erro").trim()));
    }
    let bytes = std::fs::read(&tmp).map_err(|e| format!("ler png: {e}"))?;
    let _ = std::fs::remove_file(&tmp);
    Ok(format!("data:image/png;base64,{}", b64(&bytes)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn b64_encoda_certo() {
        assert_eq!(b64(b"Man"), "TWFu");
        assert_eq!(b64(b"Ma"), "TWE=");
        assert_eq!(b64(b"M"), "TQ==");
        assert_eq!(b64(b""), "");
    }
}
