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
    fn chunk(&self, _source: &str, _lang: ChunkLang, _opts: &ChunkOpts) -> Vec<Chunk> {
        Vec::new() // preenchido na Task 3
    }
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
}
