# Conductor Fase 4a — Roteiro de validação manual (no app rodando)

> Por que manual: o `McpState` precisa de um `tauri::AppHandle`, então um e2e em `cargo test`
> é impraticável — a validação real da camada 4 é dois agentes conversando no app.
> Rode isto no teu PC (que tem as libs GTK; a máquina de sessão não linka o app).

## Pré-requisitos
- Branch `spec/conductor` (já pushada).
- `cargo test -p omnirift marker::` deve passar (parser puro — 5 testes). Confirma o núcleo.
- Build normal: `npm run tauri:dev`.

## Cenário A — agent_status (peek barato, não interrompe)
1. No canvas, suba **2 terminais** e marque ambos como agente MCP (ex.: `Backend` e `DBA`).
2. Coroe um deles como **Orquestrador** (👑).
3. Dê uma tarefa longa ao `DBA` (ex.: "analise o schema e proponha índices").
4. No Orquestrador, peça: **"use a tool agent_status no DBA"**.
5. **Esperado:** volta `estado: working` + as últimas ~8 linhas do DBA — **sem** o DBA ganhar
   um turno novo (ele não para o que faz). Se o DBA travar/reagir, o peek NÃO está barato → bug.

## Cenário B — agent_ask (interrompe, resposta correlacionada) ⭐ o teste central
1. Mesmos 2 agentes.
2. No Orquestrador: **"use agent_ask no DBA perguntando: em uma linha, o que você está fazendo agora?"**
3. **Esperado no PTY do DBA:** aparece `[[CONDUCTOR-ASK from=@orquestrador id=<uuid>]] ...`,
   e o DBA responde `[[CONDUCTOR-REPLY id=<uuid>]] <resposta>` (o preâmbulo o ensinou).
4. **Esperado no Orquestrador:** o `agent_ask` retorna **só a resposta** do DBA (não o scrollback),
   correlacionada ao `id`.
5. **Falhas a caçar:**
   - DBA não emite REPLY → o preâmbulo não chegou no role dele (checar `mcpRoleText` foi injetado).
   - Orquestrador recebe scrollback em vez da resposta → `find_reply`/correlação.
   - Timeout mesmo com o DBA respondendo → o REPLY não casou o `id` (marcador malformado pelo LLM).

## Cenário C — agent_tell (push fire-and-forget)
1. No `Backend`: **"use agent_tell no DBA com a mensagem: terminei a API, pode seguir"**.
2. **Esperado:** retorna `ok` na hora; no próximo turno do DBA, ele **vê** o `[[CONDUCTOR-MSG ...]]`
   e incorpora. Não bloqueia o Backend.

## Cenário D — negociação por claim (o valor real)
1. `Backend` faz (via tool): `claim_acquire` em `src/auth.rs`.
2. `DBA` recebe a tarefa de mexer em `src/auth.rs`.
3. **Esperado:** o DBA (pelo preâmbulo) faz `claim_check` → vê que o Backend tem → usa
   `agent_ask(Backend, "preciso do auth.rs — libera ou espero?")` → Backend responde → sem colisão.
4. Se o DBA editar direto ignorando o claim → o preâmbulo não está sendo seguido (esperado: claim é
   advisory; reforçar no role, ou usar Floors pra isolação dura).

## O que anotar pra fechar a 4a
- [ ] Cenário B fecha o roundtrip (é o que prova a camada 4).
- [ ] Marcadores `[[CONDUCTOR-*]]` aparecem no xterm? (Task 12 = escondê-los — decidir com a tela à vista.)
- [ ] `from` aparece como `@orquestrador` fixo? (Task 7 = identidade real do chamador.)
- [ ] Algum LLM emite REPLY malformado (sem `]]`, id trocado)? Ajustar o parser/preâmbulo.

Manda o resultado do Cenário B que eu fecho Task 7 (identidade real) e Task 12 (esconder marcador)
com base no que a tela mostrou.
