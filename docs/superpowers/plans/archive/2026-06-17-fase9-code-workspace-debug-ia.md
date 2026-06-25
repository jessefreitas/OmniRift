# Fase 9 — Code Workspace & Debug IA — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development (recomendado) ou superpowers:executing-plans pra implementar task-a-task. Steps usam checkbox (`- [ ]`).
> **Execução OmniForge:** o **corpo do código** de cada step é gerado via Ollama (`multi_agent_dispatch.py --type code`, devstral/qwen) e **auditado pelo Claude** por execução real (`cargo test`). As **interfaces, tipos e testes** abaixo são o contrato fixo — não mudam.

**Goal:** Adicionar ao OmniRift um **CodeNode** (editor Monaco no canvas) com **métricas de complexidade nativas** (Ciclomática, Cognitiva, Halstead, Maintainability Index) e um **DebuggerAgent** que usa **Serena MCP** (LSP semântico) + **MemoryProvider ativo** pra propor e validar fixes. Debug vira cirurgia semântica com memória de bugs passados.

**Architecture:** Novo módulo `src-tauri/src/code/` (parser tree-sitter + métricas + file_io), novo módulo `src-tauri/src/mcp/client.rs` + `mcp/serena_pool.rs` (cliente MCP stdio + pool de subprocessos Serena por projeto), novos comandos em `commands/code.rs` e `commands/debug.rs`. Frontend: novo `CodeNode` em `components/nodes/CodeNode.tsx` (Monaco dynamic-import), novo tipo em `types/canvas.ts`, novo `nodeTypes` no `FloorCanvas.tsx`. Comunicação CodeNode ↔ DebuggerAgent via event bus Tauri (`debug_request` command + `emit`/`listen`), **não via PTY pipe**.

**Tech Stack:** Rust 2021, Tauri 2.11, `tree-sitter` + grammars por feature flag, `notify` 6 (file watch), `tokio::process` (subprocessos Serena), `serde_json` (JSON-RPC). Front: `@monaco-editor/react` 4, `@xyflow/react` 12, **Tailwind direto** (o app NÃO consome `@omnirift/ui`/shadcn) e **tipos locais** em `src/types/` (o app NÃO importa `@omnirift/shared-types`). Reaproveita `MemoryRegistry` (Fase 8 ✅) e `find_serena()` (commands/mcp.rs:100).

**Referência canônica das métricas:** ver spec §5.

---

## File structure

| Arquivo | Responsabilidade |
|---|---|
| `src-tauri/src/code/mod.rs` (criar) | re-exports + `pub mod` do módulo |
| `src-tauri/src/code/file_io.rs` (criar) | abrir/salvar/watch filesystem (notify crate) |
| `src-tauri/src/code/tree_sitter.rs` (criar) | parser incremental multi-linguagem (feature flags) |
| `src-tauri/src/code/cyclomatic.rs` (criar) | McCabe 1976 sobre AST |
| `src-tauri/src/code/cognitive.rs` (criar) | SonarSource 2016 sobre AST |
| `src-tauri/src/code/halstead.rs` (criar) | Halstead 1977 sobre tokens |
| `src-tauri/src/code/metrics.rs` (criar) | agregador + Maintainability Index |
| `src-tauri/src/code/thresholds.rs` (criar) | config de thresholds por linguagem (serde) |
| `src-tauri/src/mcp/client.rs` (criar) | cliente JSON-RPC sobre stdio (spec MCP 2024-11-05) |
| `src-tauri/src/mcp/serena_pool.rs` (criar) | pool de subprocessos Serena por projeto (teto 3, timeout ocioso 5min) |
| `src-tauri/src/commands/code.rs` (criar) | comandos Tauri: code_open, code_save, code_metrics, code_watch |
| `src-tauri/src/commands/debug.rs` (criar) | comandos Tauri: debug_request, debug_apply_fix |
| `src-tauri/src/lib.rs` (modificar) | `pub mod code;` + manage state + registrar comandos |
| `src-tauri/src/commands/mod.rs` (modificar) | `pub mod code; pub mod debug;` |
| `src-tauri/src/mcp/mod.rs` (modificar) | `pub mod client; pub mod serena_pool;` |
| `src-tauri/Cargo.toml` (modificar) | deps: tree-sitter, grammars, notify |
| `apps/desktop/src/types/code.ts` (criar) | tipos LOCAIS `CodeMetrics`, `FunctionMetrics` (o app não consome `@omnirift/shared-types`) |
| `apps/desktop/src/types/canvas.ts` (modificar) | novo `kind: "code"` + `CodeNode` interface |
| `apps/desktop/src/components/nodes/CodeNode.tsx` (criar) | Monaco dynamic-import + painel de métricas |
| `apps/desktop/src/components/FloorCanvas.tsx` (modificar) | adicionar `code` em `nodeTypes` |
| `apps/desktop/src/lib/code-client.ts` (criar) | Tauri commands client (`code_open`, `code_metrics`, `debug_request`) |
| `apps/desktop/src/lib/debug-bus.ts` (criar) | listener do event bus `debug_request`/`debug_response` |
| `apps/desktop/src/store/canvas-store.ts` (modificar) | suporte a criar CodeNode |

---

### Task 1: Deps + esqueleto do módulo code + tipos compartilhados

**Files:**
- Modify: `apps/desktop/src-tauri/Cargo.toml`
- Create: `apps/desktop/src-tauri/src/code/mod.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs:1-6` (lista de `pub mod`)
- Modify: `apps/desktop/src-tauri/src/commands/mod.rs` (`pub mod code; pub mod debug;`)
- Modify: `apps/desktop/src-tauri/src/mcp/mod.rs` (`pub mod client; pub mod serena_pool;`)
- Create: `apps/desktop/src/types/code.ts` (tipos LOCAIS `CodeMetrics`, `FunctionMetrics` — o app não consome `@omnirift/shared-types`)

**Decisão (registrar):** tree-sitter grammars carregadas via **feature flags** no Cargo (`ts-rust`, `ts-typescript`, `ts-python` features). Default: todas on. Load-on-demand em runtime: só instancia a grammar da linguagem do arquivo aberto (via `Language::from_extension`). Grammars: `tree-sitter-rust`, `tree-sitter-typescript`, `tree-sitter-python` — as 3 linguagens do próprio OmniRift. Outras (go, java, c#) ficam pra Fase 2 do CodeNode.

**⚠️ Compat de ABI (validar no Step 5):** o runtime `tree-sitter` e as crates de grammar precisam ser ABI-compatíveis. `tree-sitter = "0.25"` com grammars `0.23` pode quebrar no link (mismatch da versão da linguagem C). Se `cargo build` falhar com erro de `language()`/ABI, alinhar versões (subir as grammars OU baixar o runtime) — deixar o Cargo resolver e fixar o par que compila.

- [ ] **Step 1: adicionar deps no Cargo.toml** — em `[dependencies]`:
```toml
# Fase 9 — CodeNode & Debug IA
tree-sitter = "0.25"
tree-sitter-rust = "0.23"
tree-sitter-typescript = "0.23"
tree-sitter-python = "0.23"
notify = "6"
notify-debouncer-mini = "0.4"  # debounce 500ms pra re-parse
```

- [ ] **Step 2: criar `code/mod.rs`** com:
```rust
pub mod file_io;
pub mod tree_sitter;
pub mod cyclomatic;
pub mod cognitive;
pub mod halstead;
pub mod metrics;
pub mod thresholds;

pub use metrics::{CodeMetrics, FunctionMetrics, compute_metrics};
pub use thresholds::Thresholds;
```
(criar stubs `// TODO Task N` vazios nos submódulos referenciados; fazer os `pub mod` só quando o submódulo existir — criar `mod.rs` mínimo primeiro e adicionar `pub mod` na task que cria cada submódulo.)

- [ ] **Step 3: registrar `pub mod code;` em lib.rs** — adicionar após `pub mod commands;` (lib.rs:4). `pub mod client; pub mod serena_pool;` em `mcp/mod.rs`. `pub mod code; pub mod debug;` em `commands/mod.rs`.

- [ ] **Step 4: tipos LOCAIS em `apps/desktop/src/types/code.ts`** — exportar (NÃO em `@omnirift/shared-types` — o app usa tipos locais):
```typescript
export interface FunctionMetrics {
  name: string;
  startLine: number;
  endLine: number;
  cyclomatic: number;
  cognitive: number;
  halsteadVolume: number;
  halsteadDifficulty: number;
  maintainabilityIndex: number;
  /** "green" | "yellow" | "red" conforme thresholds. */
  severity: "green" | "yellow" | "red";
}

export interface CodeMetrics {
  path: string;
  language: string;
  loc: number;
  functions: FunctionMetrics[];
  /** Agregados do arquivo todo. */
  avgCyclomatic: number;
  maxCyclomatic: number;
  avgCognitive: number;
  maxCognitive: number;
  maintainabilityIndex: number;
  computedAt: string;  // ISO timestamp
}
```

- [ ] **Step 5: compilar** — Run: `cd apps/desktop/src-tauri && cargo build` · Expected: compila (módulos stub ok).

- [ ] **Step 6: commit**
```bash
git add apps/desktop/src-tauri/Cargo.toml apps/desktop/src-tauri/src/code/ \
        apps/desktop/src-tauri/src/lib.rs apps/desktop/src-tauri/src/commands/mod.rs \
        apps/desktop/src-tauri/src/mcp/mod.rs apps/desktop/src/types/code.ts
git commit -m "feat(code): esqueleto do módulo code + deps tree-sitter/notify"
```

---

### Task 2: `tree_sitter.rs` — parser incremental multi-linguagem

**Files:**
- Create: `apps/desktop/src-tauri/src/code/tree_sitter.rs`
- Test: inline `#[cfg(test)]`

> Contrato: `parse(path: &Path, source: &str) -> Result<ParsedFile>` onde `ParsedFile { language: Language, tree: Tree, source: String }`. `Language::from_extension(ext) -> Option<Language>`. Suporta `.rs`/`.ts`/`.tsx`/`.js`/`.jsx`/`.py`. Rejeita extensão desconhecida com `Err`. **v1: parse STATELESS** — full re-parse a cada chamada (tree-sitter é rápido o bastante a 500ms debounce). Reuso incremental (`previous_tree`) fica pra depois, e só faz sentido com cache server-side da `Tree` por path (os comandos da Task 10 são stateless); NÃO prometer "incremental" na v1.

- [ ] **Step 1: teste falho** — parseia snippet Rust e TS, rejeita `.txt`:
```rust
#[test]
fn parse_rust_snippet() {
    let src = "fn main() { if true { println!(\"x\"); } }";
    let parsed = super::parse(&std::path::PathBuf::from("x.rs"), src).unwrap();
    assert_eq!(parsed.language, super::Language::Rust);
    let root = parsed.tree.root_node();
    assert!(root.to_sexp().contains("function_item"));
}

#[test]
fn parse_tsx_snippet() {
    let src = "function foo(a: number): number { return a + 1; }";
    let parsed = super::parse(&std::path::PathBuf::from("x.tsx"), src).unwrap();
    assert_eq!(parsed.language, super::Language::TypeScript);
}

#[test]
fn rejects_unknown_extension() {
    let r = super::parse(&std::path::PathBuf::from("x.txt"), "hello");
    assert!(r.is_err());
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift code::tree_sitter` · Expected: FAIL (módulo stub).

- [ ] **Step 3: implementar** — body via Ollama. `enum Language { Rust, TypeScript, JavaScript, Python }` + `from_extension`. `struct ParsedFile { language, tree: tree_sitter::Tree, source: String }`. `fn parse(path, source) -> Result<ParsedFile>` — escolhe grammar por extensão, instancia `Parser`, `parser.parse(source, None)`. Manter `tree` (não drop) — o CodeNode precisa do `root_node()` pra calcular métricas.

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift code::tree_sitter` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(code): parser tree-sitter multi-linguagem (Rust/TS/JS/Python)`.

---

### Task 3: `cyclomatic.rs` — McCabe 1976 sobre AST

**Files:**
- Create: `apps/desktop/src-tauri/src/code/cyclomatic.rs`
- Test: inline `#[cfg(test)]`

> Contrato: `fn cyclomatic_per_function(parsed: &ParsedFile) -> Vec<FunctionMetric>`. `FunctionMetric { name, start_line, end_line, cyclomatic }`. Base = 1 (cada função tem pelo menos 1 caminho). Soma +1 para cada nó AST que cria branch: `if_statement`, `while_statement`, `for_statement`, `match_expression` (Rust), `switch_statement`, `catch_clause`, `&&`, `||`, `?.` (optional chaining). Walk recursivo por função. Detecta função por `function_item` (Rust), `function_declaration`/`method_definition` (TS/JS), `function_definition` (Python). O worker DEVE abrir `tree_sitter.rs` (Task 2) e usar `node.kind()` + `node.child_by_field_name("name")` + `node.start_position().row` + `node.end_position().row`.

- [ ] **Step 1: teste falho** — casos conhecidos:
```rust
#[test]
fn simple_function_cc1() {
    let src = "fn simple() { let x = 1; }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::cyclomatic_per_function(&p);
    assert_eq!(m.len(), 1);
    assert_eq!(m[0].name, "simple");
    assert_eq!(m[0].cyclomatic, 1);
}

#[test]
fn if_and_while_cc3() {
    let src = "fn f(a: bool, b: bool) { if a { while b { } } }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::cyclomatic_per_function(&p);
    assert_eq!(m[0].cyclomatic, 3);  // base 1 + if + while
}

#[test]
fn logical_and_or_cc3() {
    // && e || somam +1 cada
    let src = "fn f(a: bool, b: bool, c: bool) { if a && b || c { } }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::cyclomatic_per_function(&p);
    assert_eq!(m[0].cyclomatic, 4);  // base 1 + if + && + ||
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift code::cyclomatic` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. Walk AST por função; pra cada função, walk recursivo somando +1 por nó de branch. Mapear nomes de nós por linguagem:
  - Rust: `if_expression`, `while_expression`, `for_expression`, `match_expression`, `binary_expression` (operator `&&`/`||`), `try_expression`.
  - TS/JS: `if_statement`, `while_statement`, `for_statement`, `switch_statement`, `catch_clause`, `binary_expression` (operator `&&`/`||`), `conditional_expression` (ternário).
  - Python: `if_statement`, `while_statement`, `for_statement`, `except_clause`, `boolean_operator` (op `and`/`or`).
Usar `node.child_by_field_name("name")` pra extrair nome da função; fallback `node.child(0)` se field não existir (Python `def` tem nome em field "name").

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift code::cyclomatic` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(code): Cyclomatic Complexity (McCabe) sobre AST`.

---

### Task 4: `cognitive.rs` — SonarSource 2016 sobre AST

**Files:**
- Create: `apps/desktop/src-tauri/src/code/cognitive.rs`
- Test: inline `#[cfg(test)]`

> Contrato: `fn cognitive_per_function(parsed: &ParsedFile) -> Vec<FunctionMetric>`. `FunctionMetric { name, start_line, end_line, cognitive }`. Spec SonarSource: base = 0; cada `if/while/for/switch/catch` soma +1 + `nesting_level` (profundidade atual dentro de outras estruturas); `&&`/`||` somam +1 (sem nesting extra); recursão soma +1; `goto`/`break`/`continue` pra label não-default somam +1. **Spec literal:** https://www.sonarsource.com/docs/CognitiveComplexity.pdf — worker DEVE seguir a v1.2 da spec.

- [ ] **Step 1: teste falho** — casos da própria SonarSource (exemplos do paper):
```rust
#[test]
fn simple_if_cognitive1() {
    let src = "fn f(a: bool) { if a { } }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::cognitive_per_function(&p);
    assert_eq!(m[0].cognitive, 1);
}

#[test]
fn nested_if_cognitive3() {
    // if externo +1 (nesting 0), if interno +2 (nesting 1) = 3
    let src = "fn f(a: bool, b: bool) { if a { if b { } } }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::cognitive_per_function(&p);
    assert_eq!(m[0].cognitive, 3);
}

#[test]
fn logical_op_no_nesting_cognitive1() {
    // && soma +1 mas NÃO aumenta nesting
    let src = "fn f(a: bool, b: bool) { if a && b { } }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::cognitive_per_function(&p);
    assert_eq!(m[0].cognitive, 2);  // if +1, && +1
}

#[test]
fn ts_ternary_cognitive1() {
    let src = "function f(a: boolean): string { return a ? \"y\" : \"n\"; }";
    let p = super::super::tree_sitter::parse(&"x.tsx".into(), src).unwrap();
    let m = super::cognitive_per_function(&p);
    assert_eq!(m[0].cognitive, 1);
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift code::cognitive` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. Walk recursivo mantendo `nesting: u32` (incrementa ao entrar em if/while/for/switch/catch, decrementa ao sair). Para cada nó de controle: `cognitive += 1 + nesting`. Para `&&`/`||`: `cognitive += 1` (sem nesting). Para recursão (função chama a si mesma): `cognitive += 1`. Para `break`/`continue` com label: `cognitive += 1`. **Cuidado:** o walk precisa ser pré-ordem (soma antes de descer) e pós-ordem (decrementa nesting ao sair). Usar `node.kind()` + `node.child_by_field_name("name")` igual à Task 3.

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift code::cognitive` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(code): Cognitive Complexity (SonarSource) sobre AST`.

---

### Task 5: `halstead.rs` — Halstead 1977 sobre tokens

**Files:**
- Create: `apps/desktop/src-tauri/src/code/halstead.rs`
- Test: inline `#[cfg(test)]`

> Contrato: `fn halstead_per_function(parsed: &ParsedFile) -> Vec<FunctionMetric>`. `FunctionMetric { name, start_line, end_line, volume, difficulty, effort, bugs_estimated }`. Halstead: `N1 = operadores totais, N2 = operandos totais, n1 = operadores distintos, n2 = operandos distintos`. `Vocabulary = n1+n2`, `Length = N1+N2`, `Volume = Length * log2(Vocabulary)`, `Difficulty = (n1/2) * (N2/n2)`, `Effort = Difficulty * Volume`, `Bugs = Volume / 3000`. Operadores = keywords (`if`, `while`, `fn`, `let`, `return`, …) + operadores (`+`, `-`, `&&`, `=`, …). Operandos = identifiers + literals. Walk por função, somar tokens.

- [ ] **Step 1: teste falho** — caso simples:
```rust
#[test]
fn simple_function_halstead() {
    let src = "fn add(a: i32, b: i32) -> i32 { return a + b; }";
    let p = super::super::tree_sitter::parse(&"x.rs".into(), src).unwrap();
    let m = super::halstead_per_function(&p);
    assert_eq!(m.len(), 1);
    // Volume > 0 sempre (tem tokens); Difficulty deve ser baixa (1 operador distinto: +)
    assert!(m[0].volume > 0.0);
    assert!(m[0].difficulty > 0.0);
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift code::halstead` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. Walk por função, classificar cada token: se for keyword/operador → operador; se for identifier/literal → operando. Contar distintos via `HashSet<String>`. Usar `tree_sitter::Node::kind()` para operadores; para operandos, `node.child_by_field_name("name")` em identifier nodes (ex: `identifier`, `literal`). Fórmulas exatas de Halstead (ver spec §5). `bugs_estimated = volume / 3000.0`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift code::halstead` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(code): Halstead Metrics sobre tokens`.

---

### Task 6: `metrics.rs` + `thresholds.rs` — agregador + MI + config

**Files:**
- Create: `apps/desktop/src-tauri/src/code/metrics.rs`
- Create: `apps/desktop/src-tauri/src/code/thresholds.rs`
- Modify: `apps/desktop/src-tauri/src/code/mod.rs` (adicionar `pub use` consolidado)
- Test: inline em `metrics.rs`

> Contrato: `fn compute_metrics(path: &Path, source: &str) -> Result<CodeMetrics>`. `CodeMetrics` conforme `apps/desktop/src/types/code.ts` (tipos locais). `Maintainability Index` = `max(0.0, (171.0 - 5.2 * ln(volume_total) - 0.23 * cyclomatic_max - 16.2 * ln(loc)) * 100.0 / 171.0)`. `severity`: `green` se abaixo do threshold yellow, `yellow` se entre yellow e red, `red` se acima. Thresholds default: Cyclomatic { yellow: 10, red: 15 }, Cognitive { yellow: 15, red: 20 }, Halstead Difficulty { yellow: 5, red: 10 }, MI { yellow: 65, red: 50 } (abaixo de 50 = red, 50-65 = yellow, acima = green — MI é inverso).

- [ ] **Step 1: teste falho** — função simples tem MI alto (green), função complexa tem MI baixo (red):
```rust
#[test]
fn simple_function_mi_green() {
    let src = "fn add(a: i32, b: i32) -> i32 { a + b }";
    let m = super::compute_metrics(&std::path::PathBuf::from("x.rs"), src).unwrap();
    assert_eq!(m.language, "rust");
    assert_eq!(m.functions.len(), 1);
    assert!(m.functions[0].maintainability_index > 65.0);
    assert_eq!(m.functions[0].severity, "green");
}

#[test]
fn complex_function_mi_red() {
    // função com if+while+for+&&+|| = CC=5, Cognitive alta
    let src = "fn f(a: bool, b: bool, c: bool, d: bool) -> bool {
        if a && b || c { while d { for i in 0..10 { if i > 5 { return true; } } } }
        false
    }";
    let m = super::compute_metrics(&std::path::PathBuf::from("x.rs"), src).unwrap();
    assert_eq!(m.functions[0].cyclomatic, 7);  // 1 + if + && + || + while + for + if(nested)
    assert!(m.functions[0].maintainability_index < 65.0);
    assert_eq!(m.functions[0].severity, "red");
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift code::metrics` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `compute_metrics` chama `parse`, depois `cyclomatic_per_function`, `cognitive_per_function`, `halstead_per_function`. Merge por `name + start_line`. MI por função usa volume_total (soma de volumes de Halstead), cyclomatic_max (max da função), loc (end-start+1). Agregados do arquivo: `avg_*` = média, `max_*` = máximo. `thresholds.rs` com struct `Thresholds` (serde, default canônico). `severity` por campo (cyclomatic, cognitive, halstead, MI) — pega o **pior** (red vence yellow vence green).

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift code::metrics` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(code): agregador de métricas + Maintainability Index + thresholds`.

---

### Task 7: `file_io.rs` — abrir/salvar/watch filesystem

**Files:**
- Create: `apps/desktop/src-tauri/src/code/file_io.rs`
- Test: inline `#[cfg(test)]`

> Contrato: `fn read(path: &Path) -> Result<String>` (utf-8). `fn write(path: &Path, content: &str) -> Result<()>` (atomic via tempfile + rename). `fn watch(path: &Path, debounce_ms: u64) -> impl Stream<Item = ()>` (notify-debouncer-mini). `RwLock<HashMap<PathBuf, WatchHandle>>` pra cancelar watch quando CodeNode desmonta.

- [ ] **Step 1: teste falho** — write lê de volta:
```rust
#[tokio::test]
async fn write_then_read_roundtrip() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("x.rs");
    super::write(&f, "fn main() {}").unwrap();
    let read = super::read(&f).unwrap();
    assert_eq!(read, "fn main() {}");
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift code::file_io` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `read`: `std::fs::read_to_string`. `write`: criar arquivo temporário `f.tmp` no mesmo dir, escrever, `fs::rename(f.tmp, f)` (atomic). `watch`: `notify_debouncer_mini::new_debouncer(debounce, callback)` → `tokio::sync::mpsc::channel` → `ReceiverStream`. Retornar `WatchHandle { _debouncer: Debouncer, stop: tokio::sync::oneshot::Sender<()> }`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift code::file_io` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(code): file_io (read/write atomic + watch)`.

---

### Task 8: `mcp/client.rs` — JSON-RPC sobre stdio (spec MCP 2024-11-05)

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/client.rs`
- Test: inline `#[cfg(test)]` com stub JSON-RPC via stdin/stdout pipe

> Contrato: `struct McpClient { child: tokio::process::Child, stdin: ChildStdin, stdout: BufReader<ChildStdout>, next_id: u64 }`. `async fn spawn(command: String, args: Vec<String>) -> Result<McpClient>`. `async fn call(&mut self, method: &str, params: Value) -> Result<Value>` (envia `{"jsonrpc":"2.0","id":N,"method":M,"params":P}`, lê linha, devolve `result`). `async fn notify(&mut self, method: &str, params: Value)` (sem id, sem resposta). `async fn initialize(&mut self) -> Result<InitializeResult>`. `async fn list_tools(&mut self) -> Result<Vec<Tool>>`. `async fn call_tool(&mut self, name: &str, args: Value) -> Result<Value>`.

- [ ] **Step 1: teste falho** — contra stub `cat` (echo do stdin pro stdout):
```rust
#[tokio::test]
async fn call_against_cat_stub() {
    // cat lê stdin → escreve stdout; o cliente envia JSON-RPC request e lê resposta
    // (cat devolve o mesmo JSON — não é MCP real, mas testa o framing JSON-RPC)
    let mut c = super::McpClient::spawn("cat".into(), vec![]).unwrap();
    let r = c.call("ping", serde_json::json!({})).await;
    // cat devolve o request como resposta (sem result); teste só valida que o framing funciona
    assert!(r.is_ok(), "framing JSON-RPC básico: {:?}", r);
}
```
(Nota: `cat` ecoa o REQUEST (sem `result`) → NÃO exercita a correlação id→result de verdade. PREFERIR um stub de ~5 linhas: um script `sh` que lê 1 linha do stdin e emite `printf '{"jsonrpc":"2.0","id":1,"result":{"ok":true}}\n'`. Aí o `call()` casa o `id` e devolve `result` — framing real testado. Usar `cat` só como último recurso.)

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift mcp::client` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `tokio::process::Command::new(command).args(args).stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()`. `stdin.write_all(json_line + "\n")`. `stdout.read_line` em loop. `next_id: AtomicU64`. Map de `id -> oneshot::Sender<Value>` pra correlacionar request/response. `call_tool` é shortcut pra `tools/call` com `name` e `arguments`. Spec MCP: https://spec.modelcontextprotocol.io/specification/2024-11-05/basic/transports — stdio, newline-delimited JSON-RPC 2.0.

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift mcp::client` · Expected: PASS.

- [ ] **Step 5: commit** — `feat(mcp): cliente JSON-RPC sobre stdio (spec MCP 2024-11-05)`.

---

### Task 9: `mcp/serena_pool.rs` — pool de subprocessos Serena por projeto

**Files:**
- Create: `apps/desktop/src-tauri/src/mcp/serena_pool.rs`
- Test: inline `#[cfg(test)]` (mock McpClient via trait)

> Contrato: `struct SerenaPool { conns: DashMap<PathBuf, PoolEntry>, max_per_project: usize, idle_timeout_secs: u64 }`. `PoolEntry { client: McpClient, last_used: Instant, project: PathBuf }`. `async fn get_or_spawn(&self, project: &Path) -> Result<Lease>` — se existe conexão ociosa pro projeto, reusa; senão spawna novo (respeitando teto `max_per_project` = 3). `Lease` é `Arc<Mutex<McpClient>>` (devolvido ao pool quando drop). `async fn cleanup_idle(&self)` — kill conexões ociosas > 5min. Reaproveita `find_serena()` de `commands/mcp.rs:99-107` (binário Serena ou `uvx --from serena-agent serena`). Args: `start-mcp-server --transport stdio --project-from-cwd --context ide-assistant --open-web-dashboard False` + `cwd = project`.

- [ ] **Step 1: teste falho** — get_or_spawn reusa mesma instância:
```rust
#[tokio::test]
async fn pool_reuses_per_project() {
    let pool = super::SerenaPool::new(3, 300);
    let dir = tempfile::tempdir().unwrap();
    // 1ª lease captura o ptr e é SOLTA (Drop devolve a entry ao pool).
    let ptr1 = {
        let l1 = pool.get_or_spawn(dir.path()).await.unwrap();
        Arc::as_ptr(&l1.client)
    };
    // 2ª lease do mesmo projeto reusa a instância DEVOLVIDA.
    let l2 = pool.get_or_spawn(dir.path()).await.unwrap();
    assert_eq!(ptr1, Arc::as_ptr(&l2.client), "deve reusar a conexão devolvida ao pool");
}
```
(Nota: precisa de Serena instalado ou `uvx` no PATH. Teste skipped se `find_serena()` retorna None — usar `#[cfg(skip_if_no_serena)]` ou `if find_serena().is_none() { return; }` no início.)

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift mcp::serena_pool` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `DashMap<PathBuf, Vec<PoolEntry>>` por projeto. `get_or_spawn`: lock no map, pop uma entry ociosa se houver, senão spawn (respeitando teto). `Lease` implementa `Drop` pra devolver a entry ao pool (push back). `cleanup_idle` roda em task separada (spawn no `setup` do Tauri). **Importante:** o Serena subprocesso usa `--project-from-cwd`, então `cwd = project` no `Command::new`.

- [ ] **Step 4: ver passar** — Run: `cargo test -p omnirift mcp::serena_pool` · Expected: PASS (ou skip se sem Serena).

- [ ] **Step 5: commit** — `feat(mcp): Serena pool (subprocesso por projeto, teto 3, idle timeout)`.

---

### Task 10: `commands/code.rs` — Tauri commands do CodeNode

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/code.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (imports + `generate_handler!`)
- Test: smoke via `cargo test`

> Contrato: comandos Tauri:
> - `code_open(path: String) -> Result<CodeMetrics, String>` — lê arquivo, computa métricas, retorna pra front montar Monaco + painel.
> - `code_save(path: String, content: String) -> Result<(), String>` — write atomic.
> - `code_metrics(path: String, source: String) -> Result<CodeMetrics, String>` — computa métricas sem salvar (debounced do front).
> - `code_watch(path: String) -> Result<String, String>` — inicia watch, devolve watch_id; emite evento `code://changed` quando arquivo muda.

- [ ] **Step 1: teste falho** — `code_open` retorna métricas de um arquivo de teste:
```rust
#[tokio::test]
async fn code_open_returns_metrics() {
    let dir = tempfile::tempdir().unwrap();
    let f = dir.path().join("x.rs");
    std::fs::write(&f, "fn main() { if true { } }").unwrap();
    let m = super::code_open(f.to_string_lossy().to_string()).unwrap();
    assert_eq!(m.language, "rust");
    assert_eq!(m.functions.len(), 1);
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift commands::code` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. Cada command chama `code::file_io` + `code::compute_metrics`. `code_watch` cria `notify-debouncer-mini` e emite `app.emit("code://changed", path)` via `tauri::AppHandle`. Registrar state: `HashMap<PathBuf, WatchHandle>` em `Arc<parking_lot::Mutex<>>`.

- [ ] **Step 4: registrar em lib.rs** — `use commands::code::{code_open, code_save, code_metrics, code_watch};` + adicionar no `generate_handler![]`.

- [ ] **Step 5: ver passar + build completo** — Run: `cargo test -p omnirift && cargo build` · Expected: PASS + compila.

- [ ] **Step 6: commit** — `feat(code): comandos Tauri code_open/save/metrics/watch`.

---

### Task 11: `commands/debug.rs` — DebuggerAgent + event bus

**Files:**
- Create: `apps/desktop/src-tauri/src/commands/debug.rs`
- Modify: `apps/desktop/src-tauri/src/lib.rs` (imports + `generate_handler!` + manage `SerenaPool`)
- Test: smoke

> Contrato: comandos Tauri:
> - `debug_request(payload: DebugPayload) -> Result<String, String>` — recebe `{ code_node_id, file_path, function_name, metrics_snapshot, error_text?, diff_text? }`, monta prompt de debug, spawn DebuggerAgent (TerminalNode com role "debugger"), injeta Serena + MemoryProvider (já em `agent_mcp_config`), envia prompt pro PTY. Devolve `debugger_session_id`.
> - `debug_apply_fix(debugger_session_id: String, fix: FixPayload) -> Result<(), String>` — recebe `{ symbol_name, new_body }`, chama `serena_pool.get_or_spawn(project)` → `serena.call_tool("replace_symbol_body", args)`. Rejeita se Serena não disponível.
> - `debug_search_similar(error_text: String, project: Option<String>) -> Result<Vec<MemoryRecord>, String>` — chama `memory_registry.active_provider().search(query)`.

- [ ] **Step 1: teste falho** — `debug_search_similar` retorna vazio quando sem memória:
```rust
#[tokio::test]
async fn debug_search_similar_empty_by_default() {
    // registry com Local ativo (sem memória) → search retorna vazio
    let dir = tempfile::tempdir().unwrap();
    let db = std::sync::Arc::new(crate::db::Db::open(dir.path()).unwrap());
    let reg = std::sync::Arc::new(crate::memory::MemoryRegistry::new(db));
    let r = super::debug_search_similar_with_registry("erro X".into(), None, &reg).await.unwrap();
    assert!(r.is_empty());
}
```

- [ ] **Step 2: ver falhar** — Run: `cargo test -p omnirift commands::debug` · Expected: FAIL.

- [ ] **Step 3: implementar** — body via Ollama. `debug_request`: monta prompt string com `{file_path, function_name, metrics, error, diff, similar memories}`. Spawna `claude --append-system-prompt "..."` via `pty_spawn` existente (reusar `commands/pty.rs`). Não reimplementa spawn. `debug_apply_fix`: `serena_pool.get_or_spawn(project)` → `call_tool("replace_symbol_body", json!({"symbol_path": symbol_name, "new_body": new_body}))`. `debug_search_similar`: `memory_registry.active_provider().search(MemoryQuery { query: error_text, project, limit: 5 })`.

- [ ] **Step 4: registrar state + commands em lib.rs** — `app.manage(Arc::new(SerenaPool::new(3, 300)))` no `setup`. Adicionar `debug_request, debug_apply_fix, debug_search_similar` no `generate_handler![]`.

- [ ] **Step 5: ver passar + build completo** — Run: `cargo test -p omnirift && cargo build` · Expected: PASS + compila.

- [ ] **Step 6: commit** — `feat(debug): comandos Tauri debug_request/apply_fix/search_similar + SerenaPool state`.

---

### Task 12: Frontend — `CodeNode.tsx` (Monaco dynamic-import + painel de métricas)

**Files:**
- Create: `apps/desktop/src/components/nodes/CodeNode.tsx`
- Modify: `apps/desktop/src/types/canvas.ts` (novo `kind: "code"` + `CodeNode` interface)
- Modify: `apps/desktop/src/components/FloorCanvas.tsx` (adicionar `code` em `nodeTypes`)
- Create: `apps/desktop/src/lib/code-client.ts` (Tauri commands client)
- Modify: `apps/desktop/src/store/canvas-store.ts` (suporte a criar CodeNode)
- Test: `npm run typecheck`

> Contrato: `CodeNode` tem:
> - `filePath: string` — caminho do arquivo aberto.
> - `source: string` — conteúdo atual (debounced 500ms → `code_metrics`).
> - `metrics: CodeMetrics | null` — último snapshot.
> - Monaco editor carregado via `@monaco-editor/react` com `loading="lazy"` (dynamic import).
> - Painel lateral (240px) com barras coloridas por função: `severity` + `cyclomatic` + `cognitive` + `halstead` + `MI`.
> - Botão "Debug" que chama `debug_request({ code_node_id, file_path, function_name, metrics, error_text })`.

- [ ] **Step 1: adicionar tipo `code` em `types/canvas.ts`**:
```typescript
export interface CodeNode extends BaseCanvasNode {
  kind: "code";
  filePath: string;
  /** Tamanho do painel de métricas (px, lateral direita). */
  metricsPanelWidth?: number;
}
```
Adicionar `"code"` no `NodeKind` union. Adicionar `CodeNode` no `CanvasNode` union. Adicionar campos relevantes em `CanvasNodePatch`.

- [ ] **Step 2: criar `lib/code-client.ts`**:
```typescript
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CodeMetrics } from "@/types/code";

export async function codeOpen(path: string): Promise<CodeMetrics> {
  return invoke<CodeMetrics>("code_open", { path });
}
export async function codeSave(path: string, content: string): Promise<void> {
  return invoke<void>("code_save", { path, content });
}
export async function codeMetrics(path: string, source: string): Promise<CodeMetrics> {
  return invoke<CodeMetrics>("code_metrics", { path, source });
}
export async function debugRequest(payload: DebugPayload): Promise<string> {
  return invoke<string>("debug_request", { payload });
}
export interface DebugPayload {
  code_node_id: string;
  file_path: string;
  function_name?: string;
  metrics_snapshot?: CodeMetrics;
  error_text?: string;
  diff_text?: string;
}
export async function onCodeChanged(cb: (path: string) => void): Promise<() => void> {
  const un = await listen<string>("code://changed", (e) => cb(e.payload));
  return () => { un(); };
}
```

- [ ] **Step 3: criar `components/nodes/CodeNode.tsx`** — body via Ollama (frontend):
  - `dynamic import("@monaco-editor/react")` — `const MonacoEditor = lazy(() => import("@monaco-editor/react").then(m => m.default))`.
  - State: `source`, `metrics`, `loading`.
  - `useEffect` pra `codeOpen(filePath)` on mount.
  - `useEffect` com debounce 500ms → `codeMetrics(filePath, source)` on edit.
  - Monaco `onChange` seta `source`.
  - Painel lateral: lista de `FunctionMetrics` com barras coloridas por severity. Clique numa função → scroll Monaco pra linha.
  - Botão "Debug" no header → chama `debugRequest({ code_node_id: id, file_path, metrics_snapshot: metrics })`.
  - **⚠️ Floors inativos ficam `display:none`** (é o que mantém o Orquestrador montado — ver `project_orchestrator-dock-behavior`). Monaco renderiza 0×0 em container oculto e NÃO se ajusta sozinho ao reexibir. Guardar a ref do editor (`onMount`) e chamar `editor.layout()` quando o node voltar a ficar visível — detectar via `ResizeObserver` no container (dispara quando sai do `display:none`) ou via `IntersectionObserver`. Sem isso o editor aparece quebrado ao trocar de floor.

- [ ] **Step 4: registrar em `FloorCanvas.tsx`** — importar `CodeNode` e adicionar `code: CodeNode` no `nodeTypes`. Adicionar cor no `MINIMAP_COLORS` (ex: `code: "rgb(96, 165, 250)"`).

- [ ] **Step 5: suporte no `canvas-store.ts`** — função `addCodeNode(filePath: string, position)` que cria `CodeNode` com `kind: "code"`, `filePath`, `size: { width: 800, height: 600 }`.

- [ ] **Step 6: instalar dep** — `npm install @monaco-editor/react` na raiz do monorepo (workspace).

- [ ] **Step 7: typecheck** — Run: `npm run typecheck` · Expected: PASS.

- [ ] **Step 8: commit** — `feat(code): CodeNode no canvas (Monaco + painel de métricas)`.

---

### Task 13: Frontend — `debug-bus.ts` (event bus listener)

**Files:**
- Create: `apps/desktop/src/lib/debug-bus.ts`
- Modify: `apps/desktop/src/components/CanvasToolbar.tsx` (adicionar botão "Add Code Node" que abre file picker)
- Test: `npm run typecheck`

> Contrato: `debug-bus.ts` exporta `useDebugBus()` hook que escuta `debug://request` (do CodeNode) e `debug://response` (do DebuggerAgent). Quando chega `debug://request`, abre um novo TerminalNode com role "debugger" (ou reusa existente) e envia o prompt. Quando chega `debug://response`, mostra diff no DiffViewerModal existente pra aprovação.

- [ ] **Step 1: criar `lib/debug-bus.ts`** — body via Ollama:
  - `listen<DebugPayload>("debug://request")` → `addTerminal({ command: "claude", args: role "debugger", cwd: projectRoot })` + escrever prompt no PTY.
  - `listen<FixProposal>("debug://response")` → abrir `DiffViewerModal` com diff.
  - `useDebugBus()` retorna `{ activeRequests: DebugPayload[], lastFix: FixProposal | null }`.

- [ ] **Step 2: adicionar botão no `CanvasToolbar`** — "Add Code Node" que abre `tauri-plugin-dialog` file picker → `addCodeNode(path, defaultPosition)`.

- [ ] **Step 3: typecheck** — Run: `npm run typecheck` · Expected: PASS.

- [ ] **Step 4: commit** — `feat(debug): event bus CodeNode ↔ DebuggerAgent + botão Add Code Node`.

---

### Task 14: Integração end-to-end + regression guard

**Files:**
- Modify: `apps/desktop/src-tauri/src/lib.rs` (garantir que `SerenaPool` e state estão registrados)
- Test: smoke manual no app + `cargo test -p omnirift` completo + `npm run typecheck`

- [ ] **Step 1: build completo** — Run: `cd apps/desktop/src-tauri && cargo build && cd ../../ && npm run typecheck` · Expected: PASS.

- [ ] **Step 2: todos os testes** — Run: `cargo test -p omnirift` · Expected: PASS (incl. **TODOS os testes atuais** — 59 hoje: Fase 8 + review + keychain — regression guard, não só os novos).

- [ ] **Step 3: smoke manual** — Abrir app (`npm run tauri:dev`), adicionar CodeNode via toolbar, abrir um `.rs` do próprio projeto, verificar métricas aparecem, clicar "Debug", verificar DebuggerAgent spawn com Serena.

- [ ] **Step 4: commit final** — `feat(code): Fase 9 completa — CodeNode + Debug IA + métricas nativas`.

---

## Self-review (cobertura vs spec §1–§11)

- [x] CodeNode no canvas (Monaco) → Task 12
- [x] Métricas nativas (Cyclomatic + Cognitive + Halstead + MI) → Tasks 2-6
- [x] DebuggerAgent com Serena + MemoryProvider → Tasks 9-11, 13
- [x] Boas práticas (thresholds configuráveis) → Task 6 (thresholds.rs) + Task 12 (painel visual)
- [x] Serena pooling (teto 3, timeout 5min) → Task 9
- [x] Event bus (não PTY pipe) → Tasks 11, 13
- [x] Debug routine direto no CodeNode (sem acoplar Fase 6) → Task 11 (sem Routine)
- [x] Sem regressão Fase 8 → Task 14 (regression guard)
- NPath Complexity → fora da v1 (spec §10)
- Integração com Routines → fora (spec §10)
- Diff visual inline → reusar `DiffViewerModal` se fizer sentido (Task 13)

## Fora de escopo deste plano

NPath Complexity, integração com Routines da Fase 6, auto-aplicar fixes sem aprovação, editor multi-cursor avançado, grammars além de Rust/TS/JS/Python (go/java/c# → Fase 2 do CodeNode), diff visual inline custom (reusar DiffViewerModal existente se fizer sentido).
