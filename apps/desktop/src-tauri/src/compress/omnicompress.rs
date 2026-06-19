//! OmnicompressProvider — OmniCompress: comprime o contexto LLM via proxy local
//! (BASE_URL → 127.0.0.1:8787). É o compressor **nativo** do OmniRift, ligado por
//! padrão. Fonte: https://github.com/jessefreitas/OmniCompress.
//!
//! Segurança (importante): ligar por padrão e apontar o BASE_URL pro proxy
//! quebraria TODO agente se o proxy não estivesse de pé. Por isso `detect` checa
//! REACHABILITY (TCP rápido) — e o frontend só injeta a env quando o proxy
//! responde. Sem proxy → no-op, o agente fala direto com o provider (fail-open).

use std::net::{TcpStream, ToSocketAddrs};
use std::time::Duration;

use super::provider::Compressor;
use super::types::{CliFamily, CompressorKind, DetectStatus, SpawnDecoration};

// Duas instâncias (o proxy tem 1 upstream fixo por instância) — espelha
// compress/proxy.rs. Claude → anthropic; demais → openai.
const ANTHROPIC_PROXY: &str = "http://127.0.0.1:8787";
const OPENAI_PROXY: &str = "http://127.0.0.1:8788";
const INSTALL_HINT: &str =
    "cargo install --git https://github.com/jessefreitas/OmniCompress omnicompress-proxy";

/// host:port do proxy (tira o esquema) pra checagem de socket.
fn proxy_host_port(url: &str) -> String {
    url.trim()
        .trim_start_matches("http://")
        .trim_start_matches("https://")
        .trim_end_matches('/')
        .to_string()
}

/// O proxy está de pé? TCP connect rápido (250ms) — não bloqueia o app.
fn proxy_reachable(url: &str) -> bool {
    let hp = proxy_host_port(url);
    let Ok(mut addrs) = hp.to_socket_addrs() else { return false };
    addrs.next().is_some_and(|addr| TcpStream::connect_timeout(&addr, Duration::from_millis(250)).is_ok())
}

pub struct OmnicompressProvider;

impl Compressor for OmnicompressProvider {
    fn kind(&self) -> CompressorKind {
        CompressorKind::Omnicompress
    }

    fn detect(&self) -> DetectStatus {
        // "up" = a instância anthropic responde (o gerenciador sobe as duas juntas).
        // Reachability (não só binário) → ligar por padrão é seguro: sem proxy o
        // front não injeta a env e o agente fala direto (fail-open).
        DetectStatus {
            installed: proxy_reachable(ANTHROPIC_PROXY),
            version: None,
            install_hint: INSTALL_HINT.to_string(),
        }
    }

    fn decorate(&self, cli: CliFamily, _node_id: &str, deco: &mut SpawnDecoration) {
        // Family-aware (cada upstream tem seu proxy). SÓ env, invariante.
        match cli {
            CliFamily::Shell => {} // shell não fala com LLM
            CliFamily::Claude => {
                deco.env.push(("ANTHROPIC_BASE_URL".into(), ANTHROPIC_PROXY.into()));
            }
            _ => {
                deco.env.push(("OPENAI_BASE_URL".into(), OPENAI_PROXY.into()));
                deco.env.push(("OPENAI_API_BASE".into(), OPENAI_PROXY.into()));
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn host_port_strips_scheme_and_slash() {
        assert_eq!(proxy_host_port("http://127.0.0.1:8787"), "127.0.0.1:8787");
        assert_eq!(proxy_host_port("https://localhost:9/"), "localhost:9");
    }

    #[test]
    fn decorate_skips_shell_injects_llm() {
        let mut shell = SpawnDecoration::default();
        OmnicompressProvider.decorate(CliFamily::Shell, "n", &mut shell);
        assert!(shell.env.is_empty(), "Shell não passa pelo proxy");

        // Claude → só Anthropic (proxy 8787).
        let mut claude = SpawnDecoration::default();
        OmnicompressProvider.decorate(CliFamily::Claude, "n", &mut claude);
        assert!(claude.env.iter().any(|(k, v)| k == "ANTHROPIC_BASE_URL" && v.contains("8787")));
        assert!(!claude.env.iter().any(|(k, _)| k == "OPENAI_BASE_URL"));

        // Codex → só OpenAI (proxy 8788).
        let mut codex = SpawnDecoration::default();
        OmnicompressProvider.decorate(CliFamily::Codex, "n", &mut codex);
        assert!(codex.env.iter().any(|(k, v)| k == "OPENAI_BASE_URL" && v.contains("8788")));
        assert!(!codex.env.iter().any(|(k, _)| k == "ANTHROPIC_BASE_URL"));
    }
}
