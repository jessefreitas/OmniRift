//! Comandos Tauri da camada de compressores (BYO instalável pelo app).
//! `compressor_list` enumera o catálogo + estado de detecção pra UI listar e
//! instalar (o frontend roda o `installHint` num terminal, igual ao instalador de CLIs).

use serde::Serialize;

use crate::compress::{Compressor, HeadroomProvider, RtkProvider};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CompressorInfo {
    pub kind: String,
    pub label: String,
    /// "shell" (RTK, saída de comando) | "llm" (Headroom, chamada ao modelo).
    pub layer: String,
    pub installed: bool,
    pub version: Option<String>,
    /// Comando de instalação (o app roda num terminal — BYO instalável).
    pub install_hint: String,
}

#[tauri::command]
pub fn compressor_list() -> Vec<CompressorInfo> {
    let entries: Vec<(Box<dyn Compressor>, &str, &str)> = vec![
        (Box::new(RtkProvider), "RTK · Rust Token Killer", "shell"),
        (Box::new(HeadroomProvider), "Headroom", "llm"),
    ];
    entries
        .into_iter()
        .map(|(p, label, layer)| {
            let d = p.detect();
            CompressorInfo {
                kind: p.kind().as_str().to_string(),
                label: label.to_string(),
                layer: layer.to_string(),
                installed: d.installed,
                version: d.version,
                install_hint: d.install_hint,
            }
        })
        .collect()
}
