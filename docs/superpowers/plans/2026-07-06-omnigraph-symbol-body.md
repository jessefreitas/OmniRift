# OmniGraph — corpo do símbolo sob demanda (Fase 2 do chunker) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ao clicar num símbolo (god node / top membro) de um nó de comunidade do OmniGraph, mostrar o **corpo** daquele símbolo (o código da função/classe) num painel read-only, chunkado sob demanda pelo `chunk_code` da Fase 1.

**Architecture:** Backend Tauri puro-leitura `graph_node_body(source_file, symbol) -> Option<SymbolBody>` — `ChunkLang::from_path` → `read_to_string` → `chunk_code` → casa por símbolo (exato → qualificado → contains); nunca paniqueia, retorna `Option`. A lógica de casamento vive num helper puro `find_symbol_body(source, lang, symbol)` testável sem I/O. No frontend, o importer do grafo passa a preservar um mapa `symbolFiles` (label→source_file) por comunidade (só pros símbolos visíveis: god nodes + top membros), a `CommunityNode` torna esses símbolos clicáveis e um `SymbolBodyModal` chama o comando e exibe o corpo. Gated por feature flag `omnigraph-symbol-body` (default true, stable).

**Tech Stack:** Rust (Tauri 2, serde, tree-sitter via `chunk_code`, `tempfile` dev-dep), React 19 + TS, `@tauri-apps/api/core` invoke, zustand v5.

---

## File Structure

**Backend (Rust):**
- Modify `apps/desktop/src-tauri/src/commands/omnigraph.rs` — nova struct `SymbolBody`, helper puro `find_symbol_body`, comando `graph_node_body`, testes no `mod tests` existente.
- Modify `apps/desktop/src-tauri/src/lib.rs` — importar `graph_node_body` do `commands::omnigraph` (linha ~107) e registrar no `invoke_handler` (linha ~381, junto dos demais `omnigraph_*`).

**Frontend (TS/React):**
- Modify `apps/desktop/src/types/canvas.ts` — campo `symbolFiles?: Record<string,string>` em `CommunityNode`.
- Modify `apps/desktop/src/lib/omnigraph-graph.ts` — popular `symbolFiles` ao montar cada bucket de comunidade (union de god+top).
- Modify `apps/desktop/src/lib/pipeline-client.ts` — wrapper `graphNodeBody(sourceFile, symbol)`.
- Create `apps/desktop/src/components/SymbolBodyModal.tsx` — painel read-only (createPortal + `<pre>`), header `symbol` + `startLine–endLine`, "corpo indisponível" no `null`.
- Modify `apps/desktop/src/components/nodes/CommunityNode.tsx` — god nodes + top membros viram botões clicáveis (quando há source_file); abre o `SymbolBodyModal`. Gated por `useFlag("omnigraph-symbol-body")`.
- Modify `apps/desktop/src/lib/feature-flags.ts` — registra a flag `omnigraph-symbol-body` (default true, stage stable).

**Serialização:** `SymbolBody` usa `#[serde(rename_all = "camelCase")]` (convenção do arquivo) → JS recebe `{ symbol, kind, startLine, endLine, text }`.

---

## Task 1: Backend — helper puro `find_symbol_body` + casamento por símbolo

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/omnigraph.rs` (adicionar struct + helper perto do fim, antes do `#[cfg(test)]` na linha ~1210)
- Test: `apps/desktop/src-tauri/src/commands/omnigraph.rs` (`mod tests`, linha ~1211)

- [ ] **Step 1: Write the failing tests**

No `mod tests` de `omnigraph.rs`, adicionar (usa `super::*`, já presente no módulo):

```rust
    // ── Fase 2: corpo do símbolo sob demanda ──────────────────────────────
    const FIXTURE_RS: &str = "fn alpha() {\n    let a = 1;\n}\n\nfn beta() {\n    let b = 2;\n}\n";

    #[test]
    fn symbol_body_exact_match() {
        let body = find_symbol_body(FIXTURE_RS, ChunkLang::Rust, "alpha").unwrap();
        assert_eq!(body.symbol, "alpha");
        assert!(body.text.contains("alpha"));
        assert!(!body.text.contains("beta"), "não deve vazar o corpo do beta");
        assert!(body.start_line >= 1);
        assert!(body.end_line >= body.start_line);
    }

    #[test]
    fn symbol_body_qualified_name_matches_last_segment() {
        let body = find_symbol_body(FIXTURE_RS, ChunkLang::Rust, "modx::alpha").unwrap();
        assert_eq!(body.symbol, "alpha");
    }

    #[test]
    fn symbol_body_unknown_symbol_is_none() {
        assert!(find_symbol_body(FIXTURE_RS, ChunkLang::Rust, "zzz").is_none());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib symbol_body 2>&1 | tail -20`
Expected: FAIL — `cannot find function find_symbol_body` / `SymbolBody`.

- [ ] **Step 3: Write the struct + pure helper**

Adicionar em `omnigraph.rs`, logo antes do `#[cfg(test)]` (linha ~1210). Usa `crate::code::chunk::{chunk_code, ChunkLang, ChunkOpts, ChunkKind}`:

```rust
use crate::code::chunk::{chunk_code, ChunkKind, ChunkLang, ChunkOpts};

/// Corpo de um símbolo (função/classe/método) devolvido ao clicar num nó do OmniGraph.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SymbolBody {
    pub symbol: String,
    pub kind: String,
    pub start_line: usize,
    pub end_line: usize,
    pub text: String,
}

/// Rótulo textual do `ChunkKind` (o front só exibe).
fn kind_label(k: ChunkKind) -> &'static str {
    match k {
        ChunkKind::Function => "Function",
        ChunkKind::Class => "Class",
        ChunkKind::Method => "Method",
        ChunkKind::Block => "Block",
        ChunkKind::Fallback => "Fallback",
    }
}

/// Último segmento de um nome possivelmente qualificado (`mod::alpha` → `alpha`, `a.b` → `b`).
fn last_segment(sym: &str) -> &str {
    sym.rsplit(|c| c == ':' || c == '.' || c == '/')
        .find(|s| !s.is_empty())
        .unwrap_or(sym)
}

/// NÚCLEO PURO (sem I/O): dado o fonte já lido + a linguagem, casa o `symbol` a um chunk.
/// Ordem: (a) símbolo exato → (b) qualificado (ends_with OU último segmento) → (c) contains.
pub fn find_symbol_body(source: &str, lang: ChunkLang, symbol: &str) -> Option<SymbolBody> {
    let chunks = chunk_code(source, lang, &ChunkOpts::default());
    let mk = |c: &crate::code::chunk::Chunk, sym: &str| SymbolBody {
        symbol: sym.to_string(),
        kind: kind_label(c.kind).to_string(),
        start_line: c.start_line,
        end_line: c.end_line,
        text: c.text.clone(),
    };
    // (a) exato
    if let Some(c) = chunks.iter().find(|c| c.symbol.as_deref() == Some(symbol)) {
        return Some(mk(c, c.symbol.as_deref().unwrap()));
    }
    // (b) qualificado: o symbol do grafo pode vir como `mod::alpha`
    let tail = last_segment(symbol);
    if let Some(c) = chunks.iter().find(|c| {
        c.symbol
            .as_deref()
            .map(|cs| symbol.ends_with(cs) || cs == tail)
            .unwrap_or(false)
    }) {
        return Some(mk(c, c.symbol.as_deref().unwrap()));
    }
    // (c) último recurso: o texto contém o símbolo
    if let Some(c) = chunks.iter().find(|c| c.text.contains(symbol)) {
        let sym = c.symbol.clone().unwrap_or_else(|| symbol.to_string());
        return Some(mk(c, &sym));
    }
    None
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib symbol_body 2>&1 | tail -20`
Expected: PASS — 3 passed.

- [ ] **Step 5: Commit**

```bash
cd /home/skycracker/Downloads/OmniRift
git add apps/desktop/src-tauri/src/commands/omnigraph.rs
git commit -m "feat(omnigraph): find_symbol_body — casa símbolo→corpo via chunk_code (Fase 2)"
```

---

## Task 2: Backend — comando Tauri `graph_node_body` (I/O + registro)

**Files:**
- Modify: `apps/desktop/src-tauri/src/commands/omnigraph.rs` (comando após o helper + 3 testes de I/O)
- Modify: `apps/desktop/src-tauri/src/lib.rs:107` (import) e `:381` (invoke_handler)
- Test: `apps/desktop/src-tauri/src/commands/omnigraph.rs` (`mod tests`)

- [ ] **Step 1: Write the failing tests**

No `mod tests`, adicionar (usa `tempfile`, já dev-dep):

```rust
    #[test]
    fn graph_node_body_reads_real_file() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("m.rs");
        std::fs::write(&file, FIXTURE_RS).unwrap();
        let body =
            graph_node_body(file.to_string_lossy().into_owned(), "alpha".into()).unwrap();
        assert_eq!(body.symbol, "alpha");
        assert!(body.text.contains("alpha"));
    }

    #[test]
    fn graph_node_body_unsupported_lang_is_none() {
        assert!(graph_node_body("/tmp/whatever.bin".into(), "a".into()).is_none());
    }

    #[test]
    fn graph_node_body_missing_file_is_none() {
        assert!(graph_node_body("/nao/existe/aqui.rs".into(), "a".into()).is_none());
    }
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd apps/desktop/src-tauri && cargo test --lib graph_node_body 2>&1 | tail -20`
Expected: FAIL — `cannot find function graph_node_body`.

- [ ] **Step 3: Write the command**

Adicionar logo após `find_symbol_body` em `omnigraph.rs`:

```rust
/// Corpo do símbolo `symbol` no arquivo `source_file`, chunkado sob demanda.
/// Puro-leitura, sem estado do grafo: o front passa o `source_file` + `label` que já tem.
/// Nunca paniqueia — `None` cobre lang não suportada, arquivo ausente e símbolo não localizado.
#[tauri::command]
pub fn graph_node_body(source_file: String, symbol: String) -> Option<SymbolBody> {
    let lang = ChunkLang::from_path(std::path::Path::new(&source_file))?;
    let source = std::fs::read_to_string(&source_file).ok()?;
    find_symbol_body(&source, lang, &symbol)
}
```

- [ ] **Step 4: Register in `lib.rs`**

Em `apps/desktop/src-tauri/src/lib.rs`, no bloco `use commands::omnigraph::{ ... }` (linha ~107), adicionar `graph_node_body`:

```rust
use commands::omnigraph::{
    graph_node_body, omnigraph_available, omnigraph_diff, omnigraph_graph_json, omnigraph_impact,
    omnigraph_list_snapshots, omnigraph_rebuild, omnigraph_report, omnigraph_report_full,
    omnigraph_snapshot_graph,
};
```

E no `invoke_handler`, logo após `omnigraph_diff,` (linha ~381):

```rust
            omnigraph_diff,
            graph_node_body,
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd apps/desktop/src-tauri && cargo test --lib graph_node_body 2>&1 | tail -20`
Expected: PASS — 3 passed.

- [ ] **Step 6: Regression guard — suíte Rust inteira**

Run: `cd apps/desktop/src-tauri && cargo test --lib 2>&1 | tail -8`
Expected: `test result: ok.` com contagem ≥ 559 (553 base + 6 novos), 0 failed.

- [ ] **Step 7: Commit**

```bash
cd /home/skycracker/Downloads/OmniRift
git add apps/desktop/src-tauri/src/commands/omnigraph.rs apps/desktop/src-tauri/src/lib.rs
git commit -m "feat(omnigraph): comando graph_node_body + registro no invoke_handler (Fase 2)"
```

---

## Task 3: Frontend — preservar `symbolFiles` (label→source_file) no importer

**Files:**
- Modify: `apps/desktop/src/types/canvas.ts` (campo em `CommunityNode`)
- Modify: `apps/desktop/src/lib/omnigraph-graph.ts` (popular no bucket)

- [ ] **Step 1: Add the type field**

Em `apps/desktop/src/types/canvas.ts`, na interface `CommunityNode` (após `sourceFiles?`, ~linha 347), adicionar:

```ts
  /** Mapa símbolo→arquivo-fonte SÓ pros símbolos visíveis (god nodes + top membros). É o elo
   *  que a Fase 2 usa: clicar num símbolo → graph_node_body(symbolFiles[symbol], symbol). */
  symbolFiles?: Record<string, string>;
```

- [ ] **Step 2: Populate in the importer**

Em `apps/desktop/src/lib/omnigraph-graph.ts`, o bucket é montado com `members` e `files`. Localizar onde `god` e `top` são calculados e o objeto do `CommunityNode` é criado (o bloco `kind: "community", ... godNodes: god, topMembers: top`). ANTES de criar o objeto, construir o mapa a partir dos membros crus da comunidade:

```ts
      // symbolFiles: label→source_file só pros símbolos MOSTRADOS (god ∪ top) — cap ≤ 20 por nó.
      const shown = new Set<string>([...god, ...top]);
      const symbolFiles: Record<string, string> = {};
      for (const n of b.members) {
        const lbl = nodeLabel(n);
        if (n.source_file && shown.has(lbl) && !(lbl in symbolFiles)) {
          symbolFiles[lbl] = n.source_file;
        }
      }
```

E no objeto do nó, junto de `sourceFiles`:

```ts
      symbolFiles: Object.keys(symbolFiles).length ? symbolFiles : undefined,
```

> Nota de verificação: confirmar os nomes reais ao editar — o bucket é algo como `{ key, name, members, files }` e `nodeLabel(n)` é o helper que gerou `god`/`top`. Ajustar `b.members`/`nodeLabel` aos identificadores reais do arquivo.

- [ ] **Step 3: Typecheck**

Run: `cd /home/skycracker/Downloads/OmniRift && npx tsc -b apps/desktop/tsconfig.json 2>&1 | tail -15`
Expected: sem erros novos referentes a `symbolFiles`/`omnigraph-graph.ts`.

- [ ] **Step 4: Commit**

```bash
cd /home/skycracker/Downloads/OmniRift
git add apps/desktop/src/types/canvas.ts apps/desktop/src/lib/omnigraph-graph.ts
git commit -m "feat(omnigraph): preserva symbolFiles (label→source_file) no import p/ Fase 2"
```

---

## Task 4: Frontend — client wrapper + feature flag

**Files:**
- Modify: `apps/desktop/src/lib/pipeline-client.ts` (wrapper)
- Modify: `apps/desktop/src/lib/feature-flags.ts` (flag)

- [ ] **Step 1: Add the invoke wrapper**

Em `apps/desktop/src/lib/pipeline-client.ts`, após `omnigraphGraphJson` (~linha 177), adicionar:

```ts
/** Corpo de um símbolo devolvido por `graph_node_body` (camelCase — serde rename_all). */
export interface SymbolBody {
  symbol: string;
  kind: string;
  startLine: number;
  endLine: number;
  text: string;
}

/** Corpo do símbolo `symbol` em `sourceFile`, chunkado sob demanda. `null` = corpo indisponível
 *  (lang não suportada, arquivo ausente, símbolo não localizado) — nunca lança. */
export async function graphNodeBody(sourceFile: string, symbol: string): Promise<SymbolBody | null> {
  return (await invoke<SymbolBody | null>("graph_node_body", { sourceFile, symbol })) ?? null;
}
```

> Verificar que `invoke` já está importado no topo do arquivo (`import { invoke } from "@tauri-apps/api/core";`). Se não, adicionar.

- [ ] **Step 2: Register the feature flag**

Em `apps/desktop/src/lib/feature-flags.ts`, no array `FLAGS`, após o bloco `omnigraph-land-gate` (~linha 139), adicionar:

```ts
  {
    key: "omnigraph-symbol-body",
    label: "Corpo do símbolo no OmniGraph",
    description:
      "Clicar num símbolo (god node / top membro) de uma comunidade do grafo abre o CÓDIGO daquela função/classe num painel read-only, fatiado sob demanda. Desligue pra deixar os símbolos como texto puro.",
    default: true,
    stage: "stable",
  },
```

> Verificar o tipo da `key` — se `FlagKey` for uma união literal de strings, adicionar `"omnigraph-symbol-body"` à união também.

- [ ] **Step 3: Typecheck**

Run: `cd /home/skycracker/Downloads/OmniRift && npx tsc -b apps/desktop/tsconfig.json 2>&1 | tail -15`
Expected: sem erros novos.

- [ ] **Step 4: Commit**

```bash
cd /home/skycracker/Downloads/OmniRift
git add apps/desktop/src/lib/pipeline-client.ts apps/desktop/src/lib/feature-flags.ts
git commit -m "feat(omnigraph): wrapper graphNodeBody + flag omnigraph-symbol-body (Fase 2)"
```

---

## Task 5: Frontend — `SymbolBodyModal` (painel read-only)

**Files:**
- Create: `apps/desktop/src/components/SymbolBodyModal.tsx`

- [ ] **Step 1: Create the modal component**

Segue o padrão do `DiffViewerModal` (createPortal + `<pre>`). Conteúdo completo:

```tsx
// src/components/SymbolBodyModal.tsx
//
// OmniGraph F2 — corpo do símbolo sob demanda. Clicar num símbolo (god node / top membro) de
// uma comunidade abre este painel: chama graph_node_body(sourceFile, symbol) e mostra o CÓDIGO
// da função/classe, read-only. null → "corpo indisponível". Reusa o shell do DiffViewerModal.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { FileCode, Loader2, X } from "lucide-react";

import { graphNodeBody, type SymbolBody } from "@/lib/pipeline-client";
import { useT } from "@/lib/i18n";

interface Props {
  sourceFile: string;
  symbol: string;
  onClose: () => void;
}

export function SymbolBodyModal({ sourceFile, symbol, onClose }: Props) {
  const t = useT();
  const [body, setBody] = useState<SymbolBody | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    graphNodeBody(sourceFile, symbol)
      .then((b) => { if (alive) setBody(b); })
      .catch(() => { if (alive) setBody(null); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [sourceFile, symbol]);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[820px] h-[600px] max-w-[95vw] max-h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <FileCode size={15} className="text-brand" />
          <span className="text-sm font-medium text-text font-mono truncate" title={symbol}>{symbol}</span>
          {body && (
            <span className="text-[11px] text-textMuted font-mono shrink-0">
              {t("symbolBody.lines", "linhas")} {body.startLine}–{body.endLine} · {body.kind}
            </span>
          )}
          <div className="flex-1" />
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("symbolBody.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {loading ? (
          <div className="flex-1 flex items-center justify-center">
            <Loader2 size={18} className="animate-spin text-textMuted" />
          </div>
        ) : body ? (
          <div className="flex-1 overflow-auto bg-bg min-w-0">
            <pre className="px-3 py-2 text-[11px] font-mono leading-[1.5] text-text whitespace-pre">{body.text}</pre>
          </div>
        ) : (
          <div className="flex-1 flex items-center justify-center p-6">
            <p className="text-[12px] text-textMuted text-center">
              {t("symbolBody.unavailable", "Corpo indisponível para este nó (arquivo sumiu, linguagem não suportada, ou símbolo não localizado).")}
            </p>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `cd /home/skycracker/Downloads/OmniRift && npx tsc -b apps/desktop/tsconfig.json 2>&1 | tail -15`
Expected: sem erros novos.

- [ ] **Step 3: Commit**

```bash
cd /home/skycracker/Downloads/OmniRift
git add apps/desktop/src/components/SymbolBodyModal.tsx
git commit -m "feat(omnigraph): SymbolBodyModal — painel read-only do corpo do símbolo (Fase 2)"
```

---

## Task 6: Frontend — símbolos clicáveis na `CommunityNode`

**Files:**
- Modify: `apps/desktop/src/components/nodes/CommunityNode.tsx`

- [ ] **Step 1: Wire clicks + modal state**

Em `CommunityNode.tsx`:

1. Imports novos (topo):

```tsx
import { SymbolBodyModal } from "@/components/SymbolBodyModal";
import { useFlag } from "@/lib/feature-flags";
```

2. Dentro de `CommunityNodeImpl`, após os hooks existentes:

```tsx
  const symbolBodyEnabled = useFlag("omnigraph-symbol-body");
  const [openSymbol, setOpenSymbol] = useState<{ symbol: string; sourceFile: string } | null>(null);
  const symbolFiles = data.symbolFiles ?? {};

  function openBody(symbol: string) {
    const sourceFile = symbolFiles[symbol];
    if (sourceFile) setOpenSymbol({ symbol, sourceFile });
  }
```

3. God nodes — o `<span>` do chip (bloco `data.godNodes.map`) vira `<button>` quando clicável:

```tsx
                {data.godNodes.map((g, i) => {
                  const clickable = symbolBodyEnabled && !!symbolFiles[g];
                  return (
                    <button
                      key={`${g}-${i}`}
                      onClick={(e) => { e.stopPropagation(); if (clickable) openBody(g); }}
                      onPointerDown={(e) => e.stopPropagation()}
                      disabled={!clickable}
                      className={cn(
                        "truncate rounded bg-amber-500/15 px-1.5 py-0.5 font-mono text-[10px] text-amber-200",
                        clickable ? "cursor-pointer hover:bg-amber-500/30" : "cursor-default",
                      )}
                      title={clickable ? t("community.viewBody", "Ver o código deste símbolo") : g}
                    >
                      {g}
                    </button>
                  );
                })}
```

4. Top membros — o `<li>` (bloco `data.topMembers.map`) ganha um clique quando há arquivo:

```tsx
            {data.topMembers.map((m, i) => {
              const clickable = symbolBodyEnabled && !!symbolFiles[m];
              return (
                <li
                  key={`${m}-${i}`}
                  onClick={(e) => { if (clickable) { e.stopPropagation(); openBody(m); } }}
                  className={cn(
                    "truncate font-mono text-[10px] text-text/70",
                    clickable && "cursor-pointer hover:text-brand",
                  )}
                  title={clickable ? t("community.viewBody", "Ver o código deste símbolo") : m}
                >
                  {m}
                </li>
              );
            })}
```

5. Envolver o `return` num fragmento `<>…</>` e montar o modal como irmão do card (o modal já usa `createPortal`, não afeta o layout do nó):

```tsx
      {openSymbol && (
        <SymbolBodyModal
          sourceFile={openSymbol.sourceFile}
          symbol={openSymbol.symbol}
          onClose={() => setOpenSymbol(null)}
        />
      )}
```

- [ ] **Step 2: Typecheck (workspace do desktop)**

Run: `cd /home/skycracker/Downloads/OmniRift && npx tsc -b apps/desktop/tsconfig.json 2>&1 | tail -20`
Expected: sem erros.

- [ ] **Step 3: Commit**

```bash
cd /home/skycracker/Downloads/OmniRift
git add apps/desktop/src/components/nodes/CommunityNode.tsx
git commit -m "feat(omnigraph): símbolos clicáveis na CommunityNode → abre corpo (Fase 2)"
```

---

## Task 7: Verificação final — typecheck workspace + suíte Rust

**Files:** nenhum (só validação)

- [ ] **Step 1: Typecheck do workspace inteiro**

Run: `cd /home/skycracker/Downloads/OmniRift && npm run typecheck 2>&1 | tail -20`
Expected: sem erros (ou, se `typecheck` root não cobre `apps/desktop`, rodar também `npx tsc -b apps/desktop/tsconfig.json`).

- [ ] **Step 2: Regression guard — suíte Rust inteira**

Run: `cd /home/skycracker/Downloads/OmniRift/apps/desktop/src-tauri && cargo test --lib 2>&1 | tail -8`
Expected: `test result: ok.` — ≥ 559 passed, 0 failed.

- [ ] **Step 3: Atualizar memória do projeto**

Marcar Fase 2 como implementada em `code-ast-chunker-fase1.md`.

---

## Self-Review (cobertura da spec)

| Requisito da spec | Task |
|---|---|
| Comando `graph_node_body(source_file, symbol) -> Option<SymbolBody>` | Task 2 |
| `SymbolBody{symbol,kind,start_line,end_line,text}` | Task 1 |
| Casa: exato → qualificado (ends_with/último segmento) → contains | Task 1 |
| `from_path` None → None; `read_to_string` Err → None; nunca paniqueia | Task 2 |
| Registrado no `invoke_handler` | Task 2 |
| Front chama ao clicar; `Some`→painel; `None`→"corpo indisponível" | Tasks 5+6 |
| Teste casa exato | Task 1 (`symbol_body_exact_match`) |
| Teste nome qualificado (fallback b) | Task 1 (`symbol_body_qualified_name_matches_last_segment`) |
| Teste símbolo inexistente → None | Task 1 (`symbol_body_unknown_symbol_is_none`) |
| Teste linguagem não suportada → None | Task 2 (`graph_node_body_unsupported_lang_is_none`) |
| Teste arquivo inexistente → None | Task 2 (`graph_node_body_missing_file_is_none`) |

**Gap fechado vs spec:** a spec assumia que o front "já tem source_file por nó". Na verdade o nó importado é uma **bolha de comunidade** com god/top como strings e `sourceFiles` agregado — sem mapa símbolo→arquivo. A Task 3 preenche esse elo (`symbolFiles`), mantendo a assinatura do comando exatamente como especificada.

**Fora de escopo (spec):** enriquecer o grafo inteiro no load; embedding/busca semântica (Fase 3); edição no painel; highlight de linha.
