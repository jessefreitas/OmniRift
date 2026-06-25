# Terminal backend-owned (emulador VT no Rust) — Design

> Status: **active** · 2026-06-25. ref P0 #2. Aprovado A+B+C pelo Jesse: (A) crate
> `alacritty_terminal`, (B) MVP sem persistência cold-restart, (C) migração aditiva.
> Fonte: `docs/research/ref-re/02-terminal.md` (RE do ref).

**Problema:** hoje cada `@xterm/xterm` no canvas é **dono** do seu scrollback; o PTY Rust
(`portable-pty` + `DashMap`) só faz pipe de bytes. Quando o nó fica oculto (fora do viewport
ou janela minimizada), o WebKit throttla os timers mas o PTY **continua escrevendo** — o renderer
retém cada byte oculto até o xterm parsear → um agente barulhento em loop pinniza MB e **crasha**.
Abrir 8 agentes + minimizar = crash garantido.

**Solução:** inverter a posse. Um **emulador VT headless no backend Rust** vira a fonte da verdade;
o renderer vira **view descartável e capada** que pode dropar bytes ocultos e re-hidratar via snapshot.

## Arquitetura (MVP)
1. **`pty/emulator.rs` (NOVO)** — por sessão, um `alacritty_terminal::Term` (grid + scrollback
   **bounded 10k**). Cada byte do PTY passa por um `vte`/`alacritty` parser → atualiza o grid,
   ANTES de emitir pro front. **NÃO responde queries** (DA1/DSR/OSC10-11) — só o xterm do front
   responde (senão duplica a resposta na stdin do shell — ponto fino do RE). `seq: u64` monotônico
   por sessão (incrementa a cada chunk pintado).
2. **`manager.rs`** — o read-loop existente, além de `emit("pty://data")`, alimenta o emulador da
   sessão (`emulator.feed(bytes)` + `seq += 1`). Aditivo: o caminho ao vivo do foreground NÃO muda.
3. **Snapshot por IPC** — `pty_snapshot(session_id) -> PtySnapshot { data: String, cols, rows, seq }`.
   `data` = grid+scrollback serializado em ANSI (re-hidrata modos: alt-screen/mouse + dump SGR célula
   a célula). **A parte cara**: alacritty NÃO tem `addon-serialize` como o xterm → escrever o walk do
   grid emitindo SGR (`serialize.rs`). Cap do snapshot (ex.: 2 MB / 10k linhas).
4. **Front vira view** (`useTerminalSession` + `TerminalNode`):
   - **Output scheduler**: fila por terminal. Foreground (nó visível) escreve ao vivo. Background
     (nó fora do viewport / janela oculta) enfileira com **cap (2 MB)**; estourou → **dropa + marca
     stale**. (Reusa o IntersectionObserver / `inViewport` que o TerminalNode já tem.)
   - **Snapshot-replay**: ao voltar a visível (ou se stale) → `pty_snapshot` → `term.reset()` →
     escreve `data` → retoma os writes ao vivo **dedupados por seq** (descarta chunks com `seq` ≤ o do
     snapshot — mata o "scrollback dobrado").

## Componentes / arquivos
- `src-tauri/src/pty/emulator.rs` (NOVO): `struct TermEmulator { term, parser, seq }` + `feed()`,
  `snapshot(scrollback_rows) -> PtySnapshot`, `resize()`. + `serialize.rs` (grid→ANSI) ou inline.
- `src-tauri/src/pty/manager.rs`: mapa `emulators: DashMap<SessionId, Mutex<TermEmulator>>`; read-loop
  alimenta; `pty_resize` redimensiona o emulador também.
- `src-tauri/src/commands/pty.rs`: comando `pty_snapshot`. Wire no lib.rs.
- `src/hooks/useTerminalSession.ts`: scheduler (fila+cap+drop+stale) + replay guardado por seq.
- `src/components/nodes/TerminalNode.tsx`: usa `inViewport`/visibilidade pra foreground vs background.
- Deps: `alacritty_terminal` (+ `vte` se preciso) no Cargo.toml.

## Decisões (A+B+C aprovadas)
- **A:** `alacritty_terminal` (modelo de grid+scrollback pronto) — não `vte` puro (teria que construir o grid).
- **B:** MVP **sem** persistência cold-restart (checkpoint+log) nem o restore-scheduler 1-por-frame — fase 2.
- **C:** **aditivo** — emulador roda ao lado; o foreground ao vivo é intocado; snapshot só no
  retorno-de-oculto / overflow. Se o emulador/snapshot falhar, degrada pro comportamento atual.

## Fora do MVP (fase 2+)
Persistência através de restart (checkpoint.json + output.log byte-exato → cold-restore);
hidden-output-restore-scheduler (replay 1-por-frame de nós inativos); seed mobile (cap 1000 linhas);
hyperlinks OSC8.

## Testing
- Rust: `feed` + `snapshot` round-trip (escreve "foo\\nbar" → snapshot contém foo/bar); scrollback
  bounded (escreve 20k linhas → snapshot ≤ 10k); alt-screen força scrollback 0; seq monotônico;
  NÃO emite resposta a query (feed de DA1 não produz bytes de volta). Serializer: SGR de cor/bold
  sobrevive ao round-trip.
- TS: scheduler dropa + marca stale ao estourar o cap; replay dedupa por seq (chunk com seq antigo
  é descartado).
- **Validação real (boot):** abrir N agentes barulhentos + minimizar a janela → sem crash; voltar →
  scrollback íntegro (não dobrado). É o critério de aceite do P0 #2.
