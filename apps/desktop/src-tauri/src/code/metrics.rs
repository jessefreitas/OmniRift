//! Motor de métricas de complexidade (Fase 9c) sobre tree-sitter.
//!
//! Calcula, POR FUNÇÃO:
//!   - **Ciclomática** (McCabe 1976): 1 + nº de pontos de decisão
//!     (if/else-if, for, while, loop, match arms/case, &&, ||, ?, catch/except).
//!   - **Cognitiva** (SonarSource 2016, simplificada): +1 por estrutura que quebra
//!     o fluxo, com **penalidade de aninhamento** (estruturas aninhadas custam mais).
//!   - **LOC** da função (linhas físicas do span).
//!
//! Linguagens cobertas pelas grammars já presentes no Cargo.toml:
//!   - Rust  → `tree_sitter_rust::LANGUAGE`
//!   - TS    → `tree_sitter_typescript::LANGUAGE_TYPESCRIPT`
//!   - TSX   → `tree_sitter_typescript::LANGUAGE_TSX`
//!   - JS/JSX→ grammar do TSX (superset do JS — cobre `.js/.jsx` pras métricas;
//!             a crate `tree-sitter-javascript` compatível com a ABI 0.25 não está
//!             vendorada, então reusamos o TSX, que parseia JS sem perda pros
//!             contadores de pontos de decisão).
//!   - Python→ `tree_sitter_python::LANGUAGE`
//!
//! Conteúdo do arquivo NUNCA é logado (só números) — ver compliance A.8.10 da spec.

use std::path::Path;

use tree_sitter::{Language, Node, Parser};

use super::{CodeMetrics, FunctionMetrics};

/// Linguagem suportada pelo motor de métricas (subset com grammar disponível).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MetricLang {
    Rust,
    /// TypeScript "puro" (`.ts`, `.mts`, `.cts`).
    TypeScript,
    /// TSX e também JS/JSX (grammar TSX é superset suficiente pras métricas).
    Tsx,
    Python,
}

impl MetricLang {
    /// Resolve a linguagem pela extensão. `None` = sem grammar → erro-suave.
    pub fn from_path(path: &Path) -> Option<Self> {
        match path
            .extension()
            .and_then(|e| e.to_str())
            .map(|s| s.to_ascii_lowercase())
            .as_deref()
        {
            Some("rs") => Some(Self::Rust),
            Some("ts") | Some("mts") | Some("cts") => Some(Self::TypeScript),
            // TSX + JS/JSX: grammar TSX cobre todos pros contadores.
            Some("tsx") | Some("js") | Some("mjs") | Some("cjs") | Some("jsx") => Some(Self::Tsx),
            Some("py") | Some("pyi") => Some(Self::Python),
            _ => None,
        }
    }

    /// Nome canônico (espelha `monaco_language` quando possível).
    fn name(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::TypeScript => "typescript",
            Self::Tsx => "typescript",
            Self::Python => "python",
        }
    }

    fn ts_language(self) -> Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
        }
    }

    /// É um nó que define uma função/método/closure nomeável?
    fn is_function_node(self, kind: &str) -> bool {
        match self {
            Self::Rust => matches!(kind, "function_item" | "function_signature_item"),
            Self::TypeScript | Self::Tsx => matches!(
                kind,
                "function_declaration"
                    | "function_expression"
                    | "function"
                    | "method_definition"
                    | "arrow_function"
                    | "generator_function"
                    | "generator_function_declaration"
            ),
            Self::Python => matches!(kind, "function_definition"),
        }
    }

    /// Conta quantos pontos de decisão (+1 ciclomática) este nó representa.
    /// Para operadores booleanos (`&&`/`||`/`and`/`or`) cada ocorrência soma +1.
    fn cyclomatic_points(self, node: Node, src: &[u8]) -> u32 {
        let kind = node.kind();
        match self {
            Self::Rust => match kind {
                "if_expression" | "while_expression" | "loop_expression" | "for_expression"
                | "match_arm" | "try_expression" => 1,
                "binary_expression" => is_logical_op(node, src, &["&&", "||"]) as u32,
                _ => 0,
            },
            Self::TypeScript | Self::Tsx => match kind {
                "if_statement" | "for_statement" | "for_in_statement" | "while_statement"
                | "do_statement" | "switch_case" | "catch_clause" | "ternary_expression" => 1,
                "binary_expression" => is_logical_op(node, src, &["&&", "||", "??"]) as u32,
                "optional_chain" => 1, // `?.` é um curto-circuito (ramo a mais)
                _ => 0,
            },
            Self::Python => match kind {
                "if_statement" | "elif_clause" | "for_statement" | "while_statement"
                | "except_clause" | "conditional_expression" | "case_clause"
                | "assert_statement" => 1,
                "boolean_operator" => 1, // `and`/`or` — um operador por nó
                _ => 0,
            },
        }
    }

    /// Estruturas que **incrementam** a cognitiva *e* aumentam o nível de aninhamento
    /// para os filhos (ex: if/for/while/match). +1 base +nível de aninhamento.
    fn cognitive_nesting(self, kind: &str) -> bool {
        match self {
            Self::Rust => matches!(
                kind,
                "if_expression"
                    | "while_expression"
                    | "loop_expression"
                    | "for_expression"
                    | "match_expression"
            ),
            Self::TypeScript | Self::Tsx => matches!(
                kind,
                "if_statement"
                    | "for_statement"
                    | "for_in_statement"
                    | "while_statement"
                    | "do_statement"
                    | "switch_statement"
                    | "catch_clause"
                    | "ternary_expression"
            ),
            Self::Python => matches!(
                kind,
                "if_statement"
                    | "for_statement"
                    | "while_statement"
                    | "except_clause"
                    | "match_statement"
                    | "conditional_expression"
            ),
        }
    }

    /// Quebras de fluxo que somam +1 cognitiva SEM penalidade de aninhamento
    /// (ex: `else`/`elif`, operadores booleanos).
    fn cognitive_flat(self, node: Node, src: &[u8]) -> u32 {
        let kind = node.kind();
        match self {
            Self::Rust => match kind {
                "else_clause" => 1,
                "binary_expression" => is_logical_op(node, src, &["&&", "||"]) as u32,
                _ => 0,
            },
            Self::TypeScript | Self::Tsx => match kind {
                "else_clause" => 1,
                "binary_expression" => is_logical_op(node, src, &["&&", "||", "??"]) as u32,
                _ => 0,
            },
            Self::Python => match kind {
                "elif_clause" => 1, // contado aqui (não duplica com if_statement)
                "boolean_operator" => 1,
                _ => 0,
            },
        }
    }
}

/// `binary_expression`/`boolean_operator` cujo operador está na lista? (conta `&&`/`||`/`??`).
fn is_logical_op(node: Node, src: &[u8], ops: &[&str]) -> bool {
    // O operador é um filho não-nomeado (anônimo) entre os dois operandos.
    let mut c = node.walk();
    for child in node.children(&mut c) {
        let txt = child.utf8_text(src).unwrap_or("");
        if ops.contains(&txt) {
            return true;
        }
    }
    false
}

/// Severidade ("green" | "yellow" | "red") pela ciclomática (thresholds da spec 9c).
pub fn severity_for(cyclomatic: u32) -> &'static str {
    match cyclomatic {
        0..=10 => "green",
        11..=20 => "yellow",
        _ => "red",
    }
}

/// Nível textual ("ok" | "warn" | "high") — paralelo à severity, p/ o badge do front.
pub fn level_for(cyclomatic: u32) -> &'static str {
    match cyclomatic {
        0..=10 => "ok",
        11..=20 => "warn",
        _ => "high",
    }
}

/// Maintainability Index (fórmula Microsoft, escala 0–100).
fn maintainability_index(halstead_volume: f64, cyclomatic: u32, loc: usize) -> f64 {
    let v = halstead_volume.max(1.0);
    let lloc = (loc.max(1)) as f64;
    let mi = (171.0 - 5.2 * v.ln() - 0.23 * (cyclomatic as f64) - 16.2 * lloc.ln()) * 100.0 / 171.0;
    mi.clamp(0.0, 100.0)
}

/// Acha o nome de uma função (`name`/`identifier`) ou rótulo razoável.
fn function_name(node: Node, src: &[u8], lang: MetricLang) -> String {
    if let Some(name) = node.child_by_field_name("name") {
        if let Ok(t) = name.utf8_text(src) {
            return t.to_string();
        }
    }
    // arrow_function/function_expression: tenta o identificador do pai (const x = () => …).
    if matches!(lang, MetricLang::TypeScript | MetricLang::Tsx) {
        if let Some(parent) = node.parent() {
            if parent.kind() == "variable_declarator" {
                if let Some(id) = parent.child_by_field_name("name") {
                    if let Ok(t) = id.utf8_text(src) {
                        return t.to_string();
                    }
                }
            }
            if parent.kind() == "pair" {
                if let Some(k) = parent.child_by_field_name("key") {
                    if let Ok(t) = k.utf8_text(src) {
                        return t.to_string();
                    }
                }
            }
        }
    }
    format!("<anon@{}>", node.start_position().row + 1)
}

/// Calcula ciclomática (1 + pontos) varrendo o corpo da função, SEM descer em
/// funções aninhadas (cada função tem sua própria métrica).
fn cyclomatic_of(func: Node, src: &[u8], lang: MetricLang) -> u32 {
    let mut cc = 1u32;
    let mut cursor = func.walk();
    let mut stack: Vec<Node> = func.children(&mut cursor).collect();
    while let Some(n) = stack.pop() {
        // não entra em sub-funções
        if n.id() != func.id() && lang.is_function_node(n.kind()) {
            continue;
        }
        cc += lang.cyclomatic_points(n, src);
        let mut c = n.walk();
        for child in n.children(&mut c) {
            stack.push(child);
        }
    }
    cc
}

/// Cognitiva (SonarSource simplificada): aninhamento penaliza. Recursivo com
/// nível corrente; estruturas de aninhamento somam (1 + nível) e elevam o nível
/// dos filhos. Quebras planas somam +1. Não desce em sub-funções.
fn cognitive_of(func: Node, src: &[u8], lang: MetricLang) -> u32 {
    fn walk(node: Node, src: &[u8], lang: MetricLang, nesting: u32) -> u32 {
        let mut total = 0u32;
        let mut cursor = node.walk();
        for child in node.children(&mut cursor) {
            // sub-função: ignora (métrica própria)
            if lang.is_function_node(child.kind()) {
                continue;
            }
            if lang.cognitive_nesting(child.kind()) {
                total += 1 + nesting; // +1 base + penalidade de aninhamento
                total += walk(child, src, lang, nesting + 1);
            } else {
                total += lang.cognitive_flat(child, src);
                total += walk(child, src, lang, nesting);
            }
        }
        total
    }
    walk(func, src, lang, 0)
}

/// LOC físico do span da função (end_row - start_row + 1).
fn loc_of(node: Node) -> usize {
    node.end_position()
        .row
        .saturating_sub(node.start_position().row)
        + 1
}

/// Aproximação de Halstead Volume só p/ alimentar o MI: V = N * log2(n), onde
/// n = vocabulário (kinds de folha distintos) e N = total de tokens-folha. Não é
/// a métrica Halstead completa (fora de escopo 9c), mas é estável e suficiente
/// pro MI não ficar zerado.
fn halstead_volume_of(node: Node) -> f64 {
    use std::collections::HashSet;
    let mut vocab: HashSet<&str> = HashSet::new();
    let mut total = 0usize;
    let mut stack: Vec<Node> = vec![node];
    while let Some(n) = stack.pop() {
        if n.child_count() == 0 {
            total += 1;
            vocab.insert(n.kind());
        }
        let mut cursor = n.walk();
        for child in n.children(&mut cursor) {
            stack.push(child);
        }
    }
    let n = vocab.len().max(1) as f64;
    let big_n = total.max(1) as f64;
    big_n * n.log2().max(1.0)
}

/// Varre a AST coletando todas as funções (top-level e aninhadas — cada uma
/// vira uma entrada própria) e calcula as métricas de cada.
fn collect_functions(root: Node, src: &[u8], lang: MetricLang) -> Vec<FunctionMetrics> {
    let mut out = Vec::new();
    let mut cursor = root.walk();
    let mut stack: Vec<Node> = root.children(&mut cursor).collect();
    while let Some(n) = stack.pop() {
        if lang.is_function_node(n.kind()) {
            let cyclomatic = cyclomatic_of(n, src, lang);
            let cognitive = cognitive_of(n, src, lang);
            let loc = loc_of(n);
            let hv = halstead_volume_of(n);
            let mi = maintainability_index(hv, cyclomatic, loc);
            out.push(FunctionMetrics {
                name: function_name(n, src, lang),
                start_line: n.start_position().row + 1,
                end_line: n.end_position().row + 1,
                cyclomatic,
                cognitive,
                halstead_volume: hv,
                halstead_difficulty: 0.0, // métrica Halstead completa: fora do escopo 9c
                maintainability_index: mi,
                severity: severity_for(cyclomatic).to_string(),
            });
        }
        let mut c = n.walk();
        for child in n.children(&mut c) {
            stack.push(child);
        }
    }
    out.sort_by_key(|f| f.start_line);
    out
}

/// Erro-suave: linguagem sem grammar.
#[derive(Debug)]
pub enum MetricsError {
    UnsupportedLanguage,
    Parse(String),
}

impl std::fmt::Display for MetricsError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::UnsupportedLanguage => write!(f, "linguagem sem grammar para métricas"),
            Self::Parse(e) => write!(f, "falha ao parsear: {e}"),
        }
    }
}

impl std::error::Error for MetricsError {}

/// Calcula as métricas de um arquivo já lido (conteúdo em memória).
/// `path` é só pra detectar a linguagem e carimbar o resultado.
pub fn compute(path: &Path, source: &str) -> Result<CodeMetrics, MetricsError> {
    let lang = MetricLang::from_path(path).ok_or(MetricsError::UnsupportedLanguage)?;

    let mut parser = Parser::new();
    parser
        .set_language(&lang.ts_language())
        .map_err(|e| MetricsError::Parse(e.to_string()))?;
    let tree = parser
        .parse(source, None)
        .ok_or_else(|| MetricsError::Parse("parser retornou None".into()))?;

    let src = source.as_bytes();
    let functions = collect_functions(tree.root_node(), src, lang);

    let loc = source.lines().count();
    let n = functions.len().max(1) as f64;
    let avg_cyclomatic = functions.iter().map(|f| f.cyclomatic as f64).sum::<f64>() / n;
    let max_cyclomatic = functions.iter().map(|f| f.cyclomatic).max().unwrap_or(0);
    let avg_cognitive = functions.iter().map(|f| f.cognitive as f64).sum::<f64>() / n;
    let max_cognitive = functions.iter().map(|f| f.cognitive).max().unwrap_or(0);
    // MI do arquivo = pior (mínimo) entre as funções; sem funções → 100.
    let mi_min = functions
        .iter()
        .map(|f| f.maintainability_index)
        .fold(f64::INFINITY, f64::min);
    let maintainability_index = if mi_min.is_finite() { mi_min } else { 100.0 };

    Ok(CodeMetrics {
        path: path.to_string_lossy().to_string(),
        language: lang.name().to_string(),
        loc,
        functions,
        avg_cyclomatic,
        max_cyclomatic,
        avg_cognitive,
        max_cognitive,
        maintainability_index,
        computed_at: crate::code::now_iso8601(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn metrics(name: &str, src: &str) -> CodeMetrics {
        compute(&PathBuf::from(name), src).unwrap()
    }

    #[test]
    fn rust_known_cyclomatic() {
        // `if a && b { for c { } }` → CC = 1(base) + if + && + for = 4
        let src = "fn x(a: bool, b: bool) {\n    if a && b {\n        for c in 0..3 {\n        }\n    }\n}\n";
        let m = metrics("x.rs", src);
        assert_eq!(m.language, "rust");
        assert_eq!(m.functions.len(), 1, "deveria achar 1 função");
        let f = &m.functions[0];
        assert_eq!(f.name, "x");
        assert_eq!(f.cyclomatic, 4, "if + && + for + base");
        assert_eq!(m.max_cyclomatic, 4);
        assert_eq!(f.severity, "green");
    }

    #[test]
    fn rust_match_arms_count() {
        // 3 match arms → CC = 1 + 3 = 4
        let src = "fn k(n: i32) -> i32 {\n    match n {\n        0 => 1,\n        1 => 2,\n        _ => 3,\n    }\n}\n";
        let m = metrics("k.rs", src);
        let f = &m.functions[0];
        assert_eq!(f.cyclomatic, 4, "3 arms + base");
    }

    #[test]
    fn rust_simple_fn_is_one() {
        let src = "fn simple() -> i32 {\n    let a = 1;\n    a + 2\n}\n";
        let m = metrics("s.rs", src);
        assert_eq!(m.functions[0].cyclomatic, 1, "função reta = 1");
        assert_eq!(m.functions[0].cognitive, 0, "sem ramos = cognitiva 0");
    }

    #[test]
    fn typescript_if_for_logical() {
        // if + (&& ||) + for + ternary → 1 + 1 + 2 + 1 + 1 = 6
        let src = "function f(a: boolean, b: boolean, c: boolean) {\n  if (a && b || c) {\n    for (let i = 0; i < 3; i++) {\n      const x = a ? 1 : 2;\n    }\n  }\n}\n";
        let m = metrics("f.ts", src);
        assert_eq!(m.language, "typescript");
        let f = m.functions.iter().find(|f| f.name == "f").unwrap();
        assert_eq!(f.cyclomatic, 6, "if + && + || + for + ternary + base");
    }

    #[test]
    fn javascript_via_tsx_grammar() {
        // .js usa a grammar TSX: if + while → CC 3
        let src = "function g(a, b) {\n  if (a) {\n    while (b) {\n    }\n  }\n}\n";
        let m = metrics("g.js", src);
        assert_eq!(m.language, "typescript");
        assert_eq!(m.functions[0].cyclomatic, 3, "if + while + base");
    }

    #[test]
    fn python_if_elif_and() {
        // if + elif + and → 1 + 1 + 1 + 1(base) = 4
        let src = "def h(a, b, c):\n    if a and b:\n        return 1\n    elif c:\n        return 2\n    return 0\n";
        let m = metrics("h.py", src);
        assert_eq!(m.language, "python");
        let f = &m.functions[0];
        assert_eq!(f.cyclomatic, 4, "if + elif + and + base");
    }

    #[test]
    fn cognitive_penalizes_nesting() {
        // aninhamento: if { for { if { } } }
        //   if      → +1 (nesting 0)
        //   for     → +2 (nesting 1)
        //   if      → +3 (nesting 2)
        //   = 6
        let src = "fn deep(a: bool) {\n    if a {\n        for _ in 0..3 {\n            if a {\n            }\n        }\n    }\n}\n";
        let m = metrics("deep.rs", src);
        let f = &m.functions[0];
        assert_eq!(f.cognitive, 6, "1 + 2 + 3 por aninhamento");
    }

    #[test]
    fn high_cyclomatic_is_red() {
        // 21 ifs → CC 22 → red
        let mut body = String::from("fn big(a: bool) {\n");
        for _ in 0..21 {
            body.push_str("    if a {}\n");
        }
        body.push_str("}\n");
        let m = metrics("big.rs", &body);
        let f = &m.functions[0];
        assert!(f.cyclomatic >= 21, "muitos ramos");
        assert_eq!(f.severity, "red", ">20 = red");
        assert_eq!(level_for(f.cyclomatic), "high");
    }

    #[test]
    fn unsupported_language_errs() {
        let r = compute(&PathBuf::from("x.cobol"), "fake");
        assert!(matches!(r, Err(MetricsError::UnsupportedLanguage)));
    }

    #[test]
    fn maintainability_index_in_range() {
        let src = "fn x() -> i32 { 1 }\n";
        let m = metrics("x.rs", src);
        assert!(m.maintainability_index >= 0.0 && m.maintainability_index <= 100.0);
    }
}
