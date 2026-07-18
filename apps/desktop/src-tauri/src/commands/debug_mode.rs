use std::fs;
use std::path::PathBuf;

// home_dir(): USERPROFILE no windows, HOME no resto (mesmo padrão do debug_log.rs).
#[cfg(windows)]
fn home_dir() -> Option<String> {
    std::env::var("USERPROFILE").ok()
}

#[cfg(not(windows))]
fn home_dir() -> Option<String> {
    std::env::var("HOME").ok()
}

// Marcador em ~/.omnirift/debug-mode. Arquivo existe = ligado.
// Marcador (e não config JSON) porque precisa ser lido no boot com custo zero e
// sem parser — se o arquivo de config estiver corrompido o app ainda sobe.
fn marker_path() -> Option<PathBuf> {
    home_dir().map(|home| PathBuf::from(home).join(".omnirift").join("debug-mode"))
}

/// Modo debug está ligado? Lido no BOOT (lib.rs) pra escolher o LevelFilter, e
/// pela UI. Nunca falha: erro de IO = desligado.
pub fn is_enabled() -> bool {
    marker_path().map(|p| p.exists()).unwrap_or(false)
}

/// Nível de log efetivo: Debug quando o modo está ligado, Info caso contrário.
/// Info é o default porque Debug em uso normal enche o disco do usuário.
pub fn level_filter() -> log::LevelFilter {
    if is_enabled() {
        log::LevelFilter::Debug
    } else {
        log::LevelFilter::Info
    }
}

#[tauri::command]
pub fn debug_mode_get() -> bool {
    is_enabled()
}

/// Liga/desliga. Aplica o nível JÁ (log::set_max_level) e persiste o marcador, então
/// vale na sessão atual e nas próximas — o tester não precisa reiniciar o app.
/// Devolve o estado efetivo (se a escrita falhar, devolve o que realmente ficou).
#[tauri::command]
pub fn debug_mode_set(enabled: bool) -> bool {
    if let Some(path) = marker_path() {
        if enabled {
            if let Some(dir) = path.parent() {
                let _dir = fs::create_dir_all(dir);
            }
            let _ = fs::write(&path, "1");
        } else {
            let _ = fs::remove_file(&path);
        }
    }

    // Se a persistência falhou, is_enabled() volta o estado REAL e o toggle
    // da UI desmarca sozinho — mas sem este aviso a causa ficaria invisível.
    if is_enabled() != enabled {
        log::warn!("modo debug: não consegui {} o marcador em ~/.omnirift/debug-mode (permissão/disco?)",
                   if enabled { "criar" } else { "remover" });
    }
    log::set_max_level(level_filter());
    is_enabled()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn level_filter_sempre_debug_ou_info_e_check_nao_panica() {
        let enabled = is_enabled();
        let filter = level_filter();

        assert!(
            filter == log::LevelFilter::Debug || filter == log::LevelFilter::Info,
            "level_filter deve ser Debug ou Info, obtive {:?} (enabled={})",
            filter,
            enabled
        );
    }
}