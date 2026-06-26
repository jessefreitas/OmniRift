//! Comandos Tauri do CodeNode (Fase 9, Task 10 — editor-first: open/save/watch).
//! Métricas de complexidade (`code_metrics`) — sub-fase 9c (motor tree-sitter).

use std::collections::HashMap;
use std::path::Path;
use std::sync::Arc;

use ignore::WalkBuilder;
use parking_lot::Mutex;
use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::code::{file_io, metrics, monaco_language, CodeMetrics};

/// Conteúdo + linguagem (Monaco) de um arquivo aberto no CodeNode.
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenedFile {
    pub content: String,
    pub language: String,
}

/// Watches de FS ativos por path — mantém o `WatchHandle` vivo (drop = para).
#[derive(Default)]
pub struct CodeWatchers(pub Arc<Mutex<HashMap<String, file_io::WatchHandle>>>);

/// Abre um arquivo: devolve conteúdo + id de linguagem pro Monaco montar.
#[tauri::command]
pub fn code_open(path: String) -> Result<OpenedFile, String> {
    let p = Path::new(&path);
    let content = file_io::read(p).map_err(|e| e.to_string())?;
    Ok(OpenedFile {
        content,
        language: monaco_language(p).to_string(),
    })
}

/// Salva o conteúdo de forma atômica.
#[tauri::command]
pub fn code_save(path: String, content: String) -> Result<(), String> {
    file_io::write(Path::new(&path), &content).map_err(|e| e.to_string())
}

/// Observa o arquivo; emite `code://changed` (com o path) quando muda no disco.
#[tauri::command]
pub fn code_watch(
    path: String,
    app: AppHandle,
    watchers: State<'_, CodeWatchers>,
) -> Result<String, String> {
    let emit_path = path.clone();
    let handle = file_io::watch(Path::new(&path), 300, move || {
        let _ = app.emit("code://changed", emit_path.clone());
    })
    .map_err(|e| e.to_string())?;
    watchers.0.lock().insert(path.clone(), handle); // substitui watch anterior do mesmo path
    Ok(path)
}

/// Para de observar (drop do handle encerra o watch).
#[tauri::command]
pub fn code_unwatch(path: String, watchers: State<'_, CodeWatchers>) -> Result<(), String> {
    watchers.0.lock().remove(&path);
    Ok(())
}

/// Métricas de complexidade do arquivo (sub-fase 9c). Detecta a linguagem pela
/// extensão; linguagem sem grammar → erro-suave (`Err` com mensagem amigável).
/// Lê o arquivo do disco (conteúdo nunca é logado — só os números).
#[tauri::command]
pub fn code_metrics(path: String) -> Result<CodeMetrics, String> {
    let p = Path::new(&path);
    let content = file_io::read(p).map_err(|e| e.to_string())?;
    metrics::compute(p, &content).map_err(|e| e.to_string())
}

/// Diretórios sempre ignorados no scan de projeto, mesmo sem `.gitignore`
/// (espelha `health::scan::ALWAYS_SKIP_DIRS` — o walk-padrão do projeto).
const ALWAYS_SKIP_DIRS: [&str; 4] = ["node_modules", "target", "dist", ".git"];

/// Teto de arquivos PROCESSADOS no scan de projeto (sub-fase 9e). Acima disto, o
/// restante dos arquivos de código é só CONTADO e logado (`log::warn!`) — nunca
/// um corte silencioso.
const PROJECT_FILE_CAP: usize = 2000;

/// Resumo LEVE de métricas de UM arquivo, pro Painel de Complexidade do Projeto
/// (sub-fase 9e). DTO enxuto: NÃO carrega o `functions[]` inteiro — o drill-down
/// por função vem sob demanda via `code_metrics` por-arquivo. Contrato camelCase
/// espelha `FileMetricsSummary` em `apps/desktop/src/types/code.ts`.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileMetricsSummary {
    /// Caminho absoluto do arquivo (o front exibe relativo ao `dir`).
    pub path: String,
    /// Nome canônico da linguagem do engine ("rust" | "typescript" | "python").
    pub language: String,
    /// Linhas físicas do arquivo.
    pub loc: usize,
    /// Maior ciclomática entre as funções do arquivo.
    pub max_cyclomatic: u32,
    /// Maior cognitiva entre as funções do arquivo.
    pub max_cognitive: u32,
    /// Maintainability Index do arquivo (0–100; pior função).
    pub maintainability_index: f64,
    /// "green" | "yellow" | "red" — derivada da ciclomática MÁXIMA do arquivo
    /// pelos MESMOS thresholds do engine (`metrics::severity_for`).
    pub severity: String,
    /// Quantidade de funções detectadas no arquivo.
    pub fn_count: usize,
}

impl FileMetricsSummary {
    /// Projeta o `CodeMetrics` (engine 9c, com `functions[]` completo) no DTO
    /// leve. Severidade do arquivo = severidade da ciclomática máxima (mesma
    /// regra aplicada a cada função no engine).
    fn from_metrics(m: &CodeMetrics) -> Self {
        Self {
            path: m.path.clone(),
            language: m.language.clone(),
            loc: m.loc,
            max_cyclomatic: m.max_cyclomatic,
            max_cognitive: m.max_cognitive,
            maintainability_index: m.maintainability_index,
            severity: metrics::severity_for(m.max_cyclomatic).to_string(),
            fn_count: m.functions.len(),
        }
    }
}

/// Núcleo do scan de projeto (sem `#[tauri::command]`) — testável direto.
/// Caminha `dir` (+ `extra_roots`) reusando o MESMO walk do painel "Saúde do
/// Projeto" (crate `ignore`, motor do ripgrep): respeita `.gitignore`/`.ignore`
/// e os globais (`require_git(false)` honra mesmo fora de repo git) e barra
/// `node_modules/target/dist/.git`. Só processa extensões com grammar de
/// métricas (`metrics::MetricLang::from_path` — a MESMA lista do engine; `None`
/// → pula). Best-effort: arquivo ilegível/não-UTF8 ou com parse-fail é PULADO
/// (não derruba o scan). Teto `PROJECT_FILE_CAP`: acima dele os arquivos extras
/// são contados e logados (sem cap silencioso).
fn scan_project(dir: &Path, extra_roots: &[String]) -> Result<Vec<FileMetricsSummary>, String> {
    if !dir.is_dir() {
        return Err(format!("raiz não é um diretório: {}", dir.display()));
    }

    // `dir` primeiro, depois as raízes extras do usuário (pastas; arquivo/
    // inexistente é ignorado — best-effort, sem path-traversal além do dado).
    let mut roots: Vec<&Path> = vec![dir];
    roots.extend(extra_roots.iter().map(Path::new));

    let mut out: Vec<FileMetricsSummary> = Vec::new();
    let mut cut = 0usize;
    let mut processed = 0usize;
    let mut seen = std::collections::HashSet::new();

    for root in roots {
        if !root.is_dir() {
            continue; // raiz extra inexistente / é arquivo → ignora
        }
        let walker = WalkBuilder::new(root)
            .hidden(false) // não esconde dotfiles (mas .git cai pelo filtro/gitignore)
            .git_ignore(true)
            .git_global(true)
            .git_exclude(true)
            .require_git(false) // honra `.gitignore` mesmo se `root` não for repo git
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
                Err(_) => continue, // erro de IO num path → ignora, não derruba
            };
            if !entry.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue;
            }
            let path = entry.path();
            // Só extensões com grammar — MESMA lista do engine (`metrics.rs`).
            if metrics::MetricLang::from_path(path).is_none() {
                continue;
            }
            // Dedup entre raízes que se sobrepõem (`dir` ⊇ extra_root).
            if !seen.insert(path.to_string_lossy().to_string()) {
                continue;
            }
            // Teto sobre arquivos PROCESSADOS (lidos+parseados), NÃO sobre os que
            // tiveram sucesso (`out.len()`): senão um dir com milhares de arquivos
            // que falham o parse nunca atingiria o teto e leria/parsearia o disco
            // inteiro (DoS). Acima do cap só conta — nada de cap silencioso.
            if processed >= PROJECT_FILE_CAP {
                cut += 1;
                continue;
            }
            processed += 1;
            // Best-effort: lê + roda o engine (MESMO caminho do `code_metrics`).
            // Falha de leitura/parse → pula (não derruba o scan).
            let Ok(content) = file_io::read(path) else { continue };
            if let Ok(m) = metrics::compute(path, &content) {
                out.push(FileMetricsSummary::from_metrics(&m));
            }
        }
    }

    if cut > 0 {
        log::warn!("code_metrics_project: cortou {cut} arquivos (teto {PROJECT_FILE_CAP})");
    }

    Ok(out)
}

/// Métricas de complexidade de TODOS os arquivos de código sob `dir` (+ raízes
/// extras) — sub-fase 9e (Painel de Complexidade do Projeto). DTO LEVE por
/// arquivo (`FileMetricsSummary`); o `functions[]` vem sob demanda via
/// `code_metrics`. A ordenação (pior-primeiro) fica a cargo do front. Reusa o
/// engine de métricas existente (zero duplicação da lógica). Ver `scan_project`.
#[tauri::command]
pub async fn code_metrics_project(
    dir: String,
    extra_roots: Option<Vec<String>>,
) -> Result<Vec<FileMetricsSummary>, String> {
    // Scan de até PROJECT_FILE_CAP arquivos com tree-sitter é CPU-bound; roda em
    // thread de blocking pra NÃO congelar a thread de IPC/UI do Tauri.
    tauri::async_runtime::spawn_blocking(move || {
        scan_project(Path::new(&dir), &extra_roots.unwrap_or_default())
    })
    .await
    .map_err(|e| format!("scan falhou: {e}"))?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn code_open_reads_content_and_language() {
        let dir = tempfile::tempdir().unwrap();
        let f = dir.path().join("x.rs");
        std::fs::write(&f, "fn main() {}").unwrap();
        let o = code_open(f.to_string_lossy().to_string()).unwrap();
        assert_eq!(o.content, "fn main() {}");
        assert_eq!(o.language, "rust");
    }

    #[test]
    fn code_open_missing_file_errs() {
        assert!(code_open("/nao/existe/zzz.rs".into()).is_err());
    }

    // ── code_metrics_project (sub-fase 9e) ──────────────────────────────────

    fn project(dir: &std::path::Path) -> Vec<FileMetricsSummary> {
        scan_project(dir, &[]).unwrap()
    }

    /// Scan só retorna os arquivos de CÓDIGO fora de node_modules/.gitignore, e
    /// os números batem o `code_metrics` por-arquivo (consistência do engine).
    #[test]
    fn project_scans_only_code_outside_ignored() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();

        // .gitignore esconde "ignored.rs" (apesar de ser código).
        std::fs::write(root.join(".gitignore"), "ignored.rs\n").unwrap();
        // 1 .rs com função complexa (if + && + for → ciclomática 4).
        let rs = root.join("complex.rs");
        std::fs::write(
            &rs,
            "fn busy(a: bool, b: bool) {\n    if a && b {\n        for _ in 0..3 {\n        }\n    }\n}\n",
        )
        .unwrap();
        // 1 .ts simples.
        std::fs::write(root.join("simple.ts"), "function f() { return 1; }\n").unwrap();
        // 1 .md não-código → sem grammar, ignorado.
        std::fs::write(root.join("readme.md"), "# não é código\n").unwrap();
        // 1 arquivo gitignored (.rs).
        std::fs::write(root.join("ignored.rs"), "fn ig() -> i32 { 1 }\n").unwrap();
        // 1 arquivo em node_modules/ (sempre barrado, mesmo sem .gitignore).
        std::fs::create_dir_all(root.join("node_modules")).unwrap();
        std::fs::write(root.join("node_modules").join("dep.js"), "function d(){}\n").unwrap();

        let out = project(root);

        // Só os 2 de código fora de node_modules/gitignore.
        assert_eq!(out.len(), 2, "esperava complex.rs + simple.ts; veio {out:?}");
        let langs: std::collections::HashSet<_> = out.iter().map(|s| s.language.clone()).collect();
        assert!(langs.contains("rust"));
        assert!(langs.contains("typescript"));
        // Nenhum gitignored / node_modules / .md.
        assert!(out.iter().all(|s| !s.path.contains("ignored.rs")), "gitignored vazou");
        assert!(out.iter().all(|s| !s.path.contains("node_modules")), "node_modules vazou");
        assert!(out.iter().all(|s| !s.path.ends_with(".md")), ".md vazou");

        // Consistência: o summary do .rs bate o `code_metrics` por-arquivo.
        let summary = out.iter().find(|s| s.path.ends_with("complex.rs")).unwrap();
        let per_file = code_metrics(rs.to_string_lossy().to_string()).unwrap();
        assert_eq!(summary.max_cyclomatic, per_file.max_cyclomatic);
        assert_eq!(summary.max_cyclomatic, 4, "if + && + for + base");
        assert_eq!(summary.max_cognitive, per_file.max_cognitive);
        assert_eq!(summary.loc, per_file.loc);
        assert_eq!(summary.fn_count, per_file.functions.len());
        // Severidade derivada da ciclomática máxima — mesma regra do engine.
        assert_eq!(summary.severity, metrics::severity_for(summary.max_cyclomatic));
        assert_eq!(summary.severity, "green");
    }

    /// Arquivo ilegível (não-UTF8) com extensão suportada é PULADO (best-effort),
    /// sem panic e sem derrubar o scan dos arquivos válidos.
    #[test]
    fn project_skips_unreadable_without_panic() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        std::fs::write(root.join("good.rs"), "fn ok() -> i32 { 1 }\n").unwrap();
        // Bytes inválidos em UTF-8 → file_io::read falha → arquivo pulado.
        std::fs::write(root.join("bad.rs"), [0xff, 0xfe, 0x00, 0x80, 0x9f]).unwrap();
        // Sintaxe quebrada (parser tree-sitter é tolerante: não panica).
        std::fs::write(root.join("broken.rs"), "fn ( { ) } incompleto !!! @@@\n").unwrap();

        let out = project(root); // não deve panicar
        assert!(out.iter().any(|s| s.path.ends_with("good.rs")), "good.rs sumiu");
        assert!(out.iter().all(|s| !s.path.ends_with("bad.rs")), "bad.rs ilegível vazou");
    }

    /// Teto de PROJECT_FILE_CAP arquivos: dado cap+1, processa exatamente o cap.
    #[test]
    fn project_respects_file_cap() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        for i in 0..(PROJECT_FILE_CAP + 1) {
            std::fs::write(root.join(format!("f{i}.rs")), "fn a() {}\n").unwrap();
        }
        let out = project(root);
        assert_eq!(out.len(), PROJECT_FILE_CAP, "deve cortar no teto");
    }

    /// `extra_roots` traz arquivos fora de `dir`; paths sobrepostos deduplicam.
    #[test]
    fn project_includes_extra_roots_and_dedups() {
        let dir = tempfile::tempdir().unwrap();
        let other = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("a.rs"), "fn a() {}\n").unwrap();
        std::fs::write(other.path().join("b.rs"), "fn b() {}\n").unwrap();

        let out = scan_project(
            dir.path(),
            &[
                other.path().to_string_lossy().to_string(),
                // Repete `dir` como raiz extra → não deve duplicar a.rs.
                dir.path().to_string_lossy().to_string(),
            ],
        )
        .unwrap();

        assert_eq!(out.len(), 2, "a.rs (uma vez) + b.rs");
        assert!(out.iter().any(|s| s.path.ends_with("a.rs")));
        assert!(out.iter().any(|s| s.path.ends_with("b.rs")));
    }

    /// Raiz inexistente / arquivo (não-diretório) → erro claro, sem panic.
    #[test]
    fn project_errs_on_non_dir() {
        assert!(scan_project(std::path::Path::new("/nao/existe/zzz"), &[]).is_err());
    }
}
