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
}
