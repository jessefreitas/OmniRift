# Fase 9 — OmniPartner Aprender: plano de execução

> De: `docs/superpowers/specs/2026-06-28-omnipartner-aprender-design.md` (draft).
> Confrontado com o código em 2026-07-02 (v0.1.73). Fatias nomeadas **A0–A4** de propósito:
> as letras "9a–9e" pertencem à spec ANTIGA `archive/2026-06-17-fase9-code-workspace-debug-ia-design.md`
> (9b = MCP client stdio + Serena pool; 9d = DebuggerAgent — ambos ⏳). **O Aprender NÃO depende de 9b/9d**:
> o grounding é delegado ao CLI `claude` headless, que já fala MCP sozinho. Matar essa confusão de numeração
> (o `docs/pendencias-omnirift.md` L47 mistura as duas Fases 9).

## Delta desde a spec (o que o código de hoje muda no design)

| Spec assume | Realidade v0.1.73 | Impacto |
| :--- | :--- | :--- |
| OmniPartner = "chat lateral BYOK" com histórico | `CompanionModal.tsx` é **one-shot** ("Analisar canvas" → `analyzeCanvas()` → texto). Não há chat, input nem histórico | A UI de chat é trabalho NOVO da fatia A0, não reuso |
| Chat BYOK "cru" configurado à parte | **Central de Providers** (v0.1.51): `commands/providers.rs` (`provider_resolve` → key no keychain) + `lib/llm-providers-client.ts`. Pipeline já consome | Conversa leve do Aprender usa a Central, não config avulsa |
| — (não existia) | **`llm_via_cli`** (`commands/llm.rs:129`): `claude -p` local SEM CHAVE, 180s, kill_on_drop. O Arquiteto de Pipeline já usa (`generatePipelinePlanViaCli`) | Caminho default do tutor = mesmo do Arquiteto (zero setup). Falta só `cwd` opcional |
| `run_headless_agent` + `agent_mcp_config` = tutor fundamentado | `run_headless_agent(cli, prompt, cwd)` (`health/ai.rs:230`) roda em `cwd` mas **NÃO injeta `--mcp-config`** — a injeção é frontend-side (`agent-contract.ts:141`), só nos agentes PTY | Gap real: fatia A3 estende `agent_args_for` com mcp-config opcional |
| "Explica este código" = `commands/explain.rs` + `AiReportView` | `explain.rs` é lookup `whatis(1)` do explainshell node (33 linhas). O motor real de explicação é `health/ai.rs::run_agent_report` → `AiReport` → `AiReportView` | Mapear pra `run_agent_report` (ou rotear pelo próprio ask Socrático) |
| Verificação = "reusa o avaliador do turbo/driver.rs" | Melhor ainda: **`run_check(cwd, condition)` já é comando Tauri** (`turbo/commands.rs:27` → `{exit, output}`); o Goal do AgentNode já o consome via `acp-client.ts:98` | `learn_exercise_check` dedicado é dispensável no MVP — front chama `run_check` direto |
| — | **Kanban nativo** (`KanbanPanel` + `kanban-client.ts` + tools MCP `kanban_*`, colunas custom, evento `kanban://changed`) | Exercício pode virar card (A4) — integração barata |
| — | **AGENTS.md/roles** (`commands/agent_docs.rs`) sincroniza instruções; **ACP layer** (aposta 2026-06-30) nasceu depois | Modo Par/Acompanhar (fase 2) deve nascer sobre ACP, não PTY |
| Perfil via `MemoryProvider` | Trait confirmado (`memory/provider.rs`: save/search/get/forget + agent_wiring); Local/SQLite default | OK como na spec — perfil = records com tag `learn:` |

## Motor (decisão consolidada)

Dois caminhos, mesmo padrão do Arquiteto de Pipeline:
1. **Default sem chave**: `llm_via_cli` (`claude -p`, subscription local) + `cwd` do projeto → tutor Socrático.
2. **Fallback Central**: `llmProviderResolve(id)` → `llmChat` (pra quem não tem CLI logado).
Grounding Serena+Context7 entra na A3 (mcp-config no headless); antes disso o `cwd` já ancora parcialmente.

## Fatias

### A0 — MVP de 1 sessão: modo Aprender usável ← **COMEÇAR AQUI**
- **Escopo**: aba/seletor de modo no `CompanionModal` (Analisar | **Aprender**; Fazer/Par desabilitados).
  View Aprender = chat simples (lista de mensagens + input) + **1 exercício hardcoded no front** (TS)
  com `goal` + `condition` shell. Botões: **"Ver dica"** (sobe nível 1→4), **"Verificar"** (chama
  `run_check(cwd, condition)`; exit 0 = ✅; senão manda `{output}` pro tutor explicar o PORQUÊ sem
  entregar conserto). System-prompt Socrático com o nível de dica atual interpolado, enviado via
  `llm_via_cli` (estendido com `cwd: Option<String>` — única mudança Rust, ~5 linhas + 1 teste).
- **Arquivos**: `CompanionModal.tsx`, novo `src/lib/learn.ts` (prompt Socrático + exercício + níveis),
  `commands/llm.rs` (param `cwd`), `lib/companion.ts` (intocado).
- **Dependências**: nenhuma. **Aceite**: abrir OmniPartner → Aprender → perguntar → receber dica graduada
  (nunca solução no nível 1) → escrever código no projeto → Verificar → exit 0 vira "passo concluído";
  falha vira explicação do erro. `cargo test` + `tsc` verdes.
- **Estimativa**: 1 sessão.

### A1 — Contrato Socrático de verdade (backend + testes)
- **Escopo**: mover a máquina de estado pro Rust: `learn/session.rs` (nível de dica por passo, política
  "só revela ao esgotar N ou pedido explícito") + comando `learn_step_ask`. Teste de cenário com LLM
  mockado (stub axum, padrão de `llm.rs::tests`) garantindo que a solução NÃO sai antes do nível máximo.
- **Arquivos**: novo `src-tauri/src/learn/{mod,session}.rs`, `lib.rs` (registro), `learn.ts`.
- **Dependências**: A0. **Aceite**: teste do contrato passa; front usa `learn_step_ask` no lugar do prompt local.
- **Estimativa**: 1 sessão.

### A2 — Trilha embutida + perfil do aprendiz
- **Escopo**: `learn/tracks.rs` (structs + 1 trilha "fundamentos" compilada: passos com teoria, prompts
  por nível de dica, `goal`/`condition`) + `learn_tracks_list`; coluna de passos na UI (atual destacado,
  avanço só após check verde ou pulo manual); `learn/profile.rs` via `MemoryProvider` ativo (trilha,
  passos concluídos, log de erros — records com prefixo `learn:`), `learn_profile_get/update`.
- **Arquivos**: `learn/tracks.rs`, `learn/profile.rs`, `CompanionModal.tsx`.
- **Dependências**: A1. **Aceite**: fechar e reabrir o app preserva trilha/passo (ciclo update→get exato
  no provider Local); unit de integridade da trilha; reset do nível de dica ao avançar passo.
- **Estimativa**: 1–1,5 sessão.

### A3 — Ensino ancorado (Serena+Context7 no headless) + "Explica este código"
- **Escopo**: estender `agent_args_for`/`run_headless_agent` (`health/ai.rs`) com mcp-config opcional
  (`["--mcp-config", path]` p/ claude, path de `agent_mcp_config`); `learn_step_ask` passa a usar esse
  caminho quando a pergunta toca código/API (heurística simples: default sim). "Explica este código":
  seleção → `run_agent_report` → `AiReportView` embutido no chat.
- **Arquivos**: `health/ai.rs`, `learn/session.rs`, `CompanionModal.tsx`.
- **Dependências**: A1 (não precisa de A2). **Aceite**: com Serena instalado, resposta cita símbolos reais
  do projeto; sem Serena degrada limpo (Context7 remoto sempre entra); TURBO intocado (regressão: testes
  do driver verdes).
- **Estimativa**: 1 sessão. **Risco #1 da fase** — validar cedo o overhead do boot do Serena por pergunta.

### A4 — Kanban + polimento de modos
- **Escopo**: exercício iniciado vira card (`kanban_card_create`, col "doing"); check verde move pra "done"
  (`kanban://changed` já re-renderiza o painel). Placeholders "Fazer"/"Par" com tooltip de fase 2
  (Par apontando pra camada ACP). i18n das strings novas.
- **Dependências**: A2. **Aceite**: fluxo exercício→card→done visível no KanbanPanel sem refresh manual.
- **Estimativa**: 0,5 sessão.

## Fora deste plano (fase 2+, como na spec)
Modos Fazer/Par completos (Par sobre ACP), currículo a partir do review gate, projeto guiado multi-sessão,
revisão espaçada (OmniMemory), gamificação, trilhas da comunidade.

## Ordem e gate
A0 → A1 → (A2 ‖ A3) → A4. Total ≈ 4,5–5 sessões. Cada fatia fecha com `cargo test` + `npm run typecheck`
+ review gate local; guardrails da spec (scaffolding obrigatório, ritmo do aprendiz, nada de auto-commit)
valem desde a A0.
