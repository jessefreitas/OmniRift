//! Graphify — knowledge graph de código (comunidades Leiden + god nodes + arestas com
//! confidence EXTRACTED/INFERRED/AMBIGUOUS). O Arquiteto de Pipeline ANCORA o time na
//! arquitetura REAL do repo.
//!
//! A JOGADA: NÃO injetamos o MCP do graphify nos agentes (isso os deixaria consultando o
//! grafo turn-a-turn). Em vez disso rodamos a análise pesada UMA vez, DESTILAMOS o
//! GRAPH_REPORT.md (~6KB — god nodes + comunidades + surprising connections + perguntas) e
//! injetamos o RELATÓRIO no prompt do Arquiteto. O time nasce espelhando a arquitetura real.
//!
//! Detecção/subprocess reusam os padrões já provados no app:
//! - binário: `crate::compress::find_sidecar` (exe-dir → ~/.cargo/bin → PATH), mesmo
//!   resolvedor do `find_omnifs_bin` (omnifs/mod.rs);
//! - fallback via `uvx --from graphifyy graphify` (só se `uvx` existe no PATH) — mesmo
//!   truque do adapter Hermes (acp/mod.rs), que roda pacote python por `uvx`;
//! - spawn assíncrono tokio com `kill_on_drop` + timeout + `NoWindow`, igual ao `llm_via_cli`.
//!
//! Degrada limpo: sem graphify nem uvx → `graphify_available()==false` e `graphify_report`
//! devolve `Ok(None)` (o modal esconde a opção; nada trava).

use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::time::Duration;

use crate::proc_ext::NoWindow;

/// O build re-extrai o repo inteiro (AST) + clustering; em repo grande — e no 1º `uvx`,
/// que baixa numpy/networkx — leva minutos. Timeout generoso.
const BUILD_TIMEOUT: Duration = Duration::from_secs(300);

/// Teto do relatório destilado injetado no prompt do Arquiteto (~6KB — cabe folgado sem
/// estourar o contexto).
const DISTILL_MAX_BYTES: usize = 6 * 1024;

/// Nome do relatório que o graphify gera.
const REPORT_NAME: &str = "GRAPH_REPORT.md";

/// Como invocar o graphify: binário direto (PATH/sidecar) ou via `uvx` (pacote python
/// `graphifyy`). O 2º caminho só existe quando o `uvx` está instalado.
enum GraphifyLauncher {
    Bin(PathBuf),
    Uvx(PathBuf),
}

impl GraphifyLauncher {
    /// (programa, args-prefixo) pra montar o `Command`. No modo uvx o prefixo roda o
    /// pacote python como subprocesso (`uvx --from graphifyy graphify ...`).
    fn cmd(&self) -> (String, Vec<String>) {
        match self {
            GraphifyLauncher::Bin(p) => (p.to_string_lossy().into_owned(), Vec::new()),
            GraphifyLauncher::Uvx(p) => (
                p.to_string_lossy().into_owned(),
                vec!["--from".into(), "graphifyy".into(), "graphify".into()],
            ),
        }
    }
}

/// Resolve como rodar o graphify: binário `graphify` (PATH/sidecar) → senão via `uvx`
/// (se existir). `None` = nem binário nem uvx disponíveis (indisponível).
fn resolve_launcher() -> Option<GraphifyLauncher> {
    if let Some(bin) = crate::compress::find_sidecar("graphify") {
        return Some(GraphifyLauncher::Bin(bin));
    }
    crate::compress::find_sidecar("uvx").map(GraphifyLauncher::Uvx)
}

/// Caminhos onde o GRAPH_REPORT.md pode ter sido gerado (ordem de preferência):
/// cwd, cwd/graphify-out/ (default do CLI), cwd/.graphify/.
fn candidate_report_paths(cwd: &Path) -> Vec<PathBuf> {
    vec![
        cwd.join(REPORT_NAME),
        cwd.join("graphify-out").join(REPORT_NAME),
        cwd.join(".graphify").join(REPORT_NAME),
    ]
}

/// 1º report existente entre os candidatos (None = nenhum gerado ainda).
fn find_existing_report(cwd: &Path) -> Option<PathBuf> {
    candidate_report_paths(cwd).into_iter().find(|p| p.is_file())
}

/// true = dá pra rodar o graphify (binário no PATH/sidecar OU `uvx` disponível). O modal
/// usa isto pra decidir se mostra o toggle "Ancorar na arquitetura real".
#[tauri::command]
pub fn graphify_available() -> bool {
    resolve_launcher().is_some()
}

/// Devolve o GRAPH_REPORT.md DESTILADO (~6KB) do repo em `cwd`, pro Arquiteto ANCORAR o
/// time na arquitetura real. Semântica:
/// - `cwd` vazio ou graphify indisponível → `Ok(None)` (degrada limpo, o modal cai no modo
///   normal).
/// - Report recente já no disco (cwd / graphify-out/ / .graphify/) → lê e destila (NÃO
///   re-builda — o build é caro).
/// - Senão roda `graphify update <cwd>` (extração AST + clustering, sem LLM) com timeout de
///   300s e lê o report gerado. Falha do build → `Err` (o modal avisa e segue sem âncora).
#[tauri::command]
pub async fn graphify_report(cwd: String) -> Result<Option<String>, String> {
    let cwd = cwd.trim().to_string();
    if cwd.is_empty() {
        return Ok(None);
    }
    let Some(launcher) = resolve_launcher() else {
        return Ok(None);
    };
    let cwd_path = PathBuf::from(&cwd);

    // 1) Report já no disco → destila e devolve (não paga o build de novo).
    if let Some(rep) = find_existing_report(&cwd_path) {
        let md = read_report(&rep)?;
        return Ok(Some(distill_graph_report(&md, DISTILL_MAX_BYTES)));
    }

    // 2) Sem report → builda e lê o gerado.
    run_build(&launcher, &cwd_path).await?;
    let rep = find_existing_report(&cwd_path).ok_or_else(|| {
        "graphify rodou mas não gerou GRAPH_REPORT.md — repo sem código extraível?".to_string()
    })?;
    let md = read_report(&rep)?;
    Ok(Some(distill_graph_report(&md, DISTILL_MAX_BYTES)))
}

fn read_report(path: &Path) -> Result<String, String> {
    std::fs::read_to_string(path).map_err(|e| format!("ler {}: {e}", path.display()))
}

/// Roda `graphify update <cwd>` (async tokio, `kill_on_drop` → sem leak de processo se o
/// timeout cancelar o wait; mesma lição do `cli_run`/`pty_kill`). `update` re-extrai o
/// código e regenera graph.json + GRAPH_REPORT.md sem precisar de LLM.
async fn run_build(launcher: &GraphifyLauncher, cwd: &Path) -> Result<(), String> {
    let (prog, mut args) = launcher.cmd();
    args.push("update".into());
    args.push(cwd.to_string_lossy().into_owned());

    let mut cmd = tokio::process::Command::new(&prog);
    cmd.args(&args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .no_window();

    let child = cmd
        .spawn()
        .map_err(|e| format!("não consegui rodar `{prog}`: {e}"))?;
    let out = tokio::time::timeout(BUILD_TIMEOUT, child.wait_with_output())
        .await
        .map_err(|_| {
            format!(
                "graphify estourou o timeout de {}s (repo grande? processo finalizado)",
                BUILD_TIMEOUT.as_secs()
            )
        })?
        .map_err(|e| format!("falha lendo o output do graphify: {e}"))?;

    if out.status.success() {
        return Ok(());
    }
    // Falhou: o stderr costuma explicar (sem código, pacote quebrado…). Resume pro toast.
    let stderr = String::from_utf8_lossy(&out.stderr);
    let stdout = String::from_utf8_lossy(&out.stdout);
    let src = if stderr.trim().is_empty() { stdout } else { stderr };
    let brief: String = src.trim().chars().take(500).collect();
    Err(format!("graphify update falhou ({}): {brief}", out.status))
}

/// Destila um GRAPH_REPORT.md pra caber em `max_bytes`, mantendo SÓ as seções centrais que
/// o Arquiteto precisa: God Nodes, Comunidades (nomes + tamanhos), Surprising Connections,
/// Suggested Questions e o Summary (nós/arestas + distribuição de confidence). O resto
/// (Corpus Check, Import Cycles, Knowledge Gaps…) é cortado.
///
/// Função PURA (sem IO/env) → testável. Invariante garantida: `saída.len() <= max_bytes`.
/// Estratégia: preâmbulo (o H1 e o que vier antes da 1ª seção) é a base; as seções centrais
/// entram por ORDEM DE IMPORTÂNCIA enquanto couberem no orçamento, e a saída é remontada na
/// ORDEM ORIGINAL do documento. Sem nenhuma seção reconhecida (formato estranho) → devolve o
/// md cru truncado (nunca volta vazio).
pub fn distill_graph_report(md: &str, max_bytes: usize) -> String {
    const NOTE: &str = "\n\n_[relatório Graphify destilado — só as seções centrais]_\n";

    // Preâmbulo = tudo antes da 1ª linha "## "; depois, cada "## " abre uma seção.
    let mut preamble = String::new();
    let mut sections: Vec<String> = Vec::new();
    for line in md.lines() {
        if line.starts_with("## ") {
            sections.push(String::new());
        }
        match sections.last_mut() {
            Some(s) => {
                s.push_str(line);
                s.push('\n');
            }
            None => {
                preamble.push_str(line);
                preamble.push('\n');
            }
        }
    }

    // Importância (menor = mais importante, cai por último no orçamento). Uma comunidade →
    // um floor/agente; god nodes → zona de review; por isso vêm primeiro. "communit" casa
    // tanto "Community Hubs" quanto "Communities".
    fn rank(section: &str) -> Option<u8> {
        let head = section.lines().next().unwrap_or("").to_lowercase();
        if head.contains("god node") {
            Some(0)
        } else if head.contains("communit") {
            Some(1)
        } else if head.contains("surprising") {
            Some(2)
        } else if head.contains("suggested") {
            Some(3)
        } else if head.contains("summary") {
            Some(4)
        } else {
            None
        }
    }

    // Seções centrais com seu índice de documento (pra remontar em ordem).
    let mut kept: Vec<(usize, u8)> = sections
        .iter()
        .enumerate()
        .filter_map(|(i, s)| rank(s).map(|r| (i, r)))
        .collect();

    // Formato não reconhecido → não perde o report: devolve o cru truncado.
    if kept.is_empty() {
        return truncate_on_boundary(md, max_bytes);
    }

    // Guloso por importância, respeitando o teto (a NOTE já entra no orçamento base).
    kept.sort_by_key(|&(_, r)| r);
    let base = preamble.len() + NOTE.len();
    let mut used = base;
    let mut include: Vec<usize> = Vec::new();
    for &(i, _) in &kept {
        let len = sections[i].len();
        if used + len <= max_bytes {
            used += len;
            include.push(i);
        }
    }

    // Remonta na ORDEM DO DOCUMENTO (leitura natural).
    include.sort_unstable();
    let mut out = preamble;
    for i in include {
        out.push_str(&sections[i]);
    }
    out.push_str(NOTE);

    // Safety: o preâmbulo sozinho pode estourar o teto → corta no boundary.
    truncate_on_boundary(&out, max_bytes)
}

/// Trunca `s` pra no máximo `max_bytes`, recuando até um char boundary (não corta UTF-8 no
/// meio — o report tem acento/emoji/box-drawing).
fn truncate_on_boundary(s: &str, max_bytes: usize) -> String {
    if s.len() <= max_bytes {
        return s.to_string();
    }
    let mut end = max_bytes;
    while end > 0 && !s.is_char_boundary(end) {
        end -= 1;
    }
    s[..end].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Report realista (mesmas seções do graphify real): distila mantendo as centrais e
    /// cortando as periféricas.
    const SAMPLE: &str = "\
# Graph Report - projeto  (2026-07-02)

## Corpus Check
- 2 files · ~29 words
- Verdict: corpus is large enough.

## Summary
- 7 nodes · 10 edges · 2 communities
- Extraction: 100% EXTRACTED · 0% INFERRED · 0% AMBIGUOUS

## Community Hubs (Navigation)
- [[_COMMUNITY_a.py|a.py]]
- [[_COMMUNITY_Widget|Widget]]

## God Nodes (most connected - your core abstractions)
1. `Widget` - 4 edges
2. `foo()` - 3 edges

## Surprising Connections (you probably didn't know these)
- `main()` --calls--> `Widget`  [EXTRACTED]

## Import Cycles
- None detected.

## Communities (2 total)
- Community 1: auth (5 nodes)
- Community 2: rendering (3 nodes)

## Knowledge Gaps
- 2 thin communities omitted.

## Suggested Questions
- **Why does `Widget` bridge to `a.py`?**
";

    #[test]
    fn distill_keeps_core_sections_and_drops_periphery() {
        let out = distill_graph_report(SAMPLE, 6 * 1024);
        // Preâmbulo (H1) preservado.
        assert!(out.contains("# Graph Report - projeto"));
        // Seções centrais mantidas.
        assert!(out.contains("## God Nodes"), "god nodes: {out}");
        assert!(out.contains("## Community Hubs"), "hubs: {out}");
        assert!(out.contains("## Communities"), "communities: {out}");
        assert!(out.contains("## Surprising Connections"), "surprising: {out}");
        assert!(out.contains("## Suggested Questions"), "suggested: {out}");
        assert!(out.contains("## Summary"), "summary: {out}");
        // Confidence das arestas (EXTRACTED/…) sobrevive (vem no Summary + Surprising).
        assert!(out.contains("EXTRACTED"));
        // Tamanhos das comunidades sobrevivem.
        assert!(out.contains("5 nodes") && out.contains("3 nodes"));
        // Periféricas cortadas.
        assert!(!out.contains("## Corpus Check"), "corpus não devia entrar");
        assert!(!out.contains("## Import Cycles"), "cycles não devia entrar");
        assert!(!out.contains("## Knowledge Gaps"), "gaps não devia entrar");
        // Marca de destilado.
        assert!(out.contains("destilado"));
    }

    #[test]
    fn distill_respects_byte_budget_on_large_report() {
        // Report gigante: 400 seções de God Nodes fajutas de ~1KB cada (~400KB).
        let mut big = String::from("# Graph Report - huge  (2026-07-02)\n\n");
        for i in 0..400 {
            big.push_str(&format!("## God Nodes batch {i}\n"));
            big.push_str(&"x".repeat(1000));
            big.push('\n');
        }
        let max = 6 * 1024;
        let out = distill_graph_report(&big, max);
        assert!(out.len() <= max, "estourou o teto: {} > {max}", out.len());
        // Ainda assim entregou conteúdo útil (H1 + ao menos 1 seção).
        assert!(out.contains("# Graph Report - huge"));
        assert!(out.contains("## God Nodes batch"));
    }

    #[test]
    fn distill_multibyte_never_splits_char() {
        // Preâmbulo cheio de multibyte maior que o teto → corta no boundary, sem panic e
        // continua UTF-8 válido (String garante isso; o assert é a prova de que não truncou
        // no meio de um code point).
        let md = format!("# {}\n", "áç🧠".repeat(2000)); // sem seções "## " → caminho do fallback
        let out = distill_graph_report(&md, 64);
        assert!(out.len() <= 64);
        assert!(std::str::from_utf8(out.as_bytes()).is_ok());
    }

    #[test]
    fn distill_unrecognized_format_returns_truncated_raw() {
        let md = "só um texto sem cabeçalhos de seção nenhum";
        let out = distill_graph_report(md, 10);
        assert!(out.len() <= 10);
        assert!(md.starts_with(&out)); // é um prefixo do original (truncado)
    }

    #[test]
    fn launcher_uvx_cmd_prefixes_package() {
        let l = GraphifyLauncher::Uvx(PathBuf::from("/home/x/.local/bin/uvx"));
        let (prog, args) = l.cmd();
        assert_eq!(prog, "/home/x/.local/bin/uvx");
        assert_eq!(args, vec!["--from", "graphifyy", "graphify"]);
        // Binário direto: sem prefixo.
        let b = GraphifyLauncher::Bin(PathBuf::from("/usr/bin/graphify"));
        assert_eq!(b.cmd().1, Vec::<String>::new());
    }

    #[test]
    fn find_existing_report_prefers_graphify_out() {
        let dir = tempfile::tempdir().unwrap();
        // Nenhum report ainda.
        assert!(find_existing_report(dir.path()).is_none());
        // Report em graphify-out/ é encontrado.
        let out = dir.path().join("graphify-out");
        std::fs::create_dir_all(&out).unwrap();
        std::fs::write(out.join(REPORT_NAME), b"# rep").unwrap();
        assert_eq!(find_existing_report(dir.path()), Some(out.join(REPORT_NAME)));
        // Report na raiz do cwd tem precedência (1º candidato).
        std::fs::write(dir.path().join(REPORT_NAME), b"# raiz").unwrap();
        assert_eq!(
            find_existing_report(dir.path()),
            Some(dir.path().join(REPORT_NAME))
        );
    }
}
