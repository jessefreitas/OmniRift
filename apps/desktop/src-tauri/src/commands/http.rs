//! Cliente HTTP pro API node (mini-Postman). Roda no Rust via reqwest → não pega o
//! TLS quebrado do WebKitGTK, e rustls evita depender do OpenSSL do sistema.

use serde::Serialize;
use std::collections::HashMap;
use std::net::IpAddr;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HttpResponse {
    pub status: u16,
    pub status_text: String,
    pub headers: Vec<(String, String)>,
    pub body: String,
    pub duration_ms: u64,
}

/// True se o IP cai numa faixa interna que o guard de SSRF deve bloquear: loopback,
/// link-local (incl. 169.254.169.254 = metadata de cloud), RFC1918, CGNAT, ULA IPv6,
/// e unspecified/broadcast. IPv4-mapped IPv6 (::ffff:a.b.c.d) é reavaliado como IPv4.
fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            v4.is_loopback()        // 127.0.0.0/8
                || v4.is_private()  // 10/8, 172.16/12, 192.168/16
                || v4.is_link_local() // 169.254.0.0/16 (inclui o IP de metadata)
                || v4.is_unspecified() // 0.0.0.0
                || v4.is_broadcast()   // 255.255.255.255
                || (o[0] == 100 && (o[1] & 0xc0) == 64) // CGNAT 100.64.0.0/10
        }
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return is_blocked_ip(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback()        // ::1
                || v6.is_unspecified() // ::
                || (first & 0xfe00) == 0xfc00 // ULA fc00::/7
                || (first & 0xffc0) == 0xfe80 // link-local fe80::/10
        }
    }
}

/// Guard de SSRF (Fix de auditoria #4): por DEFAULT rejeita destinos internos
/// (loopback / link-local / RFC1918 / ULA). Resolve o host da URL e checa TODOS os IPs
/// resolvidos. Cliente tipo Postman: hosts públicos seguem funcionando. NOTA: há um
/// TOCTOU residual (reqwest re-resolve o DNS) — mitigação completa exigiria pinar o IP
/// resolvido no connect; fora do escopo deste fix mínimo.
async fn guard_ssrf(url: &str) -> Result<(), String> {
    let parsed = reqwest::Url::parse(url).map_err(|e| format!("URL inválida: {e}"))?;
    // Só HTTP/HTTPS (bloqueia file://, gopher://, etc. — não fazem sentido aqui).
    match parsed.scheme() {
        "http" | "https" => {}
        s => return Err(format!("esquema não suportado: {s}")),
    }
    let host = parsed
        .host_str()
        .ok_or_else(|| "URL sem host".to_string())?
        .to_string();
    let port = parsed.port_or_known_default().unwrap_or(443);
    // Tira colchetes de literal IPv6 ([::1] → ::1).
    let host_clean = host.trim_start_matches('[').trim_end_matches(']').to_string();

    // IP literal: checa direto, sem DNS.
    if let Ok(ip) = host_clean.parse::<IpAddr>() {
        if is_blocked_ip(ip) {
            return Err(format!("destino bloqueado (rede interna): {ip}"));
        }
        return Ok(());
    }

    // Hostname: resolve (getaddrinfo é bloqueante → spawn_blocking) e checa todos os IPs.
    let target = format!("{host_clean}:{port}");
    let host_for_err = host_clean.clone();
    let ips = tokio::task::spawn_blocking(move || {
        use std::net::ToSocketAddrs;
        target.to_socket_addrs().map(|it| it.map(|sa| sa.ip()).collect::<Vec<_>>())
    })
    .await
    .map_err(|e| format!("falha ao resolver host: {e}"))?
    .map_err(|e| format!("não resolvi host '{host_for_err}': {e}"))?;

    if ips.is_empty() {
        return Err(format!("host '{host_clean}' não resolveu para nenhum IP"));
    }
    for ip in ips {
        if is_blocked_ip(ip) {
            return Err(format!("destino bloqueado (rede interna): {host_clean} → {ip}"));
        }
    }
    Ok(())
}

/// Faz uma requisição HTTP e devolve status + headers + corpo + tempo.
#[tauri::command]
pub async fn http_request(
    method: String,
    url: String,
    headers: HashMap<String, String>,
    body: Option<String>,
) -> Result<HttpResponse, String> {
    // SSRF guard: bloqueia loopback/link-local/RFC1918 antes de qualquer conexão.
    guard_ssrf(&url).await?;
    let m = reqwest::Method::from_bytes(method.to_uppercase().as_bytes())
        .map_err(|e| format!("método inválido: {e}"))?;
    let client = reqwest::Client::builder()
        .build()
        .map_err(|e| e.to_string())?;
    let mut req = client.request(m, &url);
    for (k, v) in &headers {
        req = req.header(k, v);
    }
    if let Some(b) = body {
        if !b.is_empty() {
            req = req.body(b);
        }
    }
    let start = std::time::Instant::now();
    let resp = req.send().await.map_err(|e| format!("falha na requisição: {e}"))?;
    let status = resp.status();
    let resp_headers: Vec<(String, String)> = resp
        .headers()
        .iter()
        .map(|(k, v)| (k.to_string(), v.to_str().unwrap_or("").to_string()))
        .collect();
    let text = resp.text().await.map_err(|e| format!("falha ao ler corpo: {e}"))?;
    Ok(HttpResponse {
        status: status.as_u16(),
        status_text: status.canonical_reason().unwrap_or("").to_string(),
        headers: resp_headers,
        body: text,
        duration_ms: start.elapsed().as_millis() as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blocks_internal_ipv4_ranges() {
        for ip in [
            "127.0.0.1",        // loopback
            "10.0.0.5",         // RFC1918
            "172.16.0.1",       // RFC1918
            "192.168.1.1",      // RFC1918
            "169.254.169.254",  // link-local / metadata cloud
            "0.0.0.0",          // unspecified
            "100.64.0.1",       // CGNAT
        ] {
            assert!(is_blocked_ip(ip.parse().unwrap()), "deveria bloquear {ip}");
        }
    }

    #[test]
    fn allows_public_ipv4() {
        for ip in ["8.8.8.8", "1.1.1.1", "93.184.216.34"] {
            assert!(!is_blocked_ip(ip.parse().unwrap()), "não deveria bloquear {ip}");
        }
    }

    #[test]
    fn blocks_internal_ipv6_and_mapped() {
        for ip in ["::1", "::", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1"] {
            assert!(is_blocked_ip(ip.parse().unwrap()), "deveria bloquear {ip}");
        }
        assert!(!is_blocked_ip("2606:4700:4700::1111".parse().unwrap()));
    }

    #[tokio::test]
    async fn guard_rejects_loopback_literal_and_bad_scheme() {
        assert!(guard_ssrf("http://127.0.0.1:8080/x").await.is_err());
        assert!(guard_ssrf("http://[::1]/x").await.is_err());
        assert!(guard_ssrf("file:///etc/passwd").await.is_err());
        assert!(guard_ssrf("not a url").await.is_err());
    }
}
