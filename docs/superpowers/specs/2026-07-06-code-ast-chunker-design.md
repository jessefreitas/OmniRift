# Chunker AST de código — design

> 2026-07-06. Fatiar código-fonte por AST (função/classe/método) em pedaços coerentes,
> como base reusável pra três consumidores: tool MCP pros agentes (Fase 1), corpos de
> símbolo no OmniGraph (Fase 2) e embedding do OmniFS (Fase 3). Esta spec cobre a **Fase 1**.

## Motivação

Hoje um agente que precisa entender um arquivo lê o arquivo **cru inteiro** — desperdiça
contexto e mistura funções não relacionadas. O `code/metrics.rs` já parseia Rust/TS/Python
via tree-sitter (pra complexidade), mas não expõe os **pedaços** do código. Um chunker AST
fatia o arquivo em unidades semânticas (uma função, uma classe, um método), cada uma com
suas linhas e nome do símbolo — o insumo natural pra busca semântica, embedding e pra dar
ao agente só a fatia relevante.

O chunker é uma **base reusável**: a Fase 1 entrega o módulo puro + um consumidor (tool MCP);
as Fases 2 e 3 plugam na mesma função sem retrabalho.

## Arquitetura

### Módulo `code/chunk.rs` (função pura, sem I/O)

```rust
pub fn chunk_code(source: &str, lang: Lang, opts: &ChunkOpts) -> Vec<Chunk>;

pub struct Chunk {
    pub symbol: Option<String>,   // nome da fn/classe/método (None em fallback/bloco)
    pub kind: ChunkKind,          // Function | Class | Method | Block | Fallback
    pub start_line: usize,        // 1-indexado, inclusivo
    pub end_line: usize,
    pub byte_range: (usize, usize),
    pub text: String,             // o código do chunk
}

pub struct ChunkOpts {
    pub target_tokens: usize,     // tamanho-alvo (aprox. bytes/4); default ~1000
    pub max_tokens: usize,        // teto rígido antes de quebrar recursivo
    pub min_tokens: usize,        // abaixo disso, funde com vizinho
}
```

Sem estado, sem filesystem, sem rede — testável isolada. Vive ao lado de `code/metrics.rs`,
reusando a infra tree-sitter já presente.

### Cobertura de linguagens

Estende o enum `Lang` (compartilhado com metrics) para 10 linguagens. Cada uma mapeia numa
**tabela de node-types** — quais kinds do AST tree-sitter são fronteira de chunk:

| Lang | Grammar | Node-types de fronteira (exemplos) |
|------|---------|-------------------------------------|
| Rust | `tree-sitter-rust` ✅ | `function_item`, `impl_item`, `struct_item`, `enum_item`, `trait_item`, `mod_item` |
| TypeScript/TSX | `tree-sitter-typescript` ✅ | `function_declaration`, `class_declaration`, `method_definition`, `arrow_function` (top) |
| Python | `tree-sitter-python` ✅ | `function_definition`, `class_definition`, `decorated_definition` |
| Go | `tree-sitter-go` ➕ | `function_declaration`, `method_declaration`, `type_declaration` |
| Java | `tree-sitter-java` ➕ | `class_declaration`, `method_declaration`, `interface_declaration` |
| C | `tree-sitter-c` ➕ | `function_definition`, `struct_specifier` |
| C++ | `tree-sitter-cpp` ➕ | `function_definition`, `class_specifier`, `namespace_definition` |
| C# | `tree-sitter-c-sharp` ➕ | `method_declaration`, `class_declaration`, `namespace_declaration` |
| Ruby | `tree-sitter-ruby` ➕ | `method`, `class`, `module` |
| PHP | `tree-sitter-php` ➕ | `function_definition`, `method_declaration`, `class_declaration` |

✅ = grammar já no `Cargo.toml`; ➕ = grammar novo a adicionar. A tabela é **dado**, não
código: adicionar uma linguagem depois = uma entrada nova. A detecção de linguagem é por
extensão do arquivo (reusa o mapeamento de `code/metrics.rs`, estendido).

### Algoritmo — fronteira + merge (atrás do trait `Chunker`)

```
trait Chunker { fn chunk(&self, source, lang, opts) -> Vec<Chunk>; }
```

A implementação da Fase 1 (`BoundaryChunker`):

1. Parseia com tree-sitter → percorre os nós-fronteira de **primeiro nível** (os do topo do
   arquivo cujo kind está na tabela da linguagem).
2. Cada nó-fronteira vira um chunk candidato (com símbolo, linhas, texto).
3. **Merge**: chunks adjacentes menores que `min_tokens` fundem com o vizinho até chegar
   perto de `target_tokens` (junta imports soltos + funções pequenas).
4. **Split**: um chunk maior que `max_tokens` é quebrado recursivamente pelos seus filhos-
   fronteira (ex: uma classe gigante → um chunk por método).
5. Código fora de qualquer nó-fronteira (top-level statements, imports) agrupa em chunks
   `Block` por proximidade.

O trait isola a estratégia: uma implementação futura com **cost-model de overlap** (pontos
de corte quase-ótimos, sobreposição calculada) pode substituir o `BoundaryChunker` sem
tocar nos consumidores. Fica fora do escopo da Fase 1 (YAGNI — só vale quando o embedding
do OmniFS, Fase 3, existir pra se beneficiar).

### Consumidor da Fase 1 — tool MCP `code_chunks`

Uma tool nova exposta aos agentes:

```
code_chunks(path: string, target_tokens?: number) -> Chunk[]
```

O agente pede um arquivo e recebe a lista de chunks (símbolo + linhas + texto) em vez de
ler o arquivo cru inteiro. Lê o arquivo do disco, detecta a linguagem pela extensão, chama
`chunk_code`, retorna JSON. Registra no servidor MCP do OmniRift junto das demais tools.

## Fluxo de dados (Fase 1)

```
agente → code_chunks(path) → lê arquivo → detecta Lang por extensão
      → chunk_code(source, lang, opts) → Vec<Chunk> → JSON → agente
```

## Tratamento de erro — nunca falha, nunca vazio

| Situação | Comportamento |
|----------|---------------|
| Parse tree-sitter falha (erro de sintaxe) | fallback: split genérico por linhas em branco/tamanho, chunks `Fallback` |
| Linguagem não suportada (extensão desconhecida) | mesmo fallback genérico |
| Arquivo vazio | retorna `[]` (vazio explícito, sem panic) |
| Arquivo gigante (> teto configurável) | trunca no teto + 1 chunk `Fallback` sinalizando o corte |

Invariante: `chunk_code` **nunca paniqueia** e sempre retorna chunks cobrindo o conteúdo
(exceto arquivo vazio). O fallback garante que qualquer arquivo é chunkável.

## Testes (execução real — `cargo test`)

- **Por linguagem** (10): fixture com 2-3 funções/classes → asserta contagem de chunks,
  símbolos extraídos e linhas de fronteira.
- **Merge**: arquivo com muitas funções pequenas → funde até perto de `target_tokens`.
- **Split**: uma classe/função maior que `max_tokens` → quebra em sub-chunks pelos filhos.
- **Fallback**: código com sintaxe inválida + extensão desconhecida → chunks `Fallback`,
  sem panic, cobrindo o conteúdo.
- **Vazio**: string vazia → `[]`.
- **Invariante**: para todo chunk, `text == source[byte_range]` e linhas conferem.

## Fora de escopo da Fase 1 (plugam depois na mesma base)

- **Cost-model de overlap** (chunker quase-ótimo) — troca de `BoundaryChunker` via o trait.
- **Fase 2 — OmniGraph**: anexar o `text` do chunk a cada símbolo do grafo (corpo, não só estrutura).
- **Fase 3 — OmniFS**: gerar embedding por chunk no daemon (repo separado) → busca semântica
  aponta pra função exata, não pro arquivo inteiro.
- Embedding, vetor store, watcher incremental.
