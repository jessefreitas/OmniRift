# Plano refinado — Aprender A2/A3/A4 (Fase 9, tutor Socrático)

**Data:** 2026-07-04
**Base:** confronta o plano `2026-07-02-fase9-aprender-execucao.md` com o código real em v0.1.111.
**Status:** A0 ✅ + A1 ✅ (implementado mais enxuto que o plano — ver abaixo). A2/A3/A4 pendentes.

## Realidade do código (o que A1 shippou vs. o plano)

A1 moveu pro Rust só o **contrato puro** (`learn/mod.rs`: `socratic_system()`, `response_leaks_solution()`, 16 testes) — o despacho do LLM ficou no **front** (`lib/learn.ts` → `llm_via_cli`). Consequência pra quem pega A2/A3:
- **NÃO existem** `learn/session.rs`, `learn_step_ask`, `learn_tracks_list`, `learn_profile_get/update` (o plano A2 os assumia). Confirmado: só `learn/mod.rs`.
- A máquina de nível de dica vive no **React** (`CompanionModal.tsx`), não no Rust.
- Progresso (trackId + exIdx) está em **localStorage** (`omnirift-learn-track`, `omnirift-learn-ex-idx`), não no MemoryProvider.

## Recomendação de ordem (revisada): **A3 antes de A2**

O explorador concluiu — e concordo — que **A3 (grounding) é a fatia de VALOR**, A2 é durabilidade:

- **A3 = correção de guardrail, não feature nova.** A spec põe "ensino ancorado (proibido alucinar)" como NÃO-NEGOCIÁVEL. Hoje o tutor roda `llm_via_cli` **sem nenhuma tool MCP** → pode alucinar API/doc pra um iniciante que não detecta o erro. A0/A1 entregaram o scaffolding; falta a outra metade da promessa.
- **A2 = durabilidade marginal.** localStorage já persiste entre reinícios normais; o ganho do MemoryProvider é sincronizar com o cérebro remoto (sutil pro usuário).

### A3 — grounding, versão de MENOR risco (Context7-só)

O plano original marcava A3 como "Risco #1" pelo **overhead de boot do Serena por pergunta**. **Mitigação: usar só o Context7** (HTTP remoto, `https://mcp.context7.com/mcp` — **sem boot local**), deixando o Serena como fatia 2 (opt-in, atrás de um spike de latência).

**Peças (o mapa já existe):**
1. `agent_mcp_config` (`commands/mcp.rs:179`) JÁ monta Context7 (`:207-210`). Precisa de uma variante **só-Context7** (sem Serena/Playwright) — um `context7_only_config()` que escreve `{"mcpServers":{"context7":{"type":"http","url":"https://mcp.context7.com/mcp"}}}` num arquivo e devolve o path.
2. Novo comando `learn_ask_grounded(system, prompt, cwd)` = `claude -p <prompt> --mcp-config <context7> --append-system-prompt <system>` no `cwd`. Reusa o padrão de `cli_run` (`commands/llm.rs:139`) + o `socratic_system()` do contrato. `cli_run` precisa aceitar **args extras** (`--mcp-config`, `--append-system-prompt`) — hoje só monta `["-p", prompt]`.
3. Front: `lib/learn.ts` `askTutor`/`explainCheckFailure` chamam `learn_ask_grounded` em vez de `llm_via_cli` (ou roteiam por heurística "a pergunta toca código/API?").

**Testável autônomo:** a montagem dos args (`cli_run` com extras) + o `context7_only_config` (conteúdo do arquivo). O comportamento E2E (Context7 respondendo) precisa do `claude` CLI + rede — validar com o Jessé.

**De-risk obrigatório antes da fatia Serena:** medir latência de boot do Serena por pergunta num projeto real. Se inviável por-pergunta, fica só Context7 (que já cobre "doc real").

### A2 — durabilidade (progresso via MemoryProvider)

- Backend: `learn_profile_get`/`learn_profile_save` usando o **MemoryRegistry** (provider ativo). Salvar como `NewMemory { category:"learn", content: JSON{trackId,exIdx,completed[]}, project: null }`; ler via `search(query:"learn:progress")`. `MemoryProvider` já tem `save/search/get` + teste de roundtrip.
- Front: `CompanionModal` troca `localStorage` por esses comandos (async, com fallback localStorage se o provider falhar).
- Bônus visível: **coluna de passos** na UI (o aprendiz vê exercícios concluídos/atual/próximos).

### A4 — integração (menor, por último)

- Exercício vira **card no Kanban** (col "doing"→"done" quando o `run_check` passa) — reusa `kanban_*`.
- Placeholders Fazer/Par com tooltip "fase 2".
- i18n das strings novas.

## Ordem final sugerida
**A3-Context7** (valor: tutor não alucina) → **A2** (durabilidade + coluna de passos) → **A4** (kanban). A3-Serena só depois de um spike de latência.

## O que precisa do dono
- Validar A3 E2E (rodar o `claude` CLI com `--mcp-config` Context7 no projeto do aprendiz).
- Decidir se a fatia Serena vale o overhead (depende do spike de latência).
