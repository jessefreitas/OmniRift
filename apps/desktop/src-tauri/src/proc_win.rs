//! Ponte entre o app e o crate `win-spawn`.
//!
//! A lógica de resolução (PATHEXT, shim `.cmd`, quoting do cmd.exe) mora no crate
//! separado porque o binário de teste do crate PRINCIPAL não roda no Windows: ele linka
//! o Tauri, que embute o manifesto só no binário do app (tauri-apps/tauri#13419). Aqui
//! fica apenas o que depende do app — o PATH efetivo que o filho vai herdar.

#[cfg(windows)]
pub(crate) use win_spawn::ResolvedProgram;

/// Diretórios de busca do agente: tools/bin do OmniRift → PATH do shell de login →
/// PATH do processo, na ordem em que o filho os herda. Resolver contra o PATH do app
/// devolveria "não encontrado" para um binário que existe.
fn dirs_de_busca() -> Vec<String> {
    crate::pty::session::effective_path_parts()
        .iter()
        .flat_map(|p| p.split(crate::pty::session::PATH_SEP))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .collect()
}

#[cfg(windows)]
pub(crate) fn resolve_windows_program(command: &str) -> Option<ResolvedProgram> {
    win_spawn::resolve_in_dirs(command, &dirs_de_busca())
}

pub fn wrap_for_windows(program: &str, args: &[String]) -> (String, Vec<String>) {
    win_spawn::wrap_for_windows(program, args, &dirs_de_busca())
}
