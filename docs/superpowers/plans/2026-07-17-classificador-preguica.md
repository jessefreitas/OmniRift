# Plano — Classificador de Preguiça (juiz LLM anti-falsa-conclusão)

**Gap #1** do backlog Grok Build × OmniRift (dossiê Gustavo Stork). Origem: grok-build 4.2 / 9.1
("prosa confiante NÃO é evidência" — 2º LLM cruza alegação × tool calls reais).
Complementa o spec `2026-07-16-grok-patterns-acp-sandbox-secrets-design.md` (não sobrepõe).

## Objetivo

Detectar automaticamente, no fim de cada turno, quando o agente **declarou vitória sem terminar**
(ou parou prematuramente / pediu permissão desnecessária) — cruzando o que ele DISSE contra o que
ele REALMENTE fez (tool calls) — e reagir de forma **híbrida**:

- **Com Goal ativo** → re-injeta um nudge de continuação (autônomo, já é loop controlado).
- **Sem Goal** → só sinaliza (badge "possível parada prematura" + motivo); o operador decide.

## Por que é barato (base já existe)

| Peça | Onde | Reuso |
|---|---|---|
| Gancho fim-de-turno | `AgentNode.tsx` `listenAcpTurnDone` (~L660) | adicionar 1 bloco best-effort |
| Molde juiz LLM | `trajectory-eval.ts` (buildPrompt→llmChat→parse tolerante) | copiar molde |
| Alegação do turno | `lastReplyRef.current` | ler |
| **Tool calls reais** | eventos ACP `sessionUpdate:"tool_call"` (title) | contar/listar do snapshot do turno |
| Re-injeção | `acpPrompt()` / `collectFocus()` (padrão do goal-check L786-797) | reusar |
| Guard orçamento | `assertBudgetOk` | reusar |
| Sinalização | `pushSys()` + badge no header (padrão goalRun) | reusar |
| Flag | `getFlag("laziness-check")` default OFF (experimental) | padrão do projeto |

Precedente direto: o **goal-check** (L740-800) já faz o espírito disto, mas só quando há condição
executável de shell (`run_check`). O classificador generaliza pra QUALQUER turno via juiz LLM.

## Arquitetura

Novo arquivo `src/lib/laziness-check.ts` — funções PURAS (testáveis) + 1 runner:

```
// contratos
interface TurnClaim { reply: string; toolCallCount: number; toolNames: string[];
                      goal?: string; outstandingTasks?: number; }
interface LazinessVerdict { stalled: boolean; confidence: number /*0..1*/;
                            signal: "false-completion"|"premature-stop"|"needless-permission"|"ok";
                            reason: string; nudge: string; }

// puras
buildLazinessPrompt(claim: TurnClaim): { system, prompt }   // "prosa não é evidência"
parseLazinessVerdict(text: string): LazinessVerdict          // parse tolerante (JSON de prosa/```)
shouldRunCheck(claim: TurnClaim): boolean                    // heurística barata PRÉ-LLM (gate)

// runner (impuro)
evaluateLaziness(claim, config, project?): Promise<LazinessVerdict>
  → assertBudgetOk → buildPrompt → llmChat(kind:"laziness-check") → parse
```

### Heurística de gate (`shouldRunCheck`) — não gasta LLM à toa

Roda o juiz LLM SÓ quando o turno é suspeito (senão retorna false e nem chama a IA):
- reply contém linguagem de conclusão ("pronto", "concluí", "feito", "terminei", "done", "✅") **E**
- toolCallCount baixo/zero **OU** outstandingTasks > 0.
Turno com muitas tool calls e sem alarde → provavelmente trabalhou de verdade → pula.

### Limiar

`confidence ≥ 0.7` + `stalled` → age (conforme o modo híbrido). Espelha o 0,7 do grok.

## Sequência TDD

1. **RED**: `laziness-check.test.ts` (runner do projeto — mesmo padrão de `watchdog.test.ts`,
   via `scripts/run-grab-tests.mjs` ou o runner que os `*.test.ts` usam). Casos:
   - `parseLazinessVerdict`: JSON puro, JSON em ```fence, prosa+JSON, lixo → default seguro (stalled=false).
   - `shouldRunCheck`: "terminei" + 0 tools → true; resposta longa + 8 tools → false; outstandingTasks>0 → true.
   - `buildLazinessPrompt`: contém as tool calls reais + a frase "não é evidência".
2. **GREEN**: implementar `laziness-check.ts` até os testes passarem.
3. **Integração** (`AgentNode.tsx`, edição cirúrgica no bloco `listenAcpTurnDone`):
   - montar `TurnClaim` do snapshot do turno (reply + contagem/nomes de tool_call dos eventos + goal).
   - `if (!getFlag("laziness-check")) return;` + `if (!shouldRunCheck(claim)) return;`
   - `evaluateLaziness(...)` best-effort (try/catch, nunca trava o turn-done — padrão dos outros blocos).
   - verdict.stalled && conf≥0.7 → **com Goal**: `acpPrompt(id, nudge+collectFocus)`; **sem Goal**: `pushSys` + badge.
   - guarda anti-loop: máx 1 nudge automático por turno + contador `lazinessNudgeRef` (teto por sessão).
4. **Verificação real**: `npm run typecheck` + runner de teste + build `.deb` p/ testar no app do Jessé
   (NUNCA `tauri:dev` sobre app instalado — ver memória dev-build-gotchas).

## Riscos / decisões travadas

- **Loop de re-injeção** → mitigado pelo modo híbrido (auto só sob Goal) + teto de nudges/sessão.
- **Custo de LLM por turno** → mitigado por `shouldRunCheck` (juiz só em turno suspeito) + budget guard.
- **Falso positivo** (cutucar agente que terminou de verdade) → limiar 0,7 + heurística exige linguagem
  de conclusão SEM tool calls; nudge é educado ("confirme rodando X"), não acusatório.
- **Modelo do juiz**: `LlmConfig` ollama barato (sem quota). Configurável; default = modelo local rápido.

## Fora de escopo (próximos gaps)

Dream de memória (#2), compactação 2-pass (#3), /goal budget (#4). Este plano é só o #1.
