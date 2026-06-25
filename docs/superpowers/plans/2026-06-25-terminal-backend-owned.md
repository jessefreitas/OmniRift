# Terminal backend-owned — Plano de implementação

> Spec: `docs/superpowers/specs/2026-06-25-terminal-backend-owned-design.md` (A+B+C aprovado).
> Ordem por dependência. Começa DEPOIS do v0.1.33 landar (branch nova de `origin/main`).

## Chunk 1 — Backend: emulador + serializador (o coração, mais difícil)
**Files:** `src-tauri/src/pty/emulator.rs` (NEW), `src-tauri/Cargo.toml` (+`alacritty_terminal`).
- `struct TermEmulator { term: Term<()>, parser: ansi::Processor, seq: u64, cols, rows }`.
- `feed(&mut self, bytes: &[u8])` → roda o parser no grid; `seq += 1`. **NÃO** emite resposta a query.
- `snapshot(&self, scrollback_rows: usize) -> PtySnapshot { data, cols, rows, seq }` — walk do grid
  (scrollback + viewport) emitindo SGR (cor fg/bg, bold/italic/underline) + re-hidrata alt-screen.
- `resize(cols, rows)`.
- **Testes (TDD):** feed "foo\nbar" → snapshot contém ambos; 20k linhas → ≤10k (bounded);
  alt-screen → scrollback 0; feed de DA1 (`\x1b[c`) NÃO produz bytes; SGR de cor/bold sobrevive ao
  round-trip (parse o snapshot de volta num 2º emulador → mesma célula).
**Crate decision:** `alacritty_terminal` (Term + Grid + ansi::Processor). Confirmar a API da versão
atual via Context7/docs antes (não chutar nomes de tipo).

## Chunk 2 — Backend: wire no manager + comando snapshot
**Files:** `src-tauri/src/pty/manager.rs`, `src-tauri/src/pty/mod.rs`, `src-tauri/src/commands/pty.rs`, `lib.rs`.
- `manager`: `emulators: DashMap<SessionId, Mutex<TermEmulator>>`; cria no spawn; o read-loop, além do
  `emit("pty://data")`, faz `emulators.get(id).lock().feed(&bytes)`. `pty_resize` redimensiona o emulador.
- `#[tauri::command] pty_snapshot(session_id) -> Result<PtySnapshot,String>` → lock + snapshot(10k). Wire no lib.rs.
- **Aditivo:** se não houver emulador pra a sessão, snapshot retorna erro → o front degrada pro fluxo atual.
- **Testes:** spawn fake → feed via manager → pty_snapshot devolve o conteúdo + seq.

## Chunk 3 — Frontend: scheduler de saída (foreground/background + cap + drop)
**Files:** `src/hooks/useTerminalSession.ts`, `src/components/nodes/TerminalNode.tsx`.
- Fila por terminal. `setActive(visible)` (vem do `inViewport`/visibilidade que o TerminalNode já tem).
- Foreground: escreve ao vivo (como hoje). Background: enfileira; ao passar de `MAX_BG_CHARS` (2 MB) →
  **descarta** o backlog + `stale = true`.
- **Testes (vitest, se houver runner; senão lógica pura testável + assert manual):** estourar o cap →
  dropa + marca stale.

## Chunk 4 — Frontend: snapshot-replay dedupado por seq
**Files:** `src/hooks/useTerminalSession.ts`.
- Ao virar visível com `stale` (ou no mount/reconnect): `pty_snapshot(id)` → `term.reset()` →
  `term.write(data)` → marca `lastSnapshotSeq = seq`. Os chunks ao vivo que chegarem com `seq <=
  lastSnapshotSeq` são **descartados** (anti scrollback-dobrado); os com `seq >` são escritos.
- Fail-open: erro no snapshot → mantém o que tem (não limpa).

## Dispatch
- **Agente A:** Chunk 1 + 2 (backend Rust, cohesivo; cargo test verde). É o mais difícil — confirmar a
  API do `alacritty_terminal` via Context7 antes de codar.
- **Agente B:** Chunk 3 + 4 (frontend; depende do contrato `pty_snapshot` do Chunk 2 — rodar DEPOIS
  do A, ou em paralelo usando o contrato da spec).
- **Auditoria (eu):** cargo test + tsc + **boot-test real** = abrir N agentes barulhentos + minimizar →
  sem crash + scrollback íntegro ao voltar (critério de aceite do P0 #2).

## Critério de aceite
Abrir 8 agentes em loop + minimizar a janela por minutos → **não crasha**; restaurar → scrollback
correto (não dobrado, não perdido). Release próprio (v0.1.34).
