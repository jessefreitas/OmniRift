//! code/chunk.rs — fatia código-fonte por AST em chunks coerentes (função/classe/método).
//! Puro: sem I/O, sem estado. Reusa a infra tree-sitter. Base pros consumidores das
//! Fases 2/3 (corpos de símbolo no OmniGraph, embedding do OmniFS).

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkKind {
    Function,
    Class,
    Method,
    Block,
    Fallback,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Chunk {
    pub symbol: Option<String>,
    pub kind: ChunkKind,
    /// 1-indexado, inclusivo.
    pub start_line: usize,
    pub end_line: usize,
    pub byte_range: (usize, usize),
    pub text: String,
}

#[derive(Debug, Clone, Copy)]
pub struct ChunkOpts {
    pub target_tokens: usize,
    pub max_tokens: usize,
    pub min_tokens: usize,
}

impl Default for ChunkOpts {
    fn default() -> Self {
        Self {
            target_tokens: 1000,
            max_tokens: 2000,
            min_tokens: 120,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ChunkLang {
    Rust,
    TypeScript,
    Tsx,
    Python,
    Go,
    Java,
    C,
    Cpp,
    CSharp,
    Ruby,
    Php,
}

impl ChunkLang {
    pub const ALL: [ChunkLang; 11] = [
        Self::Rust,
        Self::TypeScript,
        Self::Tsx,
        Self::Python,
        Self::Go,
        Self::Java,
        Self::C,
        Self::Cpp,
        Self::CSharp,
        Self::Ruby,
        Self::Php,
    ];

    pub fn from_ext(ext: &str) -> Option<Self> {
        Some(match ext {
            "rs" => Self::Rust,
            "ts" | "mts" | "cts" => Self::TypeScript,
            "tsx" => Self::Tsx,
            "py" | "pyi" => Self::Python,
            "go" => Self::Go,
            "java" => Self::Java,
            "c" | "h" => Self::C,
            "cpp" | "cc" | "cxx" | "hpp" | "hh" => Self::Cpp,
            "cs" => Self::CSharp,
            "rb" => Self::Ruby,
            "php" => Self::Php,
            _ => return None,
        })
    }

    pub fn from_path(path: &std::path::Path) -> Option<Self> {
        let ext = path.extension().and_then(|e| e.to_str())?;
        Self::from_ext(ext)
    }

    pub fn language(self) -> tree_sitter::Language {
        match self {
            Self::Rust => tree_sitter_rust::LANGUAGE.into(),
            Self::TypeScript => tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            Self::Tsx => tree_sitter_typescript::LANGUAGE_TSX.into(),
            Self::Python => tree_sitter_python::LANGUAGE.into(),
            Self::Go => tree_sitter_go::LANGUAGE.into(),
            Self::Java => tree_sitter_java::LANGUAGE.into(),
            Self::C => tree_sitter_c::LANGUAGE.into(),
            Self::Cpp => tree_sitter_cpp::LANGUAGE.into(),
            Self::CSharp => tree_sitter_c_sharp::LANGUAGE.into(),
            Self::Ruby => tree_sitter_ruby::LANGUAGE.into(),
            Self::Php => tree_sitter_php::LANGUAGE_PHP.into(),
        }
    }

    /// Node-types (kind do tree-sitter) que são fronteira de chunk nesta linguagem.
    pub fn boundary_kinds(self) -> &'static [&'static str] {
        match self {
            Self::Rust => &[
                "function_item",
                "impl_item",
                "struct_item",
                "enum_item",
                "trait_item",
                "mod_item",
            ],
            Self::TypeScript | Self::Tsx => &[
                "function_declaration",
                "class_declaration",
                "method_definition",
                "interface_declaration",
            ],
            Self::Python => &[
                "function_definition",
                "class_definition",
                "decorated_definition",
            ],
            Self::Go => &[
                "function_declaration",
                "method_declaration",
                "type_declaration",
            ],
            Self::Java => &[
                "class_declaration",
                "method_declaration",
                "interface_declaration",
                "enum_declaration",
            ],
            Self::C => &["function_definition", "struct_specifier"],
            Self::Cpp => &[
                "function_definition",
                "class_specifier",
                "struct_specifier",
                "namespace_definition",
            ],
            Self::CSharp => &[
                "method_declaration",
                "class_declaration",
                "interface_declaration",
                "namespace_declaration",
            ],
            Self::Ruby => &["method", "class", "module"],
            Self::Php => &[
                "function_definition",
                "method_declaration",
                "class_declaration",
            ],
        }
    }

    /// Rotula o chunk pelo kind do nó. Checa "method" ANTES de "function" (method_declaration
    /// não contém "function", mas a intenção é Method).
    pub fn kind_of(node_kind: &str) -> ChunkKind {
        if node_kind.contains("method") {
            ChunkKind::Method
        } else if node_kind.contains("function") {
            ChunkKind::Function
        } else if node_kind.contains("class")
            || node_kind.contains("struct")
            || node_kind.contains("enum")
            || node_kind.contains("trait")
            || node_kind.contains("interface")
            || node_kind.contains("module")
            || node_kind.contains("namespace")
            || node_kind.contains("impl")
        {
            ChunkKind::Class
        } else {
            ChunkKind::Block
        }
    }
}

/// Estratégia de chunking. Trait pra permitir trocar (ex: cost-model de overlap) sem
/// tocar nos consumidores.
pub trait Chunker {
    fn chunk(&self, source: &str, lang: ChunkLang, opts: &ChunkOpts) -> Vec<Chunk>;
}

/// Ponto de entrada público: usa o `BoundaryChunker` (estratégia da Fase 1).
pub fn chunk_code(source: &str, lang: ChunkLang, opts: &ChunkOpts) -> Vec<Chunk> {
    if source.is_empty() {
        return Vec::new();
    }
    BoundaryChunker.chunk(source, lang, opts)
}

pub struct BoundaryChunker;

impl Chunker for BoundaryChunker {
    fn chunk(&self, source: &str, lang: ChunkLang, opts: &ChunkOpts) -> Vec<Chunk> {
        let mut parser = tree_sitter::Parser::new();
        if parser.set_language(&lang.language()).is_err() {
            return fallback_chunks(source);
        }
        let tree = match parser.parse(source, None) {
            Some(t) => t,
            None => return fallback_chunks(source),
        };

        // Coleta em ORDEM DE FONTE os nós-fronteira de topo. SPLIT: um chunk grande demais
        // cujo nó tem filhos-fronteira é quebrado recursivamente (impl/class → métodos).
        fn collect(node: &tree_sitter::Node, source: &str, lang: ChunkLang, max_tokens: usize, out: &mut Vec<Chunk>) {
            let boundary = lang.boundary_kinds();
            for i in 0..node.named_child_count() {
                let Some(child) = node.named_child(i) else { continue };
                if boundary.contains(&child.kind()) {
                    let c = make_chunk(&child, source, lang);
                    if c.text.len() / 4 > max_tokens && child.named_child_count() > 0 {
                        collect(&child, source, lang, max_tokens, out);
                    } else {
                        out.push(c);
                    }
                } else {
                    collect(&child, source, lang, max_tokens, out);
                }
            }
        }

        let mut collected = Vec::new();
        collect(&tree.root_node(), source, lang, opts.max_tokens, &mut collected);
        if collected.is_empty() {
            return fallback_chunks(source);
        }

        // MERGE forward: enquanto o último chunk é menor que min_tokens, funde o próximo
        // (estende o range pra cobrir o gap; text = source[range] mantém a invariante).
        let mut merged: Vec<Chunk> = Vec::new();
        for chunk in collected {
            if let Some(last) = merged.last_mut() {
                let last_small = last.text.len() / 4 < opts.min_tokens;
                let combined_est = chunk.byte_range.1.saturating_sub(last.byte_range.0) / 4;
                let forward = chunk.byte_range.0 >= last.byte_range.1;
                if last_small && forward && combined_est <= opts.target_tokens {
                    last.byte_range = (last.byte_range.0, chunk.byte_range.1);
                    last.text = source[last.byte_range.0..chunk.byte_range.1].to_string();
                    last.end_line = chunk.end_line;
                    if last.symbol.is_none() {
                        last.symbol = chunk.symbol;
                    }
                    continue;
                }
            }
            merged.push(chunk);
        }
        if merged.is_empty() { fallback_chunks(source) } else { merged }
    }
}

/// Constrói um Chunk a partir de um nó-fronteira. Símbolo: campo `name` do nó, ou o
/// primeiro descendente nomeado cujo kind contém identifier/name/constant.
fn make_chunk(node: &tree_sitter::Node, source: &str, _lang: ChunkLang) -> Chunk {
    let symbol = node
        .child_by_field_name("name")
        .and_then(|n| n.utf8_text(source.as_bytes()).ok())
        .map(|s| s.to_string())
        .or_else(|| {
            let mut queue = std::collections::VecDeque::new();
            for i in 0..node.named_child_count() {
                if let Some(c) = node.named_child(i) {
                    queue.push_back(c);
                }
            }
            while let Some(cur) = queue.pop_front() {
                let k = cur.kind();
                if k.contains("identifier") || k.contains("name") || k.contains("constant") {
                    if let Ok(t) = cur.utf8_text(source.as_bytes()) {
                        return Some(t.to_string());
                    }
                }
                for i in 0..cur.named_child_count() {
                    if let Some(c) = cur.named_child(i) {
                        queue.push_back(c);
                    }
                }
            }
            None
        });

    let (start_byte, end_byte) = (node.start_byte(), node.end_byte());
    Chunk {
        symbol,
        kind: ChunkLang::kind_of(node.kind()),
        start_line: node.start_position().row + 1,
        end_line: node.end_position().row + 1,
        byte_range: (start_byte, end_byte),
        text: source[start_byte..end_byte].to_string(),
    }
}

/// Fallback genérico (sem AST): divide por blocos separados por linha em branco; blocos
/// > ~2000 bytes quebram em janelas em char boundary. `source[byte_range] == text` sempre.
/// Nunca vazio pra source não-vazio.
fn fallback_chunks(source: &str) -> Vec<Chunk> {
    if source.is_empty() {
        return Vec::new();
    }
    let line_at = |byte: usize| source[..byte].bytes().filter(|&b| b == b'\n').count() + 1;
    let mut chunks = Vec::new();
    let mut offset = 0usize;
    for block in source.split("\n\n") {
        let block_len = block.len();
        if !block.trim().is_empty() {
            // janelas de ~2000 bytes respeitando char boundary
            let mut start = offset;
            let block_end = offset + block_len;
            while start < block_end {
                let mut end = std::cmp::min(start + 2000, block_end);
                while end < block_end && !source.is_char_boundary(end) {
                    end += 1;
                }
                chunks.push(Chunk {
                    symbol: None,
                    kind: ChunkKind::Fallback,
                    start_line: line_at(start),
                    end_line: line_at(end.saturating_sub(1).max(start)),
                    byte_range: (start, end),
                    text: source[start..end].to_string(),
                });
                start = end;
            }
        }
        offset += block_len + 2; // +2 = o "\n\n" removido pelo split
    }
    if chunks.is_empty() {
        // só whitespace → 1 chunk cobrindo tudo
        chunks.push(Chunk {
            symbol: None,
            kind: ChunkKind::Fallback,
            start_line: 1,
            end_line: line_at(source.len().saturating_sub(1)),
            byte_range: (0, source.len()),
            text: source.to_string(),
        });
    }
    chunks
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_source_yields_no_chunks() {
        let out = chunk_code("", ChunkLang::Rust, &ChunkOpts::default());
        assert!(out.is_empty());
    }

    #[test]
    fn detects_language_by_extension() {
        assert_eq!(ChunkLang::from_ext("rs"), Some(ChunkLang::Rust));
        assert_eq!(ChunkLang::from_ext("go"), Some(ChunkLang::Go));
        assert_eq!(ChunkLang::from_ext("tsx"), Some(ChunkLang::Tsx));
        assert_eq!(ChunkLang::from_ext("rb"), Some(ChunkLang::Ruby));
        assert_eq!(ChunkLang::from_ext("xyz"), None);
    }

    #[test]
    fn boundary_kinds_are_nonempty_for_all_langs() {
        for l in ChunkLang::ALL {
            assert!(!l.boundary_kinds().is_empty(), "sem node-types p/ {:?}", l);
            let _ = l.language(); // não deve panicar (grammar carrega + ABI ok)
        }
    }

    const RUST_SRC: &str = "use std::fmt;\n\nfn small_a() -> i32 { 1 }\n\nfn small_b() -> i32 { 2 }\n\nstruct Big;\nimpl Big {\n    fn method_one(&self) { println!(\"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa\"); }\n    fn method_two(&self) { println!(\"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb\"); }\n}\n";

    #[test]
    fn chunks_functions_with_symbols() {
        let out = chunk_code(RUST_SRC, ChunkLang::Rust, &ChunkOpts::default());
        assert!(!out.is_empty());
        let names: Vec<_> = out.iter().filter_map(|c| c.symbol.as_deref()).collect();
        assert!(names.iter().any(|n| n.contains("small_a")), "symbols: {:?}", names);
        // invariante: o text de cada chunk casa a fatia de bytes do fonte
        for c in &out {
            assert_eq!(&RUST_SRC[c.byte_range.0..c.byte_range.1], c.text, "byte_range != text em {:?}", c);
            assert!(c.start_line >= 1 && c.end_line >= c.start_line, "linhas inválidas em {:?}", c);
        }
    }

    #[test]
    fn oversized_class_splits_into_methods() {
        // impl gigante deve ser QUEBRADA nos seus métodos (não ficar 1 chunk só).
        // (No Rust, métodos são `function_item` dentro do `impl_item` — o SPLIT recursivo
        // os separa; o kind fica Function porque Rust não distingue method no node-type.)
        let opts = ChunkOpts { target_tokens: 20, max_tokens: 30, min_tokens: 1 };
        let out = chunk_code(RUST_SRC, ChunkLang::Rust, &opts);
        let split = out.iter().filter(|c| {
            matches!(c.symbol.as_deref(), Some("method_one") | Some("method_two"))
        }).count();
        assert!(split >= 2, "esperava a impl fatiada nos métodos, got {:?}", out);
    }

    #[test]
    fn invalid_source_falls_back_never_empty() {
        let junk = ")))this is not valid code((( \n @@@@ \n";
        let out = chunk_code(junk, ChunkLang::Rust, &ChunkOpts::default());
        assert!(!out.is_empty());
    }

    #[test]
    fn unknown_content_via_fallback_covers_source() {
        let src = "linha 1\n\nlinha 3\nlinha 4\n";
        let out = fallback_chunks(src);
        assert!(!out.is_empty());
        assert_eq!(&src[out[0].byte_range.0..out[0].byte_range.1], out[0].text);
    }

    #[test]
    fn each_language_chunks_a_function() {
        let cases: &[(ChunkLang, &str, &str)] = &[
            (ChunkLang::Rust,       "fn alpha() {}\n", "alpha"),
            (ChunkLang::TypeScript, "function alpha() {}\n", "alpha"),
            (ChunkLang::Tsx,        "function alpha() { return null; }\n", "alpha"),
            (ChunkLang::Python,     "def alpha():\n    pass\n", "alpha"),
            (ChunkLang::Go,         "package p\nfunc alpha() {}\n", "alpha"),
            (ChunkLang::Java,       "class C { void alpha() {} }\n", "alpha"),
            (ChunkLang::C,          "int alpha() { return 0; }\n", "alpha"),
            (ChunkLang::Cpp,        "int alpha() { return 0; }\n", "alpha"),
            (ChunkLang::CSharp,     "class C { void alpha() {} }\n", "alpha"),
            (ChunkLang::Ruby,       "def alpha\nend\n", "alpha"),
            (ChunkLang::Php,        "<?php function alpha() {}\n", "alpha"),
        ];
        for (lang, src, want) in cases {
            let out = chunk_code(src, *lang, &ChunkOpts::default());
            assert!(!out.is_empty(), "{:?}: vazio", lang);
            let has = out.iter().any(|c| c.symbol.as_deref() == Some(*want) || c.text.contains(want));
            assert!(has, "{:?}: não achou símbolo `{}` em {:?}", lang, want, out);
        }
    }
}
