//! Auto-geração do `.serena/project.yml` por detecção de extensões — pra que o
//! Serena suba o LSP certo POR LINGUAGEM (poliglota) automaticamente em qualquer
//! projeto aberto no OmniRift. Só CRIA se não existir — nunca sobrescreve o que
//! o usuário (ou o próprio Serena) já configurou.

use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// Extensão (lowercase, sem ponto) → nome de linguagem no enum do Serena.
fn ext_to_lang(ext: &str) -> Option<&'static str> {
    Some(match ext {
        "ts" | "tsx" | "js" | "jsx" | "mjs" | "cjs" => "typescript",
        "rs" => "rust",
        "py" | "pyi" => "python",
        "php" => "php",
        "go" => "go",
        "java" => "java",
        "cs" => "csharp",
        "rb" => "ruby",
        "c" | "h" | "cpp" | "cc" | "cxx" | "hpp" | "hh" => "cpp",
        "kt" | "kts" => "kotlin",
        "swift" => "swift",
        "scala" | "sc" => "scala",
        "lua" => "lua",
        "ex" | "exs" => "elixir",
        "dart" => "dart",
        "vue" => "vue",
        "svelte" => "svelte",
        "zig" => "zig",
        "hs" => "haskell",
        "clj" | "cljs" | "cljc" => "clojure",
        "erl" | "hrl" => "erlang",
        "ml" | "mli" => "ocaml",
        "pl" | "pm" => "perl",
        "r" => "r",
        "sh" | "bash" => "bash",
        "nix" => "nix",
        "sol" => "solidity",
        "tf" => "terraform",
        "ps1" => "powershell",
        "swiftpm" => "swift",
        _ => return None,
    })
}

/// Pastas que não contam pra detecção (deps/builds/VCS).
const SKIP_DIRS: &[&str] = &[
    ".git", "node_modules", "target", "dist", "build", "out", "vendor", ".serena",
    ".next", ".nuxt", "__pycache__", ".venv", "venv", ".cargo", ".idea", ".vscode",
    "coverage", ".turbo", ".cache",
];

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SerenaEnsure {
    /// "created" (escreveu o yml) | "exists" (já havia) | "none" (sem linguagem reconhecida).
    pub status: String,
    pub languages: Vec<String>,
    pub path: Option<String>,
}

/// Varre `cwd` (limitado) e, se não houver `.serena/project.yml`, gera um com as
/// linguagens detectadas (ordenadas por frequência → a 1ª vira a default/fallback).
#[tauri::command]
pub fn serena_ensure_project(cwd: String) -> Result<SerenaEnsure, String> {
    let root = Path::new(&cwd);
    if cwd.trim().is_empty() || !root.is_dir() {
        return Err(format!("cwd inválido: {cwd}"));
    }
    let yml = root.join(".serena").join("project.yml");
    if yml.exists() {
        return Ok(SerenaEnsure { status: "exists".into(), languages: vec![], path: Some(yml.to_string_lossy().into_owned()) });
    }

    // walk iterativo limitado (disco lento → teto de arquivos/profundidade)
    let mut counts: HashMap<&'static str, u32> = HashMap::new();
    let mut stack: Vec<(std::path::PathBuf, u32)> = vec![(root.to_path_buf(), 0)];
    let mut scanned: u32 = 0;
    while let Some((dir, depth)) = stack.pop() {
        if depth > 6 || scanned > 20_000 {
            break;
        }
        let Ok(entries) = std::fs::read_dir(&dir) else { continue };
        for e in entries.flatten() {
            let p = e.path();
            let name = e.file_name().to_string_lossy().into_owned();
            if p.is_dir() {
                // pula VCS/deps/builds e qualquer pasta oculta
                if !name.starts_with('.') && !SKIP_DIRS.contains(&name.as_str()) {
                    stack.push((p, depth + 1));
                }
            } else {
                scanned += 1;
                if let Some(ext) = p.extension().and_then(|x| x.to_str()) {
                    if let Some(lang) = ext_to_lang(&ext.to_lowercase()) {
                        *counts.entry(lang).or_insert(0) += 1;
                    }
                }
            }
        }
    }

    if counts.is_empty() {
        return Ok(SerenaEnsure { status: "none".into(), languages: vec![], path: None });
    }
    // ordena por contagem desc, depois alfabético pra estabilidade; cap em 6
    let mut langs: Vec<(&'static str, u32)> = counts.into_iter().collect();
    langs.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(b.0)));
    let chosen: Vec<String> = langs.iter().take(6).map(|(l, _)| (*l).to_string()).collect();

    let name = root.file_name().map(|n| n.to_string_lossy().into_owned()).unwrap_or_else(|| "project".into());
    let mut body = String::from(
        "# Gerado automaticamente pelo OmniRift (detecção por extensão).\n\
         # Edite à vontade — o OmniRift NUNCA sobrescreve um project.yml existente.\n",
    );
    body.push_str(&format!("project_name: \"{}\"\n", name.replace('"', "")));
    body.push_str("languages:\n");
    for l in &chosen {
        body.push_str(&format!("- {l}\n"));
    }
    body.push_str("read_only: false\nignored_paths: []\n");

    let serena_dir = root.join(".serena");
    std::fs::create_dir_all(&serena_dir).map_err(|e| format!("criar .serena: {e}"))?;
    std::fs::write(&yml, body).map_err(|e| format!("gravar project.yml: {e}"))?;
    Ok(SerenaEnsure { status: "created".into(), languages: chosen, path: Some(yml.to_string_lossy().into_owned()) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detecta_php_e_ts_e_ignora_node_modules() {
        let dir = std::env::temp_dir().join(format!("serena-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("src")).unwrap();
        std::fs::create_dir_all(dir.join("node_modules/pkg")).unwrap();
        // projeto PHP-dominante + um pouco de TS; lixo em node_modules deve ser ignorado
        for f in ["index.php", "app.php", "model.php"] {
            std::fs::write(dir.join(f), "<?php").unwrap();
        }
        std::fs::write(dir.join("src/main.ts"), "export {}").unwrap();
        for f in ["a.ts", "b.ts", "c.ts", "d.ts"] {
            std::fs::write(dir.join("node_modules/pkg").join(f), "x").unwrap();
        }

        let r = serena_ensure_project(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(r.status, "created");
        assert!(r.languages.contains(&"php".to_string()), "deve detectar php: {:?}", r.languages);
        assert!(r.languages.contains(&"typescript".to_string()), "deve detectar ts: {:?}", r.languages);
        // php é dominante (3 arquivos) → primeira linguagem (default/fallback)
        assert_eq!(r.languages[0], "php", "php deve ser a default: {:?}", r.languages);

        // 2ª chamada não sobrescreve
        let r2 = serena_ensure_project(dir.to_string_lossy().into_owned()).unwrap();
        assert_eq!(r2.status, "exists");

        let _ = std::fs::remove_dir_all(&dir);
    }
}
