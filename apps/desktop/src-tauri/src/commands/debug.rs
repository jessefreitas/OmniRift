//! Comando Tauri do DebuggerAgent (Fase 9, sub-fase 9d).
//!
//! `debug_request` monta — sob demanda — um PROMPT rico em PT-BR pro DebuggerAgent
//! a partir de um arquivo do CodeNode: conteúdo + linguagem, a pior função (maior
//! complexidade ciclomática, via `code_metrics`), o erro/seleção do usuário e bugs
//! similares já resolvidos (busca no provider de memória ATIVO). O backend NÃO
//! spawna o agente — devolve o prompt + metadados pro frontend, que reaproveita o
//! caminho de spawn existente (`addTerminal` + `agent_mcp_config` injeta Serena +
//! memória, igual aos outros agentes). Assim o DebuggerAgent nasce memory-aware.
//!
//! Tudo é best-effort: se métricas/memória falharem, segue com o contexto que tiver
//! (degrada — nunca trava o pedido de debug).
//!
//! ⚠️ Compliance (spec §11): o conteúdo do arquivo NUNCA é logado. O prompt vai pro
//! agente (que é quem precisa dele), não pra logs. Não há `println!`/`tracing` de
//! conteúdo aqui — só do `path` (não-sensível) em caminhos de erro, se necessário.

use std::path::Path;
use std::sync::Arc;

use serde::{Deserialize, Serialize};
use tauri::State;

use crate::code::{file_io, metrics, monaco_language, CodeMetrics, FunctionMetrics};
use crate::memory::{MemoryQuery, MemoryRegistry};

/// Payload do pedido de debug vindo do CodeNode (frontend → backend).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRequestPayload {
    /// Caminho absoluto do arquivo aberto no CodeNode.
    pub file_path: String,
    /// Texto do erro (stack trace, mensagem do compilador) — opcional.
    #[serde(default)]
    pub error_text: Option<String>,
    /// Trecho selecionado no editor (foco do debug) — opcional.
    #[serde(default)]
    pub selection: Option<String>,
}

/// Resposta: o prompt pronto pro DebuggerAgent + metadados (pro frontend exibir
/// e decidir o spawn). Conteúdo do arquivo NÃO sai daqui (só o prompt, que o agente
/// precisa, e números/labels não-sensíveis).
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugRequestResult {
    /// Prompt PT-BR rico, pronto pra ir como 1ª tarefa do agente "debugger".
    pub prompt: String,
    /// Linguagem (id Monaco) do arquivo.
    pub language: String,
    /// Métricas calculadas (ou `None` se a linguagem não tem grammar / falhou).
    pub metrics: Option<CodeMetrics>,
    /// Quantos bugs similares foram encontrados na memória ativa.
    pub similar_bugs: usize,
}

/// Função com a pior (maior) complexidade ciclomática do arquivo.
fn worst_function(m: &CodeMetrics) -> Option<&FunctionMetrics> {
    m.functions.iter().max_by_key(|f| f.cyclomatic)
}

/// Termo de busca pra memória: foca o erro, senão a pior função, senão o nome do arquivo.
fn memory_query_for(
    file_name: &str,
    error_text: Option<&str>,
    worst: Option<&FunctionMetrics>,
) -> String {
    if let Some(err) = error_text.map(str::trim).filter(|s| !s.is_empty()) {
        // 1ª linha do erro é a mais informativa pra similaridade.
        return err.lines().next().unwrap_or(err).chars().take(160).collect();
    }
    if let Some(w) = worst {
        return format!("bug {} {} complexidade alta", file_name, w.name);
    }
    format!("bug {}", file_name)
}

/// Monta o prompt PT-BR do DebuggerAgent. Tudo opcional degrada (linhas só aparecem
/// quando há dado). O agente recebe Serena + memória injetados via agent_mcp_config.
fn build_prompt(
    file_path: &str,
    language: &str,
    content_lines: usize,
    worst: Option<&FunctionMetrics>,
    error_text: Option<&str>,
    selection: Option<&str>,
    similar: &[String],
) -> String {
    let mut p = String::new();
    p.push_str(
        "Você é o DebuggerAgent do OmniRift. Faça um debug CIRÚRGICO e semântico (via AST/LSP, \
         NÃO grep). Investigue, proponha o fix e aplique-o de forma mínima.\n\n",
    );

    p.push_str(&format!("Arquivo: {file_path}\n"));
    p.push_str(&format!("Linguagem: {language}\n"));
    p.push_str(&format!("Linhas: {content_lines}\n"));

    if let Some(w) = worst {
        p.push_str(&format!(
            "Pior função (maior complexidade): {} (linhas {}–{}) · ciclomática {} · cognitiva {} · MI {} · severidade {}\n",
            w.name,
            w.start_line,
            w.end_line,
            w.cyclomatic,
            w.cognitive,
            w.maintainability_index.round() as i64,
            w.severity,
        ));
    }

    if let Some(err) = error_text.map(str::trim).filter(|s| !s.is_empty()) {
        p.push_str("\nErro relatado:\n```\n");
        p.push_str(err);
        p.push_str("\n```\n");
    }

    if let Some(sel) = selection.map(str::trim).filter(|s| !s.is_empty()) {
        p.push_str("\nTrecho em foco (seleção do usuário):\n```\n");
        p.push_str(sel);
        p.push_str("\n```\n");
    }

    if !similar.is_empty() {
        p.push_str("\nBugs similares já resolvidos (memória do projeto) — reuse o aprendizado:\n");
        for (i, s) in similar.iter().enumerate() {
            let one_line: String = s.lines().next().unwrap_or(s).chars().take(200).collect();
            p.push_str(&format!("  {}. {}\n", i + 1, one_line));
        }
    }

    p.push_str(
        "\nPasso a passo:\n\
         1. Consulte o Serena via MCP: `find_symbol` (localize a função/símbolo com problema) e \
         `get_references`/`find_referencing_symbols` (quem chama isso, impacto cross-file).\n\
         2. Identifique a causa-raiz com base no erro, nas métricas e nas referências — não chute.\n\
         3. Proponha o fix MÍNIMO que resolve o problema; explique o porquê em 1-2 frases.\n\
         4. Aplique o fix via `replace_symbol_body` do Serena (edição por AST, não string-match).\n\
         5. Grave o aprendizado na memória (categoria \"debug_fix\") com o que foi: \
         \"<função>: <sintoma> → <correção> (motivo)\", pra reusar quando o bug reaparecer.\n\
         Não refatore além do necessário nem toque em outros arquivos sem justificativa.\n",
    );

    p
}

/// Monta o prompt + metadados pro DebuggerAgent. NÃO spawna (o frontend spawna,
/// reaproveitando addTerminal + a injeção de Serena/memória do agent_mcp_config).
///
/// Roda sob demanda (clique no botão "Debug") — contexto async de comando, OK pro
/// `.await` da busca de memória. Não toca no `setup()`/boot.
#[tauri::command]
pub async fn debug_request(
    payload: DebugRequestPayload,
    memory_registry: State<'_, Arc<MemoryRegistry>>,
) -> Result<DebugRequestResult, String> {
    let path = Path::new(&payload.file_path);
    let file_name = path
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or(&payload.file_path)
        .to_string();
    let language = monaco_language(path).to_string();

    // Conteúdo do arquivo — necessário pra contar linhas e pras métricas. Se não
    // conseguir ler, é fatal (sem arquivo não há o que depurar).
    let content = file_io::read(path).map_err(|e| e.to_string())?;
    let content_lines = content.lines().count();

    // Métricas (best-effort): linguagem sem grammar (ex.: .md/.json) ou erro → None.
    let metrics: Option<CodeMetrics> = metrics::compute(path, &content).ok();
    let worst = metrics.as_ref().and_then(worst_function).cloned();

    // Busca bugs similares no provider de memória ATIVO (best-effort). Falha de
    // rede/provider → segue sem (lista vazia), nunca derruba o pedido de debug.
    let query = memory_query_for(&file_name, payload.error_text.as_deref(), worst.as_ref());
    let provider = memory_registry.active_provider();
    let similar: Vec<String> = match provider
        .search(MemoryQuery {
            query,
            project: None,
            limit: 5,
        })
        .await
    {
        Ok(records) => records.into_iter().map(|r| r.content).collect(),
        Err(_) => Vec::new(),
    };

    let prompt = build_prompt(
        &payload.file_path,
        &language,
        content_lines,
        worst.as_ref(),
        payload.error_text.as_deref(),
        payload.selection.as_deref(),
        &similar,
    );

    Ok(DebugRequestResult {
        prompt,
        language,
        metrics,
        similar_bugs: similar.len(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn build_prompt_includes_file_and_steps() {
        let p = build_prompt("/tmp/x.rs", "rust", 42, None, None, None, &[]);
        assert!(p.contains("/tmp/x.rs"));
        assert!(p.contains("rust"));
        assert!(p.contains("find_symbol"));
        assert!(p.contains("replace_symbol_body"));
        assert!(p.contains("debug_fix"));
    }

    #[test]
    fn build_prompt_includes_error_and_selection() {
        let p = build_prompt(
            "/tmp/x.ts",
            "typescript",
            10,
            None,
            Some("TypeError: cannot read property 'x' of undefined"),
            Some("const a = obj.x;"),
            &[],
        );
        assert!(p.contains("Erro relatado"));
        assert!(p.contains("TypeError"));
        assert!(p.contains("seleção do usuário"));
        assert!(p.contains("const a = obj.x;"));
    }

    #[test]
    fn build_prompt_lists_similar_bugs() {
        let p = build_prompt(
            "/tmp/x.py",
            "python",
            5,
            None,
            None,
            None,
            &["foo: KeyError → use dict.get (default seguro)".into()],
        );
        assert!(p.contains("Bugs similares"));
        assert!(p.contains("KeyError"));
    }

    #[test]
    fn memory_query_prefers_error_first_line() {
        let q = memory_query_for("x.rs", Some("panic: index out of bounds\n  at foo()"), None);
        assert_eq!(q, "panic: index out of bounds");
    }

    #[test]
    fn memory_query_falls_back_to_worst_function() {
        let worst = FunctionMetrics {
            name: "big_fn".into(),
            start_line: 1,
            end_line: 80,
            cyclomatic: 22,
            cognitive: 30,
            halstead_volume: 500.0,
            halstead_difficulty: 8.0,
            maintainability_index: 40.0,
            severity: "red".into(),
        };
        let q = memory_query_for("x.rs", None, Some(&worst));
        assert!(q.contains("big_fn"));
        assert!(q.contains("x.rs"));
    }

    #[test]
    fn memory_query_falls_back_to_file_name() {
        let q = memory_query_for("x.rs", None, None);
        assert_eq!(q, "bug x.rs");
    }
}
