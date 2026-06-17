//! IO de arquivos do CodeNode (Fase 9, Task 7): leitura UTF-8, escrita ATÔMICA
//! (tmp no mesmo FS + rename) e watch debounced (notify-debouncer-mini).

use std::io::Write as _;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;

use anyhow::{anyhow, Result};
use notify::{RecommendedWatcher, RecursiveMode};
use notify_debouncer_mini::{new_debouncer, DebounceEventResult, Debouncer};

/// Lê o arquivo como UTF-8.
pub fn read(path: &Path) -> Result<String> {
    Ok(std::fs::read_to_string(path)?)
}

/// Escreve de forma ATÔMICA: grava num arquivo temporário no MESMO diretório
/// (mesmo filesystem → rename atômico), faz fsync e renomeia por cima. O destino
/// nunca fica pela metade.
pub fn write(path: &Path, content: &str) -> Result<()> {
    static SEQ: AtomicU64 = AtomicU64::new(0);
    let dir = match path.parent() {
        Some(p) if !p.as_os_str().is_empty() => p,
        _ => Path::new("."),
    };
    let fname = path
        .file_name()
        .ok_or_else(|| anyhow!("path sem nome de arquivo: {}", path.display()))?
        .to_string_lossy();
    // tmp único no mesmo dir (pid + seq) pra não colidir entre escritas.
    let tmp = dir.join(format!(
        ".{fname}.{}.{}.tmp",
        std::process::id(),
        SEQ.fetch_add(1, Ordering::Relaxed)
    ));

    let res = (|| -> Result<()> {
        let mut f = std::fs::File::create(&tmp)?;
        f.write_all(content.as_bytes())?;
        f.sync_all()?;
        std::fs::rename(&tmp, path)?;
        Ok(())
    })();
    if res.is_err() {
        let _ = std::fs::remove_file(&tmp); // não deixa lixo se algo falhou
    }
    res
}

/// Mantém o watch vivo; dropar PARA o watch (o Debouncer encerra a thread).
pub struct WatchHandle {
    _debouncer: Debouncer<RecommendedWatcher>,
}

/// Observa `path` e chama `on_change` (debounced em `debounce_ms`) a cada mudança.
/// Erros de evento do FS são silenciosamente ignorados (não derrubam o watch).
pub fn watch(
    path: &Path,
    debounce_ms: u64,
    on_change: impl Fn() + Send + 'static,
) -> Result<WatchHandle> {
    let mut debouncer = new_debouncer(
        Duration::from_millis(debounce_ms),
        move |res: DebounceEventResult| {
            if res.is_ok() {
                on_change();
            }
        },
    )?;
    debouncer
        .watcher()
        .watch(path, RecursiveMode::NonRecursive)?;
    Ok(WatchHandle {
        _debouncer: debouncer,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn write_then_read_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.rs");
        write(&f, "fn main() {}").unwrap();
        assert_eq!(read(&f).unwrap(), "fn main() {}");
    }

    #[test]
    fn write_overwrites_atomically() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("y.rs");
        write(&f, "v1").unwrap();
        write(&f, "v2-maior").unwrap();
        assert_eq!(read(&f).unwrap(), "v2-maior");
        // nenhum .tmp deixado pra trás
        let leftovers: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().ends_with(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "sobrou tmp: {leftovers:?}");
    }
}
