//! Classificação do resultado de um upstream (parte PURA; o forward de rede via reqwest
//! é o Plano 2). Decide se o request faz fallback pro próximo alvo e se a chave entra
//! em cooldown.

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    /// 2xx — sucesso, repassa a resposta.
    Ok,
    /// 429/5xx/timeout — tenta o próximo alvo (fallback).
    Retriable,
    /// 4xx (exceto 429) — erro do cliente; repassa SEM fallback (não mascara bug do request).
    ClientError,
}

/// Classifica um status HTTP de upstream.
pub fn classify_status(status: u16) -> Outcome {
    match status {
        429 => Outcome::Retriable,
        500..=599 => Outcome::Retriable,
        400..=499 => Outcome::ClientError,
        _ => Outcome::Ok,
    }
}

/// Este resultado deve pôr a chave em cooldown? (rate-limit/quota = 429).
pub fn is_rate_limited(status: u16) -> bool {
    status == 429
}

/// Resposta de um forward: status + headers + a `reqwest::Response` (corpo consumido
/// como STREAM no relay — não bufferiza).
pub struct ForwardResponse {
    pub status: u16,
    pub headers: reqwest::header::HeaderMap,
    pub resp: reqwest::Response,
}

/// Faz UM forward pro upstream (`base_url` + `path`), injetando a auth conforme o
/// protocolo, repassando o corpo do cliente. NÃO decide fallback — só executa. Erro de
/// rede (timeout/conexão) vira `Err` (o chamador trata como Retriable).
pub async fn forward_once(
    client: &reqwest::Client,
    base_url: &str,
    path: &str,
    protocol: crate::llm_router::Protocol,
    api_key: &str,
    body: bytes::Bytes,
) -> Result<ForwardResponse, String> {
    let url = format!("{}{}", base_url.trim_end_matches('/'), path);
    let mut req = client.post(&url).header("content-type", "application/json");
    req = match protocol {
        crate::llm_router::Protocol::Anthropic => req
            .header("x-api-key", api_key)
            .header("anthropic-version", "2023-06-01"),
        crate::llm_router::Protocol::Openai => req.header("authorization", format!("Bearer {api_key}")),
    };
    let resp = req.body(body).send().await.map_err(|e| format!("forward falhou: {e}"))?;
    Ok(ForwardResponse { status: resp.status().as_u16(), headers: resp.headers().clone(), resp })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rate_limit_is_retriable_and_cools_key() {
        assert_eq!(classify_status(429), Outcome::Retriable);
        assert!(is_rate_limited(429));
    }

    #[test]
    fn server_errors_are_retriable_but_do_not_cool_key() {
        for s in [500u16, 502, 503, 504] {
            assert_eq!(classify_status(s), Outcome::Retriable);
            assert!(!is_rate_limited(s));
        }
    }

    #[test]
    fn client_errors_do_not_fallback() {
        for s in [400u16, 401, 403, 404, 422] {
            assert_eq!(classify_status(s), Outcome::ClientError);
        }
    }

    #[test]
    fn success_is_ok() {
        assert_eq!(classify_status(200), Outcome::Ok);
    }
}
