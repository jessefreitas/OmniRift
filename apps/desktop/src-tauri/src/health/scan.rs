//! `project_scan` — caminha o projeto (respeitando `.gitignore`), roda
//! `code::metrics` por arquivo, faz STREAMING via `health://file` e devolve um
//! `ScanSummary` (também emitido em `health://scan-done`).
//!
//! Puro/isolado: NÃO spawna processo nem toca rede — só FS + cálculo. Cache por
//! `(mtime, size)` em `HealthCache` (state) → re-scan recalcula só o que mudou.
//!
//! O crate `ignore` (motor do ripgrep) respeita `.gitignore`/`.ignore`/`.git/`
//! e os globais — então `node_modules/target/dist/.git` caem fora automaticamente
//! (reforçamos com um filtro explícito desses nomes, caso não haja `.gitignore`).

use std::path::Path;
use std::time::UNIX_EPOCH;

use ignore::WalkBuilder;
use tauri::{AppHandle, Emitter, State};

use crate::code::metrics::{self, MetricLang};
use crate::code::CodeMetrics;

use super::{CacheEntry, FileHealth, HealthCache, ScanSummary, WorstFn};

/// Quantos hotspots o resumo carrega (top-N por ciclomática).
const HOTSPOT_CAP: usize = 15;

/// Diretórios sempre ignorados, mesmo sem `.gitignore` no repo.
const ALWAYS_SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".git"];

/// Assinatura de cache de um arquivo: `(mtime_secs, size_bytes)`. mtime ausente → 0.
pub fn cache_signature(meta: &std::fs::Metadata) -> (u64, u64) {
    let mtime = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);
    (mtime, meta.len())
}

/// Converte um `CodeMetrics` (motor 9c) em `FileHealth` (contrato do painel).
/// Pior função = maior ciclomática; nível pela ciclomática máxima do arquivo.
pub fn file_health_from_metrics(m: &CodeMetrics) -> FileHealth {
    let worst = m.functions.iter().max_by_key(|f| f.cyclomatic);
    let cyclomatic = m.max_cyclomatic;
    let cognitive = m.max_cognitive;
    FileHealth {
        path: m.path.clone(),
        lang: m.language.clone(),
        cyclomatic,
        cognitive,
        mi: m.maintainability_index as f32,
        worst_fn: worst.map(|w| WorstFn {
            name: w.name.clone(),
            line: w.start_line,
            cx: w.cyclomatic,
        }),
        level: metrics::level_for(cyclomatic).to_string(),
    }
}

/// Calcula a saúde de um arquivo já lido. `None` = linguagem sem grammar / falha
/// de parse (conta como `skipped` no chamador). Conteúdo NUNCA é logado.
pub fn file_health(path: &Path, source: &str) -> Option<FileHealth> {
    metrics::compute(path, source)
        .ok()
        .map(|m| file_health_from_metrics(&m))
}

/// Monta o `ScanSummary` a partir da lista de saúdes (já calculadas) + os
/// contadores de scaneados/pulados. Hotspots = top-N por ciclomática (desc).
pub fn build_summary(mut files: Vec<FileHealth>, scanned: usize, skipped: usize) -> ScanSummary {
    let total_files = files.len();
    let avg_cx = if total_files == 0 {
        0.0
    } else {
        files.iter().map(|f| f.cyclomatic as f32).sum::<f32>() / total_files as f32
    };
    // Ordena por ciclomática desc; desempate por nome pra ser determinístico.
    files.sort_by(|a, b| b.cyclomatic.cmp(&a.cyclomatic).then_with(|| a.path.cmp(&b.path)));
    files.truncate(HOTSPOT_CAP);
    ScanSummary {
        total_files,
        avg_cx,
        hotspots: files,
        scanned,
        skipped,
    }
}

/// `true` se a extensão do arquivo tem grammar de métricas (rust/ts/tsx/js/jsx/py).
fn is_supported(path: &Path) -> bool {
    MetricLang::from_path(path).is_some()
}

/// Resolve a saúde de um arquivo usando o cache: hit (mesmo mtime+size) reusa;
/// senão lê + calcula + grava no cache. `Ok(None)` = pulado (sem grammar/ilegível).
fn resolve_file(path: &Path, cache: &HealthCache) -> Option<FileHealth> {
    let key = path.to_string_lossy().to_string();
    let meta = std::fs::metadata(path).ok()?;
    let (mtime, size) = cache_signature(&meta);

    // Cache hit: assinatura idêntica → reusa sem reler o arquivo.
    if let Some(entry) = cache.0.lock().get(&key) {
        if entry.mtime == mtime && entry.size == size {
            return Some(entry.health.clone());
        }
    }

    // Miss / mudou: lê + calcula. Falha de leitura/parse → pulado.
    let source = std::fs::read_to_string(path).ok()?;
    let health = file_health(path, &source)?;
    cache.0.lock().insert(
        key,
        CacheEntry {
            mtime,
            size,
            health: health.clone(),
        },
    );
    Some(health)
}

/// Caminha `root` com o crate `ignore` (respeita `.gitignore`, pula
/// node_modules/target/dist/.git), roda `code_metrics` por arquivo suportado,
/// emite `health://file` por arquivo (streaming) e `health://scan-done` no fim.
/// Cache por `(mtime, size)` → re-scan recalcula só o que mudou.
#[tauri::command]
pub async fn project_scan(
    app: AppHandle,
    root: String,
    cache: State<'_, HealthCache>,
) -> Result<ScanSummary, String> {
    let root_path = Path::new(&root);
    if !root_path.is_dir() {
        return Err(format!("raiz não é um diretório: {root}"));
    }

    let mut healths: Vec<FileHealth> = Vec::new();
    let mut skipped = 0usize;

    let walker = WalkBuilder::new(root_path)
        .hidden(false) // não esconde dotfiles (mas .git é barrado abaixo / pelo git_ignore)
        .git_ignore(true)
        .git_global(true)
        .git_exclude(true)
        // Honra `.gitignore` mesmo que `root` não seja (ainda) um repo git — em
        // produção é worktree/repo, mas não dependemos de `.git` existir.
        .require_git(false)
        .parents(true)
        .filter_entry(|entry| {
            // Reforço: barra os diretórios canônicos mesmo sem `.gitignore`.
            if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                if let Some(name) = entry.file_name().to_str() {
                    return !ALWAYS_SKIP_DIRS.contains(&name);
                }
            }
            true
        })
        .build();

    for result in walker {
        let entry = match result {
            Ok(e) => e,
            Err(_) => continue, // erro de IO num path → ignora, não derruba o scan
        };
        // Só arquivos regulares com grammar de métricas.
        if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
            continue;
        }
        let path = entry.path();
        if !is_supported(path) {
            continue;
        }

        match resolve_file(path, &cache) {
            Some(health) => {
                let _ = app.emit("health://file", &health);
                healths.push(health);
            }
            None => skipped += 1, // ilegível / parse falhou
        }
    }

    let scanned = healths.len();
    let summary = build_summary(healths, scanned, skipped);
    let _ = app.emit("health://scan-done", &summary);
    Ok(summary)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    /// Cria um `FileHealth` mínimo pros testes de summary.
    fn fh(path: &str, cx: u32) -> FileHealth {
        FileHealth {
            path: path.into(),
            lang: "rust".into(),
            cyclomatic: cx,
            cognitive: 0,
            mi: 100.0,
            worst_fn: None,
            level: metrics::level_for(cx).to_string(),
        }
    }

    #[test]
    fn build_summary_orders_and_caps_hotspots() {
        let files: Vec<FileHealth> = (1..=20).map(|i| fh(&format!("f{i}.rs"), i)).collect();
        let s = build_summary(files, 20, 3);
        assert_eq!(s.total_files, 20);
        assert_eq!(s.scanned, 20);
        assert_eq!(s.skipped, 3);
        assert_eq!(s.hotspots.len(), HOTSPOT_CAP, "cap em 15 hotspots");
        // Top hotspot = maior ciclomática (20).
        assert_eq!(s.hotspots[0].cyclomatic, 20);
        assert_eq!(s.hotspots[1].cyclomatic, 19);
        // Média de 1..=20 = 10.5.
        assert!((s.avg_cx - 10.5).abs() < 0.001, "avg_cx = {}", s.avg_cx);
    }

    #[test]
    fn build_summary_empty_is_zero() {
        let s = build_summary(vec![], 0, 0);
        assert_eq!(s.total_files, 0);
        assert_eq!(s.avg_cx, 0.0);
        assert!(s.hotspots.is_empty());
    }

    #[test]
    fn file_health_picks_worst_function() {
        // 2 funções: uma reta (cc 1), uma com if+for (cc 3).
        let src = "fn a() -> i32 { 1 }\nfn b(x: bool) {\n    if x {\n        for _ in 0..2 {}\n    }\n}\n";
        let h = file_health(&PathBuf::from("x.rs"), src).unwrap();
        assert_eq!(h.lang, "rust");
        assert_eq!(h.cyclomatic, 3, "pior função = if + for + base");
        let w = h.worst_fn.unwrap();
        assert_eq!(w.name, "b");
        assert_eq!(w.cx, 3);
    }

    #[test]
    fn file_health_unsupported_is_none() {
        assert!(file_health(&PathBuf::from("x.cobol"), "fake").is_none());
    }

    /// O scan deve respeitar `.gitignore` e filtrar por linguagem suportada.
    /// Testa a varredura sem o `AppHandle` (replica o loop do command).
    fn scan_dir(root: &Path, cache: &HealthCache) -> (Vec<FileHealth>, usize) {
        let mut healths = Vec::new();
        let mut skipped = 0usize;
        let walker = WalkBuilder::new(root)
            .hidden(false)
            .git_ignore(true)
            .require_git(false)
            .parents(true)
            .filter_entry(|entry| {
                if entry.file_type().map(|t| t.is_dir()).unwrap_or(false) {
                    if let Some(name) = entry.file_name().to_str() {
                        return !ALWAYS_SKIP_DIRS.contains(&name);
                    }
                }
                true
            })
            .build();
        for result in walker {
            let entry = match result {
                Ok(e) => e,
                Err(_) => continue,
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            if !is_supported(path) {
                continue;
            }
            match resolve_file(path, cache) {
                Some(h) => healths.push(h),
                None => skipped += 1,
            }
        }
        (healths, skipped)
    }

    #[test]
    fn scan_respects_gitignore_and_filters_langs() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        // .gitignore esconde "ignored.rs" e o dir "build/".
        fs::write(root.join(".gitignore"), "ignored.rs\nbuild/\n").unwrap();
        fs::write(root.join("keep.rs"), "fn k() -> i32 { 1 }").unwrap();
        fs::write(root.join("ignored.rs"), "fn i() -> i32 { 1 }").unwrap();
        fs::write(root.join("notes.md"), "# não é código").unwrap(); // sem grammar
        // node_modules sempre pulado (mesmo sem .gitignore listar).
        fs::create_dir_all(root.join("node_modules")).unwrap();
        fs::write(root.join("node_modules").join("dep.js"), "function d(){}").unwrap();
        // build/ ignorado pelo .gitignore.
        fs::create_dir_all(root.join("build")).unwrap();
        fs::write(root.join("build").join("out.rs"), "fn o() -> i32 { 1 }").unwrap();
        // subdir com TS suportado.
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src").join("app.ts"), "function a(){ return 1; }").unwrap();

        let cache = HealthCache::new();
        let (healths, _skipped) = scan_dir(root, &cache);
        let names: Vec<String> = healths
            .iter()
            .map(|h| {
                Path::new(&h.path)
                    .file_name()
                    .unwrap()
                    .to_string_lossy()
                    .to_string()
            })
            .collect();

        assert!(names.contains(&"keep.rs".to_string()), "keep.rs deve entrar");
        assert!(names.contains(&"app.ts".to_string()), "app.ts (subdir) deve entrar");
        assert!(!names.contains(&"ignored.rs".to_string()), ".gitignore deve esconder");
        assert!(!names.contains(&"out.rs".to_string()), "build/ ignorado");
        assert!(!names.contains(&"dep.js".to_string()), "node_modules sempre pulado");
        assert!(!names.contains(&"notes.md".to_string()), ".md não tem grammar");
    }

    #[test]
    fn cache_invalidates_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("c.rs");
        fs::write(&f, "fn a() -> i32 { 1 }").unwrap(); // cc 1, tamanho X
        let cache = HealthCache::new();

        let h1 = resolve_file(&f, &cache).unwrap();
        assert_eq!(h1.cyclomatic, 1);
        let key = f.to_string_lossy().to_string();
        let sig1 = {
            let g = cache.0.lock();
            let e = g.get(&key).unwrap();
            (e.mtime, e.size)
        };

        // Dorme pra cruzar o segundo (invalida via mtime mesmo em FS de baixa
        // resolução) E reescreve com conteúdo de TAMANHO diferente (invalida via
        // size também) — a assinatura muda por qualquer um dos dois eixos.
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(&f, "fn a(x: bool) {\n    if x {\n        for _ in 0..2 {}\n    }\n}").unwrap();

        let h2 = resolve_file(&f, &cache).unwrap();
        assert_eq!(h2.cyclomatic, 3, "cache deve invalidar e recalcular");
        let sig2 = {
            let g = cache.0.lock();
            let e = g.get(&key).unwrap();
            (e.mtime, e.size)
        };
        assert_ne!(sig1, sig2, "assinatura (mtime,size) deve ter mudado");
    }

    #[test]
    fn cache_hit_reuses_when_unchanged() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("h.rs");
        fs::write(&f, "fn a() -> i32 { 1 }").unwrap();
        let cache = HealthCache::new();

        let _ = resolve_file(&f, &cache).unwrap();
        // Envenena o cache: muda a saúde guardada sem mexer no arquivo. Um hit
        // (mesma assinatura) deve devolver o valor envenenado, provando que NÃO releu.
        let key = f.to_string_lossy().to_string();
        {
            let mut g = cache.0.lock();
            let e = g.get_mut(&key).unwrap();
            e.health.cyclomatic = 999;
        }
        let h = resolve_file(&f, &cache).unwrap();
        assert_eq!(h.cyclomatic, 999, "hit de cache deve reusar sem reler");
    }
}
