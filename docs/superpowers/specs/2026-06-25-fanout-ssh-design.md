# Fan-out de grupo + SSH (executionHostId) — Design do MVP

> Status: active · 2026-06-25. ref #7 (RE ref-re/03-orchestration.md). Branch feat/terminal-backend-owned
> (batch ref grandes, sem build até #10). Já temos Floors=worktrees + Bloco E (claims). Falta fan-out + SSH.

**Goal:** (1) endereçar GRUPOS de agentes (1 goal → N agentes nos Floors) e (2) rodar agentes numa box
remota via SSH — colapsando local/remoto num único campo **`executionHostId`** (`'local' | 'ssh:<host>'`),
pra o resto do código não ramificar por transporte. RE manda: SSH = subprocess `ssh user@host` simples
(NÃO o relay protocol do ref = overkill); runtime-hosts = fase 2.

## Parte A — executionHostId + SSH execution host
1. **`executionHostId`** (string tagged-union): `local` | `ssh:<encoded-host>`. Rust enum `ExecutionHost`
   + parse/encode (`encodeURIComponent`-equivalente p/ host com `:`/`@`). TS espelha (já há `floorHost()`/
   hostId no Floor — estender). Um lugar só ramifica por kind.
2. **SSH PTY** (`pty/session.rs`): quando o host é `ssh:<user@host>`, o comando do agente nasce embrulhado
   em `ssh -tt -o BatchMode=yes <user@host> -- <cmd>` (PTY remoto via `-tt`; BatchMode evita prompt de
   senha travar — exige key-auth). `portable-pty` roda o `ssh` local; o resto (read-loop, emulador #6,
   detector) é idêntico — o `ssh` é só o "shell" remoto. cwd remoto = o Floor path no host (passado no cmd).
3. **Host registry** mínimo: `~/.omnirift/hosts.json` (lista `{id, label, sshTarget}`) + comandos
   `hosts_list`/`hosts_add`/`hosts_remove`. UI: escolher o host no "novo agente" (dropdown, default local).
4. Segurança: só key-auth (BatchMode), nunca senha no IPC; o sshTarget é o que o usuário configurou.

## Parte B — fan-out de grupo + coordinator
1. **Group addressing** (`mcp/` orquestração, sobre o Bloco E existente): resolver `@all` / `@idle` /
   `@worktree:<floorId>` / `@<role>` → lista de agentes-alvo (match por label/role/floor + estado via
   AgentStateMap). Função pura `resolve_group(addr, agents) -> Vec<SessionId>`.
2. **Fan-out dispatch**: estender a tool MCP de orquestração — `orchestration.send(group, message)` manda
   pra todos os resolvidos; `dispatchSpec` já espalha specs→floors (reusar). 1 goal → N agentes endereçáveis.
3. (fase 2: coordinator DAG completo com heartbeat/decision-gates — MVP é group-send + fan-out do que já existe.)

## Decomposição (2 agentes, áreas disjuntas)
- **A (host/ssh):** `executionHostId` (Rust enum + TS) + SSH PTY no session.rs + hosts.json/comandos. Toca pty/ + types.
- **B (fan-out):** resolve_group + orchestration.send de grupo no mcp/. Toca mcp/ + orchestration. Disjunto de A.

## Decisões
1. SSH = subprocess `ssh -tt` (pular relay protocol). 2. Só key-auth (BatchMode). 3. executionHostId
   adotado já (local/ssh; runtime = fase 2). 4. Fan-out reusa Bloco E/claims/dispatchSpec (não reescreve).
   5. Coordinator DAG completo = fase 2; MVP = group addressing + send.

## Testing
- Rust: parse/encode de executionHostId (round-trip ssh:<host com :/@>); o cmd SSH montado certo
  (`ssh -tt -o BatchMode=yes ... -- cmd`); resolve_group puro (@all/@idle/@worktree/@role → alvos corretos);
  hosts.json round-trip. cargo verde (workspace não regride).
- TS: tsc; o dropdown de host injeta o executionHostId no spawn.
- Boot-test final (#10): spawnar agente local OK; (SSH real depende de uma box — validar o cmd montado).
- GLM 5.2 audita cada diff (foco: injeção no cmd SSH, escape do host, segurança).
