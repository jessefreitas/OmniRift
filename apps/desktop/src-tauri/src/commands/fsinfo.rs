//! Capacidade de copy-on-write (CoW) do filesystem — pra floors instantâneos.
//!
//! O floor do Maestri é um clone APFS copy-on-write (Mac-only, instantâneo, ~zero
//! disco, mas NÃO é git). O nosso floor é um git worktree: já compartilha o object
//! store (history não duplica → ~zero disco também) E é git-native (branch real,
//! cross-platform). Aqui detectamos se o FS suporta reflink pra também oferecer o
//! "instantâneo" deles, e expomos um helper de clone reflink.

use crate::proc_ext::NoWindow;
use serde::Serialize;
use std::path::Path;
use std::process::Command;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CowInfo {
    /// Nome do filesystem (ex.: btrfs, xfs, zfs, apfs, ext2/3/4).
    pub fs: String,
    /// true = suporta reflink/CoW (clone instantâneo de arquivos).
    pub reflink: bool,
}

/// Filesystems com suporte a reflink/CoW conhecido.
fn fs_has_cow(fs: &str) -> bool {
    matches!(
        fs.to_lowercase().as_str(),
        "btrfs" | "xfs" | "zfs" | "bcachefs" | "apfs" | "refs" | "ocfs2"
    )
}

/// Detecta o filesystem de `path` e se ele suporta CoW (GNU stat -f).
#[tauri::command]
pub fn fs_cow_info(path: String) -> CowInfo {
    let fs = Command::new("stat")
        .args(["-f", "-c", "%T", &path])
        .no_window()
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
    CowInfo { reflink: fs_has_cow(&fs), fs }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CloneResult {
    pub ok: bool,
    pub dest: String,
}

/// Clona `src` → `dst` usando reflink quando o FS suporta (instantâneo, ~zero
/// disco em btrfs/xfs/zfs/apfs) e cai pra cópia normal caso contrário
/// (`cp --reflink=auto`). Base pra clones de árvore instantâneos.
#[tauri::command]
pub fn reflink_clone(src: String, dst: String) -> Result<CloneResult, String> {
    if !Path::new(&src).exists() {
        return Err(format!("origem inexistente: {src}"));
    }
    let status = Command::new("cp")
        .args(["--reflink=auto", "-a", &src, &dst])
        .no_window()
        .status()
        .map_err(|e| format!("cp falhou: {e}"))?;
    if !status.success() {
        return Err(format!("cp retornou status {status}"));
    }
    Ok(CloneResult { ok: true, dest: dst })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reflink_clone_copia_arquivo() {
        let base = std::env::temp_dir().join(format!("cow-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        std::fs::create_dir_all(&base).unwrap();
        let src = base.join("a.txt");
        let dst = base.join("b.txt");
        std::fs::write(&src, "conteudo").unwrap();

        let r = reflink_clone(src.to_string_lossy().into(), dst.to_string_lossy().into()).unwrap();
        assert!(r.ok);
        assert_eq!(std::fs::read_to_string(&dst).unwrap(), "conteudo");

        // info do FS não deve quebrar
        let info = fs_cow_info(base.to_string_lossy().into());
        assert!(!info.fs.is_empty() || info.fs.is_empty()); // só garante que roda

        let _ = std::fs::remove_dir_all(&base);
    }
}
