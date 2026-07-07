# OmniGraph — corpo do símbolo sob demanda (Fase 2 do chunker AST) — design

> 2026-07-06. Ao clicar num nó/hub do OmniGraph, mostrar o **corpo** do símbolo (o código
> da função/classe), não só a estrutura. Consome o chunker AST da Fase 1 (`code/chunk.rs`).
> **Lazy**: chunka só o arquivo do nó clicado, na hora — zero custo até o clique.

## Motivação

O OmniGraph mostra a estrutura do código (símbolos, comunidades, hubs/god nodes), mas cada
nó é só um rótulo — pra ver o código do símbolo o usuário sai do grafo e abre o arquivo. A
Fase 1 (`chunk_code`) já sabe fatiar um arquivo em função/classe/método com símbolo + linhas.
A Fase 2 liga os dois: clicar num nó → o corpo daquele símbolo aparece.

**Por que sob demanda:** enriquecer o grafo inteiro no load exigiria re-chunkar todos os
arquivos do repo — caro, e a geração do grafo (engine `graphify`) já satura CPU em repo
grande. Chunkar só o arquivo do nó clicado é barato e casa com o padrão "Mapa do código sob
demanda" já existente no produto.

## Arquitetura

### O que já existe (não muda)

- `GraphNode` (`commands/omnigraph.rs:497`) tem `id`, `label` (o símbolo), `source_file` (o
  arquivo). Vem do `graph.json` gerado pela engine externa. **Não tem linha nem corpo.**
- `chunk_code(source, lang, opts) -> Vec<Chunk>` (`code/chunk.rs`, Fase 1) — `Chunk` tem
  `symbol`, `kind`, `start_line`, `end_line`, `text`.
- O frontend já tem os dados de cada nó (id/label/source_file) ao renderizar o grafo.

### Comando Tauri novo — `graph_node_body`

```rust
#[derive(serde::Serialize)]
pub struct SymbolBody {
    pub symbol: String,
    pub kind: String,        // "Function" | "Class" | "Method" | ...
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

#[tauri::command]
pub fn graph_node_body(source_file: String, symbol: String) -> Option<SymbolBody>;
```

Lógica:
1. `ChunkLang::from_path(&source_file)` → se `None` (linguagem não suportada), retorna `None`.
2. `std::fs::read_to_string(&source_file)` → se `Err` (arquivo sumiu), retorna `None`.
3. `chunk_code(&source, lang, &ChunkOpts::default())`.
4. Casa o chunk pelo símbolo, nesta ordem:
   a. `chunk.symbol == Some(symbol)` (exato);
   b. senão, `symbol.ends_with(chunk_symbol)` OU `chunk_symbol == último segmento de symbol`
      partido por `::`/`.`/`/` (graphify pode qualificar nomes tipo `mod::func`);
   c. senão, `chunk.text.contains(&symbol)` como último recurso (raro).
5. Retorna o primeiro casamento como `SymbolBody`, ou `None` se nada casar.

O comando é **puro leitura**, sem estado do grafo no backend — o frontend passa
`source_file` + `label` que já tem. Registrado no `invoke_handler` como os demais.

### Frontend

Ao clicar num nó/hub do OmniGraph, o frontend chama `invoke("graph_node_body", { sourceFile,
symbol })`. Com o resultado:
- `Some(body)` → mostra o `text` num painel de código (reusa o painel de leitura do OmniGraph
  ou o CodeMonaco existente, read-only), com o header `symbol` + `start_line–end_line`.
- `None` → o painel mostra "corpo indisponível para este nó" (nó sem arquivo, linguagem não
  suportada, ou símbolo não localizado no arquivo).

O ponto exato de integração no frontend (qual componente do grafo, qual painel) é detalhe de
implementação — mapear no plano.

## Fluxo de dados

```
clique no nó (front tem source_file + label)
  → invoke graph_node_body(source_file, symbol)
  → from_path → read_to_string → chunk_code → casa por símbolo
  → Some(SymbolBody{text, linhas, kind}) | None
  → painel mostra o código | "corpo indisponível"
```

## Tratamento de erro — nunca trava

| Situação | Resultado |
|----------|-----------|
| `source_file` de linguagem não suportada | `None` → "corpo indisponível" |
| Arquivo não existe / sem permissão | `None` → "corpo indisponível" |
| Símbolo não casa nenhum chunk | `None` → "corpo indisponível" |
| Nó sem `source_file` (o front nem chama) | painel não abre / desabilitado |

`graph_node_body` nunca paniqueia; retorna `Option`.

## Testes (execução real — cargo test)

- **Casa exato**: fixture `.rs` com `fn alpha(){}` + `fn beta(){}`; `graph_node_body(file,
  "alpha")` → `Some` com `symbol=="alpha"` e `text` contém "alpha".
- **Nome qualificado**: `graph_node_body(file, "modx::alpha")` casa o chunk `alpha` (fallback b).
- **Símbolo inexistente**: `graph_node_body(file, "zzz")` → `None`.
- **Linguagem não suportada**: `graph_node_body("x.bin", "a")` → `None`.
- **Arquivo inexistente**: `graph_node_body("/nao/existe.rs", "a")` → `None`.

## Fora de escopo (Fase 2)

- Enriquecer o grafo inteiro no load (caro; descartado por decisão de design).
- Embedding / busca semântica (é a Fase 3, no daemon OmniFS).
- Edição do corpo no painel (read-only nesta fase).
- Highlight de linha no arquivo aberto (só mostra o texto do chunk).
