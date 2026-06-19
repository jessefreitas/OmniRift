//! Comandos Tauri da camada de compressores (BYO instalável pelo app).
//! `compressor_list` enumera o catálogo + estado de detecção pra UI listar e
//! instalar (o frontend roda o `installHint` num terminal, igual ao instalador de CLIs).

use serde::Serialize;

use crate::compress::{Compressor, HeadroomProvider, OmnicompressProvider, RtkProvider};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorInfo {
    pub kind: String,
    pub label: String,
    /// "shell" (RTK, saída de comando) | "llm" (proxy, chamada ao modelo).
    pub layer: String,
    pub installed: bool,
    pub version: Option<String>,
    /// Comando de instalação (o app roda num terminal — BYO instalável).
    pub install_hint: String,
    /// true = compressor NATIVO do OmniRift (OmniCompress), ligado por padrão.
    pub native: bool,
}

#[tauri::command]
pub fn compressor_list() -> Vec<CompressorInfo> {
    // OmniCompress primeiro = nativo, ligado por padrão. `installed` dele = proxy
    // REACHABLE (não só binário), então ligar por padrão é seguro (ver omnicompress.rs).
    let entries: Vec<(Box<dyn Compressor>, &str, &str, bool)> = vec![
        (Box::new(OmnicompressProvider), "OmniCompress", "llm", true),
        (Box::new(RtkProvider), "RTK · Rust Token Killer", "shell", false),
        (Box::new(HeadroomProvider), "Headroom", "llm", false),
    ];
    entries
        .into_iter()
        .map(|(p, label, layer, native)| {
            let d = p.detect();
            CompressorInfo {
                kind: p.kind().as_str().to_string(),
                label: label.to_string(),
                layer: layer.to_string(),
                installed: d.installed,
                version: d.version,
                install_hint: d.install_hint,
                native,
            }
        })
        .collect()
}
