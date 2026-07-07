# Chunker AST de código — Plano de Implementação (Fase 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.
>
> **Metodologia deste repo (CLAUDE.md global):** o código de cada task é GERADO via
> dispatch Ollama (`multi_agent_dispatch.py --type code`), o orquestrador AUDITA a saída
> (segurança/correção/spec/estilo) e só então APLICA via Edit/Write. Validação por
> `cargo test` real, nunca revisão visual. Edições cirúrgicas (<30 linhas) podem ser diretas.

**Goal:** Fatiar código-fonte por AST (função/classe/método) num módulo puro `code/chunk.rs`, exposto aos agentes via tool MCP `code_chunks`, cobrindo 10 linguagens com fallback genérico.

**Architecture:** Módulo puro sem I/O (`chunk_code(source, lang, opts) -> Vec<Chunk>`) atrás do trait `Chunker`, reusando a infra tree-sitter já em `code/metrics.rs`. Uma tabela de node-types por linguagem define as fronteiras de chunk. Consumidor da Fase 1 = tool MCP que lê o arquivo, detecta a linguagem por extensão e retorna os chunks em JSON. Fases 2/3 (OmniGraph, OmniFS) plugam na mesma função depois.

**Tech Stack:** Rust, tree-sitter 0.25 (+7 grammars novos), serde, o servidor MCP interno do OmniRift.

**Spec:** `docs/superpowers/specs/2026-07-06-code-ast-chunker-design.md`

---

## Estrutura de arquivos

- **Criar** `apps/desktop/src-tauri/src/code/chunk.rs` — módulo puro do chunker (tipos, tabela de node-types, `BoundaryChunker`, `chunk_code`, fallback, testes).
- **Modificar** `apps/desktop/src-tauri/src/code/mod.rs` — declarar `pub mod chunk;`.
- **Modificar** `apps/desktop/src-tauri/Cargo.toml` — adicionar os 7 grammars tree-sitter.
- **Modificar** `apps/desktop/src-tauri/src/mcp/tools.rs` — declarar a tool `code_chunks` (na lista json! de tools) + o handler no dispatch `match tool`.

`ChunkLang` (o enum de linguagem do chunker) vive em `chunk.rs`, próprio — NÃO reusa
`MetricLang` de metrics.rs, porque o chunker cobre 10 langs e metrics só 4; espelha o
padrão de `MetricLang::from_path`/`language()` mas com a tabela ampliada.

---

### Task 1: Tipos + esqueleto do chunker (compila, vazio)

**Files:**
- Create: `apps/desktop/src-tauri/src/code/chunk.rs`
- Modify: `apps/desktop/src-tauri/src/code/mod.rs`

- [ ] **Step 1: Escrever o teste que falha (chunk_code de string vazia → [])**

Teste: `empty_source_yields_no_chunks` — `chunk_code("", ChunkLang::Rust, &ChunkOpts::default())` deve retornar vazio.

- [ ] **Step 2: Rodar o teste — deve falhar por não compilar (símbolos indefinidos)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests::empty_source -q`
Expected: FAIL — `cannot find function chunk_code` / `ChunkLang` / `ChunkOpts`.

- [ ] **Step 3: Implementar os tipos + stub de `chunk_code`**

Dispatch Ollama (`--type code`), auditar, aplicar. Contrato dos tipos em `code/chunk.rs`:
- `enum ChunkKind { Function, Class, Method, Block, Fallback }` (derive Debug, Clone, Copy, PartialEq, Eq).
- `struct Chunk { symbol: Option<String>, kind: ChunkKind, start_line: usize (1-idx inclusivo), end_line: usize, byte_range: (usize,usize), text: String }` (derive Debug, Clone, PartialEq, Eq).
- `struct ChunkOpts { target_tokens, max_tokens, min_tokens: usize }` com `Default` = `{1000, 2000, 120}`.
- `enum ChunkLang { Rust, TypeScript, Tsx, Python, Go, Java, C, Cpp, CSharp, Ruby, Php }`.
- `trait Chunker { fn chunk(&self, source: &str, lang: ChunkLang, opts: &ChunkOpts) -> Vec<Chunk>; }`.
- `pub fn chunk_code(source, lang, opts) -> Vec<Chunk>`: se `source.is_empty()` → `Vec::new()`; senão delega a `BoundaryChunker`.
- `struct BoundaryChunker;` impl `Chunker` retornando `Vec::new()` por ora (preenchido na Task 3).
- Em `code/mod.rs`: adicionar `pub mod chunk;`.

- [ ] **Step 4: Rodar o teste — deve passar**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests::empty_source -q`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add apps/desktop/src-tauri/src/code/chunk.rs apps/desktop/src-tauri/src/code/mod.rs && git commit -m "feat(chunk): tipos + esqueleto do chunker AST (vazio, compila)"`

---

### Task 2: Grammars + tabela de node-types + detecção por extensão

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Modify: `apps/desktop/src-tauri/src/code/chunk.rs`

- [ ] **Step 1: Escrever os testes que falham**

- `detects_language_by_extension`: `from_ext("rs")==Some(Rust)`, `"go"==Go`, `"tsx"==Tsx`, `"rb"==Ruby`, `"xyz"==None`.
- `boundary_kinds_are_nonempty_for_all_langs`: para todo `ChunkLang::ALL`, `boundary_kinds()` não-vazio e `language()` não panica.

- [ ] **Step 2: Rodar — falha (from_ext/boundary_kinds/ALL/language indefinidos)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests -q`
Expected: FAIL.

- [ ] **Step 3: Adicionar grammars no Cargo.toml** (junto dos existentes, ~linha 91-94)

Adicionar deps: `tree-sitter-go`, `tree-sitter-java`, `tree-sitter-c`, `tree-sitter-cpp`,
`tree-sitter-c-sharp`, `tree-sitter-ruby`, `tree-sitter-php` (versão "0.23" como ponto de
partida). **Auditoria:** confirmar as versões publicadas no crates.io compatíveis com
tree-sitter 0.25 — `cargo update` resolve; ajustar o número se `cargo build` reclamar de
`LANGUAGE` incompatível.

- [ ] **Step 4: Implementar `from_ext`, `from_path`, `ALL`, `language()`, `boundary_kinds()`, `kind_of()` em chunk.rs**

Dispatch Ollama, auditar, aplicar. Contrato em `impl ChunkLang`:
- `const ALL: [ChunkLang; 11]` com todas as variantes.
- `from_ext(ext: &str) -> Option<Self>`: rs→Rust; ts|mts|cts→TypeScript; tsx→Tsx; py|pyi→Python; go→Go; java→Java; c|h→C; cpp|cc|cxx|hpp|hh→Cpp; cs→CSharp; rb→Ruby; php→Php; _→None.
- `from_path(&Path) -> Option<Self>`: extensão → `from_ext`.
- `language(self) -> tree_sitter::Language`: mapeia cada variante ao grammar (`tree_sitter_rust::LANGUAGE.into()` etc.; TS=`LANGUAGE_TYPESCRIPT`, Tsx=`LANGUAGE_TSX`, Php=`LANGUAGE_PHP` — auditar o nome exato do const exportado por cada crate).
- `boundary_kinds(self) -> &'static [&'static str]`: os node-types de fronteira por linguagem — usar a tabela da spec (Rust: function_item/impl_item/struct_item/enum_item/trait_item/mod_item; Python: function_definition/class_definition/decorated_definition; Go: function_declaration/method_declaration/type_declaration; etc.).
- `kind_of(node_kind: &str) -> ChunkKind`: contém "function"→Function; "method"→Method; "class"/"struct"/"enum"/"trait"/"interface"/"module"/"namespace"/"impl"→Class; senão Block.

- [ ] **Step 5: Rodar — deve passar (regenerar lockfile)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests -q`
Expected: PASS. Se falhar por versão de grammar → ajustar Cargo.toml (auditoria).

- [ ] **Step 6: Commit**

`git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/Cargo.lock apps/desktop/src-tauri/src/code/chunk.rs && git commit -m "feat(chunk): 10 linguagens — grammars + tabela de node-types + detecção por extensão"`

---

### Task 3: Algoritmo fronteira+merge + fallback + extração de símbolo

**Files:**
- Modify: `apps/desktop/src-tauri/src/code/chunk.rs`

- [ ] **Step 1: Escrever os testes que falham**

Fixture `RUST_SRC` com: um `use`, duas fns pequenas (`small_a`, `small_b`), um `struct Big` + `impl Big` com `method_one`/`method_two`. Testes:
- `chunks_functions_with_symbols`: saída não-vazia; algum symbol contém "small_a"; **invariante** — para todo chunk, `&RUST_SRC[byte_range] == text` e `start_line>=1 && end_line>=start_line`.
- `oversized_class_splits_into_methods`: com `ChunkOpts{target:20,max:30,min:1}`, a impl gigante quebra → `>=2` chunks `Method`.
- `invalid_source_falls_back_never_empty`: código-lixo `")))not valid((("` → saída não-vazia.
- `unknown_content_via_fallback_covers_source`: `fallback_chunks("linha 1\n\nlinha 3\n")` não-vazio e o 1º chunk casa a fatia de bytes.

- [ ] **Step 2: Rodar — falha (BoundaryChunker vazio, fallback_chunks indefinido)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests -q`
Expected: FAIL.

- [ ] **Step 3: Implementar o algoritmo (GERAR VIA OLLAMA, AUDITAR, APLICAR)**

Spec pro dispatch: "Rust, arquivo code/chunk.rs. Implemente `BoundaryChunker::chunk` e a fn
livre `fallback_chunks(source: &str) -> Vec<Chunk>`. Contrato:
- `chunk` parseia com `tree_sitter::Parser` + `lang.language()`. Se `parse` = None → retorna
  `fallback_chunks(source)`.
- Percorre os filhos DIRETOS da raiz. Nó cujo `kind()` ∈ `lang.boundary_kinds()` vira Chunk:
  symbol via `node.child_by_field_name(\"name\")` (ou primeiro descendente cujo kind contém
  \"identifier\"/\"name\"/\"constant\"; None se nada), kind = `ChunkLang::kind_of(node.kind())`,
  linhas 1-idx via `start_position().row+1`/`end_position().row+1`, byte_range = `node.byte_range()`,
  text = `&source[range]`.
- Código entre nós-fronteira (imports/statements soltos) agrupa em Chunks `Block`.
- MERGE: chunks adjacentes com `text.len()/4 < opts.min_tokens` fundem com o vizinho
  seguinte (byte_range contíguo unido, symbol do 1º não-None, kind do maior) até passar de
  `opts.target_tokens` ou acabar.
- SPLIT: chunk com `text.len()/4 > opts.max_tokens` E cujo nó tem filhos-fronteira →
  recursivamente chunka pelos filhos (impl/class → um chunk por método). Sem filhos-fronteira
  → mantém inteiro (não corta no meio de sintaxe).
- Nunca panica; nunca vazio pra source não-vazio.
`fallback_chunks`: divide por blocos separados por linha em branco; bloco > ~2000 bytes
quebra em janelas de ~2000; cada pedaço = Chunk kind=Fallback, symbol=None, byte_range/linhas
corretos, text = fatia exata. Nunca vazio pra source não-vazio."

**Auditar:** (a) `&source[byte_range]==text` sempre; (b) sem `.unwrap()` em node opcional;
(c) árvore com erro localizado ainda chunka o resto (não descartar tudo por um `has_error`);
(d) merge/split respeitam os limites; (e) índices de byte em char boundary (usar byte_range
do tree-sitter, que é seguro). Corrigir e aplicar.

- [ ] **Step 4: Rodar TODOS os testes do chunk — devem passar**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk:: -q`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add apps/desktop/src-tauri/src/code/chunk.rs && git commit -m "feat(chunk): algoritmo fronteira+merge+split + fallback (nunca falha, nunca vazio)"`

---

### Task 4: Cobertura por linguagem (fixtures das 10)

**Files:**
- Modify: `apps/desktop/src-tauri/src/code/chunk.rs`

- [ ] **Step 1: Escrever um teste parametrizado por linguagem**

`each_language_chunks_a_function`: uma tabela `(ChunkLang, fonte-mínimo-com-1-função, nome-esperado)`
pra cada linguagem — Rust `"fn alpha() {}"`, TS `"function alpha() {}"`, Tsx idem, Python
`"def alpha():\n    pass"`, Go `"package p\nfunc alpha() {}"`, Java `"class C { void alpha() {} }"`,
C `"int alpha() { return 0; }"`, Cpp idem, CSharp `"class C { void alpha() {} }"`, Ruby
`"def alpha\nend"`, Php `"<?php function alpha() {}"`. Para cada: `chunk_code` não-vazio e
algum chunk tem `symbol==Some("alpha")` OU `text.contains("alpha")`.

- [ ] **Step 2: Rodar — pode falhar em langs cujo field de nome difere**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests::each_language -q`
Expected: FAIL nas langs cujo `child_by_field_name("name")` não bate.

- [ ] **Step 3: Ajustar extração de símbolo por linguagem (AUDITAR contra o AST real)**

Para cada lang que falhar: inspecionar o node-type/field real (o assert imprime o chunk).
Reforçar a extração genérica de símbolo com o fallback "primeiro descendente cujo kind contém
identifier/name/constant". Edição cirúrgica (<30 linhas) — pode ser direta.

- [ ] **Step 4: Rodar — todas as 11 variantes passam**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk::tests::each_language -q`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add apps/desktop/src-tauri/src/code/chunk.rs && git commit -m "test(chunk): fixtures das 10 linguagens + extração de símbolo robusta"`

---

### Task 5: Tool MCP `code_chunks`

**Files:**
- Modify: `apps/desktop/src-tauri/src/mcp/tools.rs`

- [ ] **Step 1: Escrever o teste que falha (o handler produz JSON de chunks)**

`code_chunks_tool_returns_chunks_for_a_file` (tokio::test): grava um `sample.rs` com
`fn alpha() {}\nfn beta() {}` num tempdir único-por-PID; chama o handler com
`json!({"path": <file>})`; asserta `out["chunks"]` array com `len>=2` e algum `["symbol"]=="alpha"`;
limpa o tempdir.

- [ ] **Step 2: Rodar — falha (handler indefinido)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml code_chunks_tool -q`
Expected: FAIL.

- [ ] **Step 3: Declarar a tool na lista + implementar o handler (AUDITAR estilo do arquivo)**

Na lista json! de tools (junto das demais, ~linha 94): entrada `code_chunks` com description
"Fatia um arquivo de código por função/classe/método (AST)…" e inputSchema `{ path: string
(required), target_tokens: number }`.

Handler `handle_code_chunks(args: &serde_json::Value) -> serde_json::Value` (segue o padrão
das tools vizinhas): lê `path`; `ChunkLang::from_path` → se None, `{error}`; `fs::read_to_string`
→ se Err, `{error}`; monta `ChunkOpts` (default + `target_tokens` opcional); `chunk_code`;
mapeia cada Chunk pra `{symbol, kind: "{:?}", start_line, end_line, text}`; retorna
`{chunks: [...]}`. Ligar `"code_chunks" => handle_code_chunks(&args).await,` no `match tool`
que roteia o grupo de código (auditar QUAL match block é o certo; seguir o formato de retorno
das tools vizinhas — algumas embrulham em `content`/text, replicar o padrão delas).

- [ ] **Step 4: Rodar o teste da tool + a suíte do chunk (regression guard)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml chunk:: code_chunks -q`
Expected: PASS.

- [ ] **Step 5: Commit**

`git add apps/desktop/src-tauri/src/mcp/tools.rs && git commit -m "feat(mcp): tool code_chunks — agente recebe o arquivo fatiado por símbolo"`

---

### Task 6: Regression guard + typecheck full

- [ ] **Step 1: Rodar a suíte Rust INTEIRA (não só a nova)**

Run: `cargo test --manifest-path apps/desktop/src-tauri/Cargo.toml -q`
Expected: PASS — nenhum teste pré-existente quebrado; os novos verdes.

- [ ] **Step 2: Typecheck do frontend**

Run: `cd apps/desktop && npx tsc -b`
Expected: exit 0.

- [ ] **Step 3: Build debug (build-script/externalBin não quebrou)**

Run: `cargo build --manifest-path apps/desktop/src-tauri/Cargo.toml --lib -q`
Expected: sucesso.

- [ ] **Step 4: Commit (se algum ajuste foi preciso)**

`git add -A apps/desktop/src-tauri && git commit -m "chore(chunk): regression guard verde — suíte + typecheck + build"`

---

## Notas de release (fora das tasks)

Ao final, bump de versão + Novidades ("Agentes leem código já fatiado por função — tool
code_chunks") + tag → release assinado (mesma cadeia dos releases anteriores). NÃO faz parte
do plano de implementação; é o passo de publicação, decidido pelo dono.

## Self-review (cobertura da spec)

- Módulo puro `code/chunk.rs` → Tasks 1-4. ✅
- 10 linguagens via tabela de node-types → Task 2. ✅
- Algoritmo fronteira+merge atrás do trait `Chunker` → Task 3 (trait na Task 1). ✅
- Fallback nunca-falha/nunca-vazio → Task 3. ✅
- Tool MCP `code_chunks` (consumidor Fase 1) → Task 5. ✅
- Testes por execução real (cargo test) + regression guard → todas as tasks + Task 6. ✅
- Fora de escopo (cost-model, OmniGraph, OmniFS) → não implementado, trait deixa plugável. ✅
- Consistência de nomes: `ChunkLang`/`ChunkOpts`/`Chunk`/`ChunkKind`/`chunk_code`/`BoundaryChunker`/`boundary_kinds`/`kind_of`/`from_ext`/`from_path`/`language`/`fallback_chunks`/`handle_code_chunks` — usados idênticos em todas as tasks. ✅
