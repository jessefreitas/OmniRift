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

fn which(cmd: &str) -> bool {
    std::process::Command::new("which")
        .arg(cmd)
        .output()
        .map(|o| o.status.success())
        .unwrap_or(false)
}

/// Lista os editores instalados no host (supera o Maestri, que fixa 3).
#[tauri::command]
pub fn detect_editors() -> Vec<EditorInfo> {
    KNOWN
        .iter()
        .filter(|(_, _, cmd, _)| which(cmd))
        .map(|(id, label, cmd, term)| EditorInfo {
            id: id.to_string(),
            label: label.to_string(),
            cmd: cmd.to_string(),
            terminal: *term,
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
    match (cmd.as_str(), line) {
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
