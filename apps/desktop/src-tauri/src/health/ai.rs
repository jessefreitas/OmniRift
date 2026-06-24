//! `health_analyze_file` — análise de IA SOB DEMANDA de um arquivo: lê + roda
//! `code::metrics`, monta um prompt PT-BR pedindo a análise (smells, refactors,
//! risco) **em JSON** no formato `AiReport`, e roda o agente.
//!
//! Motor de IA (decisão da Fase A — spec §"Em aberto"): **agente headless via CLI**.
//! Spawna `claude -p "<prompt>"` (fallback `codex exec "<prompt>"`), captura stdout
//! e extrai o JSON. Razão: o painel não tem um provider/LLM próprio garantido no
//! backend (o `llm_chat` exige `LlmConfig` BYOK vindo do front, e o provider de
//! memória ≠ provider de LLM). O CLI já está no PATH dos usuários do OmniRift (é o
//! que eles usam pra spawnar agentes), roda offline-ish (subscription do usuário) e
//! não exige passar credencial pelo IPC. Degrada limpo: sem `claude`/`codex` no
//! PATH → `Err` amigável ("análise IA indisponível — configure um agente").
//!
//! Boundary: este módulo SÓ fala com o agente/LLM — não caminha o projeto.
//! Conteúdo do arquivo vai no prompt (o agente precisa), NUNCA em log.

use std::path::Path;

use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use tokio::process::Command as TokioCommand;

use crate::code::{file_io, metrics, monaco_language, CodeMetrics, FunctionMetrics};
use crate::proc_ext::NoWindow;

/// Um achado da análise de IA.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiFinding {
    /// "critical" | "warning" | "info" (severidade).
    pub severity: String,
    /// "smell" | "refactor" | "risk" | "perf" | "security" | … (categoria).
    pub kind: String,
    pub title: String,
    pub detail: String,
    /// Sugestão de correção/refactor.
    pub suggestion: String,
    /// Linha aproximada (opcional).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub line: Option<usize>,
}

/// Relatório de IA — o que o front recebe e renderiza no `AiReportView`.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AiReport {
    /// Alvo da análise (o caminho do arquivo).
    pub target: String,
    pub findings: Vec<AiFinding>,
    /// Resumo executivo (1-3 frases) do estado do arquivo.
    pub summary: String,
}

/// Função com a pior (maior) complexidade ciclomática.
fn worst_function(m: &CodeMetrics) -> Option<&FunctionMetrics> {
    m.functions.iter().max_by_key(|f| f.cyclomatic)
}

/// Monta o prompt PT-BR pedindo o relatório EM JSON estrito (formato `AiReport`).
/// Inclui as métricas (números) + o conteúdo do arquivo (o agente precisa pra
/// análise). Métricas opcionais degradam (linha some quando não há dado).
pub fn build_prompt(
    file_path: &str,
    language: &str,
    content: &str,
    metrics: Option<&CodeMetrics>,
) -> String {
    let mut p = String::new();
    p.push_str(
        "Você é o analista de saúde de código do OmniRift. Analise o arquivo abaixo e \
         produza um relatório de qualidade: code smells, refactors recomendados e riscos \
         (bug-proneness, acoplamento, manutenibilidade).\n\n",
    );
    p.push_str(&format!("Arquivo: {file_path}\n"));
    p.push_str(&format!("Linguagem: {language}\n"));

    if let Some(m) = metrics {
        p.push_str(&format!(
            "Métricas do arquivo: LOC {} · ciclomática máx {} · cognitiva máx {} · MI {}\n",
            m.loc,
            m.max_cyclomatic,
            m.max_cognitive,
            m.maintainability_index.round() as i64,
        ));
        if let Some(w) = worst_function(m) {
            p.push_str(&format!(
                "Pior função: {} (linhas {}–{}) · ciclomática {} · cognitiva {} · severidade {}\n",
                w.name, w.start_line, w.end_line, w.cyclomatic, w.cognitive, w.severity,
            ));
        }
    }

    p.push_str("\nConteúdo do arquivo:\n```");
    p.push_str(language);
    p.push('\n');
    p.push_str(content);
    p.push_str("\n```\n");

    p.push_str(
        "\nRESPONDA APENAS com um objeto JSON VÁLIDO (sem markdown, sem comentários, sem \
         texto antes ou depois), exatamente neste formato:\n\
         {\n\
         \x20 \"target\": \"<caminho do arquivo>\",\n\
         \x20 \"summary\": \"<1-3 frases sobre o estado do arquivo>\",\n\
         \x20 \"findings\": [\n\
         \x20\x20\x20 {\n\
         \x20\x20\x20\x20\x20 \"severity\": \"critical|warning|info\",\n\
         \x20\x20\x20\x20\x20 \"kind\": \"smell|refactor|risk|perf|security\",\n\
         \x20\x20\x20\x20\x20 \"title\": \"<título curto>\",\n\
         \x20\x20\x20\x20\x20 \"detail\": \"<o que é o problema>\",\n\
         \x20\x20\x20\x20\x20 \"suggestion\": \"<como corrigir/refatorar>\",\n\
         \x20\x20\x20\x20\x20 \"line\": <número da linha ou omita>\n\
         \x20\x20\x20 }\n\
         \x20 ]\n\
         }\n\
         Se o arquivo estiver saudável, devolva findings vazio e diga no summary. \
         Seja específico e acionável.\n",
    );
    p
}

/// Extrai o primeiro objeto JSON balanceado de um texto (o agente pode cercar com
/// markdown/preâmbulo). Procura o 1º `{` e casa as chaves respeitando strings.
pub fn extract_json(text: &str) -> Option<String> {
    let bytes = text.as_bytes();
    let start = text.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut escaped = false;
    for (i, &b) in bytes.iter().enumerate().skip(start) {
        let c = b as char;
        if in_str {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_str = false;
            }
            continue;
        }
        match c {
            '"' => in_str = true,
            '{' => depth += 1,
            '}' => {
                depth -= 1;
                if depth == 0 {
                    return Some(text[start..=i].to_string());
                }
            }
            _ => {}
        }
    }
    None
}

/// Parseia a saída do agente num `AiReport`. Garante o `target` (sobrescreve com
/// o caminho real, caso o agente erre). Erro = JSON ausente/inválido.
pub fn parse_report(stdout: &str, target: &str) -> Result<AiReport, String> {
    let json = extract_json(stdout)
        .ok_or_else(|| "o agente não devolveu JSON parseável".to_string())?;
    let mut report: AiReport =
        serde_json::from_str(&json).map_err(|e| format!("JSON do agente inválido: {e}"))?;
    report.target = target.to_string();
    Ok(report)
}

/// CLI de agente headless + os args pra rodar um prompt único e capturar stdout.
/// `claude -p "<prompt>"` (modo print) ou `codex exec "<prompt>"`.
fn agent_invocation(prompt: &str) -> Option<(&'static str, Vec<String>)> {
    if is_on_path("claude") {
        return Some(("claude", vec!["-p".into(), prompt.to_string()]));
    }
    if is_on_path("codex") {
        return Some(("codex", vec!["exec".into(), prompt.to_string()]));
    }
    None
}

/// `which`/`where <binary>` — true se no PATH (espelha clis.rs).
fn is_on_path(binary: &str) -> bool {
    let finder = if cfg!(target_os = "windows") { "where" } else { "which" };
    std::process::Command::new(finder)
        .arg(binary)
        .no_window()
        .output()
        .map(|o| o.status.success() && !o.stdout.is_empty())
        .unwrap_or(false)
}

/// Analisa um arquivo via IA: lê + métricas → prompt → agente headless → `AiReport`.
/// Degrada limpo: sem CLI de agente no PATH → `Err` amigável. Conteúdo só vai no
/// prompt (pro agente), nunca em log.
#[tauri::command]
pub async fn health_analyze_file(_app: AppHandle, path: String) -> Result<AiReport, String> {
    let p = Path::new(&path);
    let language = monaco_language(p).to_string();
    let content = file_io::read(p).map_err(|e| e.to_string())?;
    let metrics: Option<CodeMetrics> = metrics::compute(p, &content).ok();

    let prompt = build_prompt(&path, &language, &content, metrics.as_ref());

    let (bin, args) = agent_invocation(&prompt)
        .ok_or_else(|| "análise IA indisponível — configure um agente (instale o CLI `claude` ou `codex`)".to_string())?;

    let output = TokioCommand::new(bin)
        .args(&args)
        .no_window()
        .output()
        .await
        .map_err(|e| format!("falha ao rodar o agente '{bin}': {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(format!(
            "o agente '{bin}' falhou (exit {}): {}",
            output.status.code().unwrap_or(-1),
            stderr.trim()
        ));
    }

    let stdout = String::from_utf8_lossy(&output.stdout);
    parse_report(&stdout, &path)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn sample_metrics() -> CodeMetrics {
        let src = "fn big(a: bool) {\n    if a {\n        for _ in 0..3 {}\n    }\n}\n";
        metrics::compute(&PathBuf::from("x.rs"), src).unwrap()
    }

    #[test]
    fn build_prompt_includes_path_lang_content_and_json_schema() {
        let m = sample_metrics();
        let p = build_prompt("/tmp/x.rs", "rust", "fn big() {}", Some(&m));
        assert!(p.contains("/tmp/x.rs"));
        assert!(p.contains("rust"));
        assert!(p.contains("fn big()"), "conteúdo do arquivo no prompt");
        assert!(p.contains("JSON"), "pede JSON");
        assert!(p.contains("\"findings\""), "esquema com findings");
        assert!(p.contains("\"severity\""), "esquema com severity");
        assert!(p.contains("Pior função: big"), "pior função das métricas");
    }

    #[test]
    fn build_prompt_degrades_without_metrics() {
        let p = build_prompt("/tmp/y.ts", "typescript", "const a = 1;", None);
        assert!(p.contains("/tmp/y.ts"));
        assert!(!p.contains("Pior função"), "sem métricas → sem linha de função");
        assert!(p.contains("\"summary\""), "ainda pede o esquema");
    }

    #[test]
    fn extract_json_from_fenced_markdown() {
        let raw = "Claro, aqui está:\n```json\n{\"target\":\"x\",\"summary\":\"ok\",\"findings\":[]}\n```\nFim.";
        let j = extract_json(raw).unwrap();
        assert_eq!(j, "{\"target\":\"x\",\"summary\":\"ok\",\"findings\":[]}");
    }

    #[test]
    fn extract_json_handles_nested_braces_and_strings() {
        let raw = "{\"a\": {\"b\": 1}, \"s\": \"tem } chave na string\"}";
        let j = extract_json(raw).unwrap();
        assert_eq!(j, raw);
    }

    #[test]
    fn extract_json_none_when_absent() {
        assert!(extract_json("nenhum json aqui").is_none());
    }

    #[test]
    fn parse_report_overrides_target() {
        let stdout = "{\"target\":\"errado\",\"summary\":\"tem smells\",\"findings\":[{\"severity\":\"warning\",\"kind\":\"smell\",\"title\":\"função longa\",\"detail\":\"40 linhas\",\"suggestion\":\"extraia\",\"line\":12}]}";
        let r = parse_report(stdout, "/real/path.rs").unwrap();
        assert_eq!(r.target, "/real/path.rs", "target sobrescrito com o real");
        assert_eq!(r.summary, "tem smells");
        assert_eq!(r.findings.len(), 1);
        assert_eq!(r.findings[0].severity, "warning");
        assert_eq!(r.findings[0].line, Some(12));
    }

    #[test]
    fn parse_report_optional_line_omitted() {
        let stdout = "{\"target\":\"x\",\"summary\":\"ok\",\"findings\":[{\"severity\":\"info\",\"kind\":\"refactor\",\"title\":\"t\",\"detail\":\"d\",\"suggestion\":\"s\"}]}";
        let r = parse_report(stdout, "x").unwrap();
        assert_eq!(r.findings[0].line, None);
    }

    #[test]
    fn parse_report_errs_on_garbage() {
        assert!(parse_report("isso não é json", "x").is_err());
    }
}
