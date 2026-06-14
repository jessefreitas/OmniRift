//! Portais — webviews nativos embarcados como nodes do canvas (Fase 5).
//! Usa o multi-webview do Tauri 2 (`unstable`): `Window::add_child`. O frontend
//! sincroniza posição/tamanho (set_bounds) com o rect do node a cada pan/zoom/drag,
//! e esconde (set_visible) quando o floor fica inativo.

use dashmap::DashMap;
use std::sync::Arc;
use tauri::webview::WebviewBuilder;
use tauri::{AppHandle, LogicalPosition, LogicalSize, Manager, State, WebviewUrl};

/// id do node de portal → webview nativo.
pub type PortalMap = Arc<DashMap<String, tauri::Webview>>;

fn parse_url(u: &str) -> Result<tauri::Url, String> {
    tauri::Url::parse(u).map_err(|e| format!("URL inválida '{u}': {e}"))
}

/// Cria o webview nativo do portal posicionado no rect (lógico/CSS px) do node.
/// Idempotente: se já existe, só navega/reposiciona.
#[tauri::command]
pub fn portal_create(
    app: AppHandle,
    portals: State<'_, PortalMap>,
    id: String,
    url: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    if portals.contains_key(&id) {
        return Ok(());
    }
    let window = app.get_window("main").ok_or("janela 'main' não encontrada")?;
    let builder = WebviewBuilder::new(format!("portal_{id}"), WebviewUrl::External(parse_url(&url)?));
    let webview = window
        .add_child(
            builder,
            LogicalPosition::new(x, y),
            LogicalSize::new(width.max(1.0), height.max(1.0)),
        )
        .map_err(|e| format!("falha ao criar portal: {e}"))?;
    portals.insert(id, webview);
    Ok(())
}

/// Reposiciona/redimensiona o webview do portal (rect lógico do node na tela).
#[tauri::command]
pub fn portal_set_bounds(
    portals: State<'_, PortalMap>,
    id: String,
    x: f64,
    y: f64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let Some(wv) = portals.get(&id) else {
        return Ok(());
    };
    wv.set_position(LogicalPosition::new(x, y)).map_err(|e| e.to_string())?;
    wv.set_size(LogicalSize::new(width.max(1.0), height.max(1.0)))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Navega o portal para uma nova URL.
#[tauri::command]
pub fn portal_navigate(portals: State<'_, PortalMap>, id: String, url: String) -> Result<(), String> {
    let Some(wv) = portals.get(&id) else {
        return Err("portal não existe".into());
    };
    wv.navigate(parse_url(&url)?).map_err(|e| e.to_string())
}

/// Mostra/esconde o webview (esconder quando o floor está inativo / node fora da tela).
#[tauri::command]
pub fn portal_set_visible(portals: State<'_, PortalMap>, id: String, visible: bool) -> Result<(), String> {
    let Some(wv) = portals.get(&id) else {
        return Ok(());
    };
    if visible { wv.show() } else { wv.hide() }.map_err(|e| e.to_string())
}

/// Fecha e remove o webview do portal.
#[tauri::command]
pub fn portal_close(portals: State<'_, PortalMap>, id: String) -> Result<(), String> {
    if let Some((_, wv)) = portals.remove(&id) {
        let _ = wv.close();
    }
    Ok(())
}
