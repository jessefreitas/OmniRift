# OmniPartner Aprender — Design do MVP

> Status: **draft — aguarda aprovação do Jesse**. 2026-06-28. Continua a discussão
> "agente de IA que ajuda a programar": o moat do OmniRift é o canvas + orquestração,
> não a engine — então não reconstruímos um Composer; damos ao OmniPartner uma camada
> **pedagógica** sobre as engines (claude/Serena/Context7) que já estão no app.

**Goal:** Transformar o OmniPartner (chat IA lateral BYOK) de executor de tarefas em um
**tutor Socrático** de programação. Introduz o modo **Aprender**: ensina a pessoa a ler e
escrever código por **scaffolding** (dicas progressivas, não respostas prontas), **ancorado**
na estrutura do código real dela (via Serena) e na doc oficial atual (via Context7). Objetivo
do Jesse: *"que as pessoas APRENDAM, não só peçam"*.

## O que JÁ existe (reusar, não reinventar)
| Peça | OmniRift | Uso na feature |
| :--- | :--- | :--- |
| OmniPartner (chat lateral BYOK) | `CompanionModal` (React) | ✅ A casa: ganha o seletor de modo + a UI de ensino |
| Grounding de código + docs | `agent_mcp_config` (`commands/mcp.rs`) | ✅ Serena (LSP do codebase real) + Context7 (doc viva) num agente headless |
| Rodar agente headless | `run_headless_agent` (fatorado no v0.1.32; usado por Saúde + TURBO) | ✅ O motor do tutor fundamentado (claude `-p` escopado no projeto) |
| Explicação de código | `commands/explain.rs` + `AiReportView` (painel Saúde) | ✅ "Explica este código" linha-a-linha |
| Verificação de exercício | TURBO (`turbo/driver.rs`) — condição shell, `exit 0` = pronto | ✅ Auto-check: roda SÓ a condição (o aprendiz é o implementer) |
| Currículo de boas práticas | Review gate (`review_cfg.rs` + `scripts/local-review.py`, 6 categorias) | ✅ Cada finding vira lição do PORQUÊ (segurança/qualidade/perf/testes/arquitetura/estilo) |
| Perfil/progresso do aprendiz | `MemoryProvider` (`src-tauri/src/memory/`) | ✅ SQLite local por default; OmniMemory (pgvector) quando conectado → revisão espaçada melhor |
| Aplicar mudança com backup | `health/backup.rs` (confirma → backup → aplica) | ✅ Mantido intacto no modo Fazer |

**O NOVO = a camada pedagógica:** os 3 modos, o **contrato Socrático** (system-prompt + máquina
de estado de "nível de dica"), as trilhas, e o perfil do aprendiz. Quase nenhuma infra nova.

## Decisão de arquitetura (a peça-chave)
O OmniPartner hoje é chat BYOK **cru** (chamada direta openai/anthropic/ollama) — **não tem tools
MCP**, logo **não enxerga Serena/Context7 sozinho**. O ensino fundamentado NÃO pode sair do chat
cru (alucina API). Então o modo Aprender **delega a um agente headless `claude`** (`run_headless_agent`
+ `agent_mcp_config` injetando Serena+Context7), escopado no `cwd` do projeto, com o **system-prompt
Socrático**. O chat BYOK fica para a conversa leve; toda resposta que toca código/doc passa pelo
agente com tools. É isso que garante "ancorado, não alucinado".

## Os 3 modos (visão; MVP só entrega Aprender)
- **Fazer** — agêntico: pede → faz → diff revisável (reusa `run_headless_agent` + `health/backup.rs`). *Fase 2.*
- **Par/Acompanhar** — a pessoa programa, o tutor coacha ao vivo (vê o node via snapshot+Serena, sugere, NÃO escreve). *Fase 2.*
- **Aprender** — Socrático + currículo: conceito → exercício → verifica → explica o erro. **← MVP.**

## MVP (escopo mínimo, cresce depois)
1. **Seletor de modo** no `CompanionModal` (Fazer / Par / Aprender). No MVP só **Aprender** é funcional; Fazer/Par aparecem desabilitados (placeholder da fase 2).
2. **Contrato Socrático**: system-prompt + estado de "nível de dica" por passo. O tutor **NUNCA**
   entrega a resposta de cara — gradua dicas (conceito → pista → trecho parcial → solução) e só
   revela quando o aprendiz trava ou pede explicitamente. Esgotar o nível N libera a solução.
3. **1 trilha embutida** (ex.: fundamentos) compilada no binário — passos com teoria + exercício.
4. **1 exercício com auto-check**: o aprendiz escreve o código no projeto → "Verificar" roda a
   **condição** (reusa o avaliador do `turbo/driver.rs`: comando shell, `exit 0` = passou). Se falhar,
   o tutor lê stdout/stderr e ensina o porquê do erro (não entrega o conserto).
5. **"Explica este código"**: seleção → `commands/explain.rs` → render no `AiReportView` dentro do chat.
6. **Perfil básico** do aprendiz via `MemoryProvider`: trilha atual, passos concluídos, log de erros.

## Componentes / arquitetura

### Backend — `src-tauri/src/`
- **Novo módulo `learn/`**:
  - `learn/tracks.rs` — structs + dados estáticos das trilhas embutidas (passos, teoria, prompts de
    dica por nível, e o par `goal`/`condição shell` de cada exercício).
  - `learn/session.rs` — orquestra o modo Aprender: monta o system-prompt Socrático com o nível de
    dica atual, dispara o `run_headless_agent` (claude + `agent_mcp_config` Serena/Context7, `cwd` do
    projeto), e devolve a resposta graduada.
  - `learn/profile.rs` — lê/grava o estado do aprendiz pelo `MemoryProvider` ativo (trilha, passos,
    falhas); funciona com o blackboard SQLite local por default.
- **Comandos Tauri**: `learn_tracks_list`, `learn_step_ask` (pergunta no modo Aprender → resposta
  Socrática graduada), `learn_exercise_check` (roda a condição do passo via o avaliador do TURBO →
  stdout/stderr/exit), `learn_profile_get` / `learn_profile_update`.
- **Reusos diretos**: `run_headless_agent`, `agent_mcp_config`, `commands/explain`, o avaliador de
  condição do `turbo/`, e o `MemoryProvider` — **nada de engine nova**.

### Frontend — `src/`
- **`CompanionModal`**: header ganha o seletor de modo. View do modo Aprender:
  - coluna compacta com os passos da trilha (atual destacado);
  - chat principal (histórico preservado);
  - input com ações rápidas: **"Ver dica"** (sobe o nível de dica), **"Verificar exercício"**
    (`learn_exercise_check`), **"Explica este código"** (`explain` → `AiReportView`).
- Estado do nível de dica é por-passo; reset ao avançar.

## Guardrails (não-negociáveis)
- **Scaffolding obrigatório**: no modo Aprender a IA **NUNCA** entrega a resposta de cara — gradua
  dicas. É a diferença entre aprender e copiar-colar.
- **Ensino ancorado (proibido alucinar)**: toda afirmação sobre API/impacto vem de Serena (código
  real) ou Context7 (doc real), via o agente com tools — não do chat BYOK cru.
- **Modo Fazer mantém o gate**: confirma → backup → diff (`health/backup.rs`). Nada de auto-commit.
- **Ritmo do aprendiz**: o tutor não avança passo sozinho — só após sucesso na verificação ou pulo manual.

## Fora do MVP (fase 2+)
- Modos **Fazer** e **Par** completos (coaching ao vivo no canvas via snapshot+Serena).
- Currículo dinâmico a partir das 6 categorias do review gate (lição sob demanda a partir de um finding real).
- Projeto guiado multi-sessão (construir algo do zero, passo a passo).
- Revisão espaçada automática (scheduler sobre o histórico de erros na OmniMemory).
- Gamificação/XP; integração com o ditado por voz (já existe); trilhas importáveis da comunidade.

## Testing
- **Rust `learn/`**: unit de `tracks.rs` (parsing/integridade das trilhas) e `profile.rs` (regras de estado).
- **Contrato Socrático** (o mais importante): teste de cenário com LLM mockado garantindo que a solução
  **não** é entregue antes de esgotar o nível de dica configurado no passo.
- **Exercício**: integração — `learn_exercise_check` roda a condição e só dá sucesso em `exit 0`.
- **Perfil**: ciclo `learn_profile_update` → `learn_profile_get` recarrega exato pelo `MemoryProvider`
  (testado com o provider Local/SQLite — default zero-config).
