# TURBO mode (loop engineering) — Design do MVP

> Status: **draft — aguarda aprovação do Jesse**. 2026-06-24. Baseado em "Loop Engineering"
> (Addy Osmani) + na constatação de que o OmniRift já tem 5 das 6 peças do loop.

**Goal:** um **loop autônomo no canvas** — você define um *goal* + uma *condição de parada
verificável*; o OmniRift roda implementer→verifier(separado)→loop até a condição ser verdade
(ou bater um teto), com estado em disco e checkpoint humano. Você **vê o loop no canvas** (o moat).

## O que JÁ existe (reusar, não reinventar)
| Peça do loop | OmniRift |
|---|---|
| Sub-agents (implementer/verifier) | roles + Orquestrador + **Bloco E** (claims/blackboard) |
| Worktrees | Floors |
| State/memory | MemoryProvider (blackboard) |
| Skills / Connectors | skill-layer / MCP |
| Status ao vivo | push-hooks (working/verifying/done) |

**Falta:** o **driver do loop** (`/goal`) + a separação maker≠checker amarrada + os guardrails.

## MVP (escopo mínimo, cresce depois)
1. **1 implementer + 1 verifier** (CLIs/roles distintos — verifier NÃO é o mesmo agente).
2. **Goal + condição de parada verificável** = um **comando de shell** cujo exit 0 = pronto
   (ex.: `npm test && npm run lint`, `cargo test`, `pytest -q`). Simples, determinístico, auditável.
3. **Loop**: implementer trabalha no goal → roda a condição → se exit≠0, manda a saída do erro pro
   implementer corrigir → repete. Quando exit 0 → o **verifier** (agente separado) dá o parecer final
   (a condição passou + a mudança faz sentido) → para.
4. **Tetos** (guardrails do Addy): `maxIterations` (default 6) + `maxTokens`/tempo (cap) → para e
   reporta se estourar (loop sem rédea = erro sem rédea).
5. **Estado em disco**: `.omnirift/turbo/<goalId>.json` (goal, condição, iterações, status, log) →
   sobrevive a fechar a tela (igual à persistência da análise de Saúde).
6. **Checkpoint humano**: ao parar (sucesso ou teto), NÃO faz merge/commit sozinho — apresenta o
   diff + o resultado da condição pro Jesse aprovar. "Você é o teto" (Addy).
7. **Ao vivo no canvas**: um **TurboNode** (ou painel) mostra goal, iteração N/max, status (push-hooks),
   a condição e seu último exit, e o log. Os agentes do loop são nodes normais (você vê tudo).

## Componentes / arquitetura
- **Backend `src-tauri/src/turbo/`** (NOVO): `loop.rs` — driver do loop (spawna implementer via o
  mesmo mecanismo de agentes; roda a condição via PTY/command; lê exit; decide próxima iteração;
  persiste estado). `mod.rs` + comandos `turbo_start(goal, condition, implementerRole, verifierRole,
  maxIter)`, `turbo_status(id)`, `turbo_stop(id)`, `turbo_list()`.
- **Verifier** = um agente separado (role) que recebe o diff + o resultado da condição e responde
  GO/NO-GO com justificativa (parecer estruturado). Maker≠checker forçado (roles distintos).
- **Frontend** `src/components/turbo/`: TurboPanel (criar goal: textarea + campo condição + escolher
  roles implementer/verifier + maxIter) + TurboNode/overlay ao vivo. Reusa push-hooks p/ status.
- **Estado**: backend é a fonte da verdade (`.omnirift/turbo/`), igual ao painel de Saúde.

## Guardrails (não-negociáveis — direto do artigo)
- **maker ≠ checker** (roles distintos; o que escreve não aprova a própria prova).
- **condição verificável por execução** (exit code), não "o agente acha que terminou".
- **teto de iterações + budget**; ao estourar, para e reporta (sem loop infinito).
- **checkpoint humano** no fim (sem auto-merge); o Jesse revê o diff.
- **anti-rendição cognitiva**: TURBO acelera o que se entende; o diff é sempre revisado.

## Fora do MVP (fase 2+)
Fan-out multi-floor (vários implementers em paralelo, 1 por sub-task via Bloco E); `/loop` em cadência
(Routines); condição via verifier-LLM além de exit-code; auto-PR ao aprovar.

## Testing
- Rust: o driver decide corretamente (exit 0 → verifier; exit≠0 → re-itera; teto → para); persistência
  do estado; parsing do exit. Mock do spawn/command.
- Boot-safe. Validação real no build final (rodar um goal trivial com condição `true`/`false`).
