//! SavingsReport — badge de economia de tokens do OmniCompress.
//!
//! O sidecar `omnicompress-proxy` expõe `GET /stats` (JSON com
//! `tokens_before`/`tokens_after`/`pct`). Aqui consultamos a instância Anthropic
//! (127.0.0.1:8787) — a principal — e devolvemos um [`SavingsReport`] com números
//! REAIS (`estimated = false`). Sob demanda (comando Tauri), NUNCA no boot:
//! se o proxy não responde 200, devolvemos Err e o front trata como "sem dados"
//! (badge oculto), jamais quebra a UI. Fail-open de ponta a ponta.

use std::time::Duration;

use serde::Deserialize;

use super::types::SavingsReport;

/// URL do /stats da instância Anthropic do proxy (a principal). A instância OpenAI
/// (8788) compartilha o mesmo processo de contagem na prática; 8787 é o canônico.
const STATS_URL: &str = "http://127.0.0.1:8787/stats";

/// Timeout curto — é um localhost; se não respondeu rápido, considera "sem dados".
const STATS_TIMEOUT_MS: u64 = 1500;

/// Forma do JSON do contrato `/stats` do omnicompress-proxy.
/// `pct` é tolerante (default 0.0) — se o proxy mandar só before/after, derivamos.
#[derive(Debug, Deserialize)]
struct StatsDto {
    tokens_before: u64,
    tokens_after: u64,
    #[serde(default)]
    pct: f32,
}

/// Consulta o `/stats` do proxy e devolve a economia real. Sob demanda.
/// Err quando o proxy não está de pé / não responde 200 / JSON inválido — o front
/// converte em `null` (badge oculto). NÃO chamar no setup/boot.
pub async fn fetch_savings() -> Result<SavingsReport, String> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_millis(STATS_TIMEOUT_MS))
        .build()
        .map_err(|e| format!("falha ao montar client: {e}"))?;

    let resp = client
        .get(STATS_URL)
        .send()
        .await
        .map_err(|e| format!("proxy /stats indisponível: {e}"))?;

    if !resp.status().is_success() {
        return Err(format!("proxy /stats respondeu {}", resp.status()));
    }

    let dto: StatsDto = resp
        .json()
        .await
        .map_err(|e| format!("JSON do /stats inválido: {e}"))?;

    Ok(to_report(dto.tokens_before, dto.tokens_after, dto.pct))
}

/// Monta o relatório a partir do contrato. `pct`: usa o do proxy se vier (>0);
/// senão deriva de before/after. `estimated = false` — número real do proxy.
fn to_report(tokens_before: u64, tokens_after: u64, pct_in: f32) -> SavingsReport {
    let pct = if pct_in > 0.0 {
        pct_in
    } else if tokens_before > 0 {
        let saved = tokens_before.saturating_sub(tokens_after) as f32;
        (saved / tokens_before as f32) * 100.0
    } else {
        0.0
    };
    SavingsReport {
        tokens_before,
        tokens_after,
        pct,
        estimated: false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn report_uses_proxy_pct_when_present() {
        let r = to_report(12345, 8000, 35.2);
        assert_eq!(r.tokens_before, 12345);
        assert_eq!(r.tokens_after, 8000);
        assert_eq!(r.pct, 35.2);
        assert!(!r.estimated, "número do proxy é real, não estimado");
    }

    #[test]
    fn report_derives_pct_when_missing() {
        // 1000 → 750 = 25% economizado.
        let r = to_report(1000, 750, 0.0);
        assert!((r.pct - 25.0).abs() < 0.01, "pct derivado: {}", r.pct);
        assert!(!r.estimated);
    }

    #[test]
    fn report_handles_zero_before_without_panic() {
        let r = to_report(0, 0, 0.0);
        assert_eq!(r.pct, 0.0);
        assert_eq!(r.tokens_before, 0);
    }
}
