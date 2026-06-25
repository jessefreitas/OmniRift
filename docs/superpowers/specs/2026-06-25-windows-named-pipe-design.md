# Windows named-pipe (CLI no Windows) — Design

> Status: active · 2026-06-25. Fecha o gap Windows do #8 (socket RPC local). Branch feat/windows-named-pipe.
> Hoje: socket.rs/client.rs têm `#[cfg(unix)]` (UnixStream) + stub `#[cfg(windows)]` "fase 2". O relay WS
> (#9) já é cross-platform — isto é SÓ o transporte LOCAL (CLI ↔ app) no Windows.

**Goal:** `omnirift status/agents/snapshot/spawn/send/kill` funcionar no Windows, via **named pipe**
(`\\.\pipe\omnirift-<id>`) no lugar do socket Unix. Paridade do #8/#8B/#8-fase2 no Windows.

## Arquitetura (aditivo, `#[cfg(windows)]` — Linux intocado)
1. **`rpc/socket.rs` (server)**: `#[cfg(windows)] spawn_listener(...)` via `tokio::net::windows::named_pipe`
   (`ServerOptions::new().create(pipe_name)`): accept-loop que, a cada conexão, **recria** a próxima
   instância do pipe (padrão named-pipe) e trata a conexão no mesmo framing por-linha (`\n`): lê frame →
   valida token (constant-time, igual Unix) → dispatch → escreve resp. `tauri::async_runtime::spawn`
   (NUNCA tokio::spawn). `pipe_name()` = `\\.\pipe\omnirift-<token8 ou pid>` (único por sessão).
2. **`rpc/metadata.rs`**: `socket_path` (String) passa a guardar o **nome do pipe** no Windows (o campo já
   é genérico). `#[cfg(windows)]`: sem chmod 0600 (não existe) — proteção = ACL default do pipe (dono) +
   o token. (ACL restritiva explícita = nota de hardening.) Mantém o token + a remoção no shutdown.
3. **`cli/src/client.rs` (cliente)**: `#[cfg(windows)] send_frame(pipe_name, frame)` — abre o named pipe
   como arquivo (`OpenOptions::new().read(true).write(true).open(pipe_name)`; named pipe Windows é
   file-like) → write frame+`\n` → read 1 linha. Mantém timeouts/teto de resposta (igual o Unix). CLI
   segue sync (sem tokio). Erro claro se o app não está rodando (pipe inexistente).

## Decisões
1. Named pipe via tokio no server (ServerOptions) + std File no cliente (CLI sync). 2. Proteção = ACL
   default (dono) + token; ACL explícita restritiva = hardening futuro. 3. Aditivo: Linux byte-idêntico.
4. `socket_path` reusado pro pipe name (sem mudar o schema da metadata). 5. CLI volta a ser checada no
   Windows: confirmar compilação Windows do `-p omnirift-cli` (cargo-xwin), já que `default-members=["."]`
   a tira do check default — OU rodar o xwin com `-p omnirift-cli` explícito.

## Testing
- Linux NÃO regride: `cargo test` (374) + `cargo test -p omnirift-cli` (79) verdes (o código Windows é
  `#[cfg(windows)]`, inerte no Linux). Testes puros possíveis: `pipe_name()` formata `\\.\pipe\omnirift-…`.
- **Windows**: `cargo xwin check --target x86_64-pc-windows-msvc` (app — coberto pela CI windows-cross) +
  `... -p omnirift-cli` (CLI — fora do default-members, rodar explícito). Se cargo-xwin indisponível,
  garantir cfg-gating correto + marcar verificação manual no Windows (Jesse).
- Boot-test real só no Windows (Jesse): app sobe, `omnirift status` responde pelo pipe.
- GLM 5.2 audita (foco: validação de token igual ao Unix, recriação de instância do pipe sem leak, framing).
