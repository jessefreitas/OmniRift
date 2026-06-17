//! Abrir arquivos/projetos no editor do usuário — igualar o Maestri (1 clique pro
//! editor) e SUPERAR: detecta muito mais editores que os 3 deles, abre no
//! `arquivo:linha` exato quando o editor suporta, e marca editores de terminal
//! pra abrirem DENTRO de um terminal do canvas (o frontend trata).

use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EditorInfo {
    pub id: String,
    pub label: String,
    pub cmd: String,
    /// true = editor de terminal (nvim/vim/…): o frontend abre num terminal do canvas.
    pub terminal: bool,
}

// id, label, comando, é_terminal
const KNOWN: &[(&str, &str, &str, bool)] = &[
    ("vscode", "VS Code", "code", false),
    ("vscode-insiders", "VS Code Insiders", "code-insiders", false),
    ("cursor", "Cursor", "cursor", false),
    ("windsurf", "Windsurf", "windsurf", false),
    ("zed", "Zed", "zed", false),
    ("sublime", "Sublime Text", "subl", false),
    ("intellij", "IntelliJ IDEA", "idea", false),
    ("pycharm", "PyCharm", "pycharm", false),
    ("webstorm", "WebStorm", "webstorm", false),
    ("gnome-text-editor", "GNOME Text Editor", "gnome-text-editor", false),
    ("gedit", "gedit", "gedit", false),
    ("kate", "Kate", "kate", false),
    ("nvim", "Neovim", "nvim", true),
    ("vim", "Vim", "vim", true),
    ("emacs", "Emacs (terminal)", "emacs", true),
    ("helix", "Helix", "hx", true),
    ("micro", "micro", "micro", true),
];

/// O comando está no PATH? Cross-platform: `where` no Windows, `which` no resto.
fn cmd_in_path(cmd: &str) -> bool {
    let finder = if cfg!(windows) { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Fora do PATH: tenta achar o editor por outros meios da plataforma.
/// Linux: varre os `.desktop` (pega editor instalado via .deb/AppImage/snap que
/// não pôs binário no PATH). Devolve o comando/caminho de launch.
#[cfg(target_os = "linux")]
fn resolve_offpath(cmd: &str) -> Option<String> {
    let home = std::env::var("HOME").unwrap_or_default();
    let dirs = [
        "/usr/share/applications".to_string(),
        "/var/lib/flatpak/exports/share/applications".to_string(),
        "/var/lib/snapd/desktop/applications".to_string(),
        format!("{home}/.local/share/applications"),
        format!("{home}/.local/share/flatpak/exports/share/applications"),
    ];
    for dir in dirs {
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("desktop") {
                continue;
            }
            let Ok(content) = std::fs::read_to_string(&path) else { continue };
            for line in content.lines() {
                let Some(rest) = line.strip_prefix("Exec=") else { continue };
                // 1º token (o binário), ignorando field codes (%F/%U/…).
                let bin = rest.split_whitespace().next().unwrap_or("");
                let base = bin.rsplit('/').next().unwrap_or(bin);
                if base == cmd && !bin.is_empty() {
                    return Some(bin.to_string());
                }
            }
        }
    }
    None
}

#[cfg(not(target_os = "linux"))]
fn resolve_offpath(_cmd: &str) -> Option<String> {
    None
}

/// Lista os editores instalados no host. Acha pelo PATH (which/where) e, fora do
/// PATH no Linux, pelos `.desktop` (.deb/AppImage/snap). Cross-platform.
#[tauri::command]
pub fn detect_editors() -> Vec<EditorInfo> {
    KNOWN
        .iter()
        .filter_map(|(id, label, cmd, term)| {
            let resolved = if cmd_in_path(cmd) {
                Some(cmd.to_string())
            } else {
                resolve_offpath(cmd)
            };
            resolved.map(|c| EditorInfo {
                id: id.to_string(),
                label: label.to_string(),
                cmd: c,
                terminal: *term,
            })
        })
        .collect()
}

/// Abre `path` (arquivo ou pasta) no editor GUI `cmd`. Quando o editor suporta e
/// `line` vem, abre direto na linha (família VS Code: `-g path:line`; zed/subl: `path:line`).
/// Editores de terminal NÃO passam por aqui (o frontend os abre num terminal do canvas).
#[tauri::command]
pub fn open_in_editor(cmd: String, path: String, line: Option<u32>) -> Result<(), String> {
    let cmd = cmd.trim().to_string();
    if cmd.is_empty() {
        return Err("editor vazio".into());
    }
    let mut c = std::process::Command::new(&cmd);
    // Casa pelo BASENAME — o cmd pode ser um caminho absoluto (achado via .desktop).
    let base = std::path::Path::new(&cmd)
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or(cmd.as_str());
    match (base, line) {
        ("code" | "code-insiders" | "cursor" | "windsurf", Some(l)) => {
            c.arg("-g").arg(format!("{path}:{l}"));
        }
        ("zed" | "subl", Some(l)) => {
            c.arg(format!("{path}:{l}"));
        }
        _ => {
            c.arg(&path);
        }
    }
    c.spawn().map_err(|e| format!("falha ao abrir '{cmd}': {e}"))?;
    Ok(())
}
