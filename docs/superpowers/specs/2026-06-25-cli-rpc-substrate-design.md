# CLI + registro RPC (substrato) — Design do MVP

> Status: active · 2026-06-25. ref #8 (RE docs/research/ref-re/05-cli-rpc.md). Substrato do mobile (#9).
> Parte do batch ref grandes (branch feat/terminal-backend-owned, sem build até #10).

**Goal:** um **registro RPC central em Rust** dentro do app Tauri — params validados (serde) + contexto
injetado — exposto por um **socket local** (Unix/named-pipe), e um **CLI `omnirift`** fino que descobre o
app rodando e chama métodos. Mesmo contrato servirá o mobile (#9, WebSocket) depois.

## Arquitetura (MVP)
1. **RPC core** `src-tauri/src/rpc/` (NOVO): `define_method(name, handler)` onde handler é
   `fn(params: serde_json::Value, ctx: &RpcContext) -> Result<serde_json::Value, RpcError>`.
   `Registry` (HashMap, rejeita nome duplicado). `RpcContext` injeta acesso ao estado do app
   (AppHandle / PtyManager / AgentStateMap) pros handlers. Envelope: req `{id, token, method, params}`
   → resp `{id, ok, result|error}` (linha JSON `\n`-delimitada).
2. **Transporte local** `rpc/socket.rs`: listener Unix socket (`$XDG_RUNTIME_DIR/omnirift.sock` ou
   `~/.omnirift/run/omnirift.sock`; named-pipe no Windows) iniciado no `setup()` do Tauri
   (`tauri::async_runtime::spawn`, NÃO tokio::spawn). Cada conexão: lê frame → valida token →
   dispatcher → escreve resp. **Auth:** token aleatório por sessão.
3. **Metadata** `rpc/metadata.rs`: ao subir o socket, grava `~/.omnirift/runtime.json`
   `{socket_path, token, pid, version}` (perm 600) pro CLI descobrir. Remove no shutdown.
4. **Métodos MVP** `rpc/methods.rs`: `status` (versão + nº agentes/floors), `agents.list`
   (labels + estado via AgentStateMap), `pty.snapshot` (reusa o emulador do #6 → {data,seq}).
5. **CLI bin** `src-tauri/src/bin/omnirift-cli.rs` (ou crate `cli/` no workspace): parse argv →
   lê runtime.json → conecta o socket → envia `{method, params, token}` → imprime (`--json` cru
   ou texto). Specs declarativas (nome/usage/flags → help+validação DRY) + handlers finos.
   Comandos MVP: `omnirift status`, `omnirift agents`, `omnirift snapshot <label>`.

## Decomposição (2 agentes)
- **A (backend):** rpc/ core + socket + metadata + 3 métodos + wire no lib.rs/setup. cargo test
  (registry rejeita dup; dispatcher valida params; envelope round-trip; metadata escreve/lê).
- **B (CLI bin):** depende do envelope do A. bin omnirift-cli: specs/handlers/cliente-socket +
  descoberta via runtime.json. teste do parse de args + (se der) e2e contra um socket mock.

## Decisões
1. Socket local primeiro (mobile WS é #9, reusa o Registry/dispatcher). 2. Token por sessão
   (segurança: só o usuário local). 3. Serde valida params (1 lugar), CLI é casca fina. 4. RPC core
   separado do `#[command]` do Tauri (renderer confiável não passa pelo dispatcher de fio — mas reusa
   os métodos). 5. Métodos MVP read-only + snapshot; mutações (spawn/kill via RPC) = fase 2.

## Testing
- cargo: registry dup rejeitada; dispatch valida params (erro claro); envelope serde round-trip;
  metadata round-trip; método status retorna versão. CLI: parse de argv + help das specs.
- Boot-test final (#10): `omnirift status` contra o app rodando devolve os agentes.
- GLM 5.2 audita o diff de cada agente antes do commit.
