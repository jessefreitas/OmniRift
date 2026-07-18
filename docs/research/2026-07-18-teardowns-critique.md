# Crítica de arquiteto — teardowns CodeWhale × Agent Flow

**Data:** 2026-07-18
**Autor:** revisão crítica (Claude, sessão de backlog Grok) sobre os dois teardowns gerados na sessão paralela:
- [`2026-07-18-codewhale-integration-assessment.md`](./2026-07-18-codewhale-integration-assessment.md)
- [`2026-07-18-agent-flow-teardown-learnings.md`](./2026-07-18-agent-flow-teardown-learnings.md)

**Propósito:** validar as alegações contra o código real, separar o que é sinal do que é sobreposição, e priorizar.

---

## 0. Verificações contra o código (não é suposição)

Antes de opinar, checei três alegações concretas dos docs contra a base:

| Alegação | Verificado | Resultado |
|---|---|---|
| `/agent-hook` de status é sem auth, enquanto o control plane exige token | `mcp/server.rs:86` + `check_token` L213 | **Correto.** Push-hook `working/blocked/done` é "loopback only, sem auth"; `/sse` e `/message` exigem `x-omnirift-token`. |
| "Floors não é módulo Rust `floors/`" (correção do outro agente) | varredura de `src-tauri/src` | **Correto.** Não existe `floors/`; a ponte é `src/lib/git-client.ts` + `commands/git.rs`. |
| OmniAgents ACP já emitem eventos estruturados (a lacuna é o PTY) | `acp/mod.rs` EventLog + `AgentNode.tsx` | **Correto.** ACP tem seq/coalescência/reattach; TerminalNode Claude só empurra estado. |

**Conclusão:** os dois docs estão ancorados em código real, honestos sobre limitações e com gates concretos. Qualidade acima do normal para teardown.

---

## 1. CodeWhale — o que sustenta e o que não

**Sustenta:**
- Invariante **"executor, não control plane"** = a filosofia que o OmniRift já pratica (sessão backend-owned, provider externo, canvas/memória/credenciais nossos). O doc descreve a arquitetura que já temos e encaixa o daemon nela.
- Abstração **`StructuredAgentTransport`** é o refactor certo: as unions de provider estão rígidas (`canvas.ts`, branches no `AgentNode.tsx`); cortar por transporte/capability > adicionar mais um literal.
- Gates P0 sérios (bwrap obrigatório + **canário comportamental**, token loopback efêmero, home isolado + lock). O sandbox Linux "marker only" é um P0 real.

**Pushback:**
- Vende o CodeWhale como o runtime da **Fase 7 (Ombro)**, mas já temos **OmniSwitch** (`llm_router` nativo, loopback 7845) + ACP + adapters Hermes/Codex. Seria um **terceiro** runtime estruturado. Ganho marginal real = threads duráveis SQLite + steering + dynamic tools por HTTP — e dynamic tools **sobrepõe** a injeção de MCP (`agent_wiring`/Brain Connect) que já usamos. Pergunta não cravada pelo doc: *o que ele dá que ACP + OmniSwitch + MCP não dão?* Pouco além de threads duráveis + steering.
- 551k LOC, churn alto, naming legado `deepseek`, 0.9.1≠0.9.0 → imposto de manutenção **permanente** (pin + contract fixtures + egress por versão).

**Recomendação:** CW-0 (terminal, ~1 dia) e CW-1 (spike de aprendizado) OK. Cético em comprometer CW-2+ sem provar que dynamic-tools bate a injeção de MCP.

---

## 2. Agent Flow — o insight mais valioso dos dois

**Sustenta (forte):**
- Diagnóstico cirúrgico: a lacuna de observabilidade **não** está nos OmniAgents ACP (já estruturados) — está nos **workers PTY** (TerminalNode Claude/Codex). Verdade: o OmniAgent nasce com `Bash/Read/Edit` bloqueadas → quem edita/testa é um terminal, que só empurra `working/blocked/done`.
- `RunEvent` append-only + ledger SQLite + **"preserve IDs nativos, nunca correlacione por nome"** = design certo. Rejeições corretas (sem 2º canvas, sem d3-force, sem relay Next, sem telemetria).

**Pushback:**
- Escopo grande (5 fases, parser rollout Codex em Rust, Inspector UI inteiro). **Não é quick win.** Valor está em **Fase A (RunEvent + adapter ACP)** + **Fase B (hooks Claude PTY)**; Codex (Fase C) é caro → adiar.
- Sobrepõe `SessionHistoryModal` + `session-client.ts` (o doc reconhece: evolução aditiva).
- `/agent-hook` sem auth é real mas loopback → risco baixo; adicionar token antes de enriquecer o payload é barato e correto.

---

## 3. Veredito comparativo

| | CodeWhale | Agent Flow |
|---|---|---|
| Qualidade do doc | Alta, honesto sobre risco | Alta, diagnóstico mais afiado |
| Valor real p/ OmniRift | Médio (sobrepõe ACP+OmniSwitch+MCP) | **Alto** (fecha dor concreta) |
| Risco/custo | Alto (daemon novo, supply chain, hardening perpétuo) | Médio (subsistema aditivo) |
| Primeira fatia | CW-0 terminal + CW-1 spike | **Fase A+B: ledger + ACP + hooks Claude** |

**Priorização:** observabilidade dos workers PTY (Agent Flow A+B) primeiro — dor real, fatia contida, baixo risco. CodeWhale vira spike CW-0/CW-1 para aprender; comprometer depois.

---

## 4. Conexão com o backlog Grok fechado hoje

Os dois runtimes externos convergem com o que acabou de entrar nativo:
- `context_compaction` / `POST /compact` do CodeWhale ≙ **compactação especulativa 2-pass (#3)** — `speculative-compact.ts`.
- `usage`/budget do CodeWhale ≙ **/goal com orçamento de tokens (#4)** — `goal-budget.ts`.
- O "classificador de preguiça (#1)" e o "Dream de memória (#2, decay+consolidação via Routine)" são camadas de supervisão que **nenhum** dos dois runtimes externos tem — reforçam o invariante: o OmniRift é o control plane; runtimes são executores.

**Leitura:** não estamos atrás desses projetos no que importa (supervisão, memória com base científica, canvas). Estamos atrás só em *durabilidade de thread* (CodeWhale) e *observabilidade de PTY* (Agent Flow) — e o segundo é o que dói.
