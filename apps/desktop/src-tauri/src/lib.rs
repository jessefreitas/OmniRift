pub mod commands;
pub mod pty;

use commands::pty::{pty_kill, pty_list, pty_pipe_create, pty_pipe_list, pty_pipe_remove, pty_resize, pty_spawn, pty_write};
use pty::PtyManager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info"),
    )
    .try_init();

    tauri::Builder::default()
        .manage(PtyManager::new())
        .plugin(tauri_plugin_shell::init())
        .invoke_handler(tauri::generate_handler![
            pty_spawn,
            pty_write,
            pty_resize,
            pty_kill,
            pty_list,
            pty_pipe_create,
            pty_pipe_remove,
            pty_pipe_list,
        ])
        .run(tauri::generate_context!())
        .expect("erro fatal rodando Maestri Linux");
}
