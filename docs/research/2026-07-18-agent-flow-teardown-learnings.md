# Agent Flow → observabilidade estruturada dos workers do OmniRift

**Data:** 2026-07-18  
**Objeto auditado:** [`patoles/agent-flow`](https://github.com/patoles/agent-flow) @
[`84cd2fb`](https://github.com/patoles/agent-flow/commit/84cd2fb8c704cefe52e6dd41a375c4069442e206)
(Apache-2.0, TypeScript, VS Code + app web standalone)  
**Pergunta:** o que é, quão bom é e quais partes realmente servem ao OmniRift?  
**Decisão:** usar como blueprint para um **Inspector de Execução nativo**, não como
dependência, fork ou segundo canvas.

---

## 0. Resumo executivo

O Agent Flow é um **observador/reconstrutor de sessões**, não um orquestrador. Ele acompanha
Claude Code e Codex por hooks e arquivos JSONL, normaliza o que encontra para um protocolo
pequeno de eventos e desenha uma árvore animada com tool calls, mensagens, subagentes,
timeline, transcript, atenção por arquivo e custo estimado.

A lacuna relevante no OmniRift não está nos OmniAgents ACP: estes já expõem eventos
estruturados, tool-call id, diffs, uso, permissões e fim de turno. A lacuna está nos
**workers executores que rodam como TerminalNode/PTy**. O OmniAgent é deliberadamente um
orquestrador e nasce com `Bash/Read/Edit/Write/Grep/Glob` bloqueadas; portanto, quem realmente
edita/testa o projeto costuma ser um terminal Claude/Codex. Hoje esses terminais empurram ao
OmniRift essencialmente `working | blocked | done`, e o histórico SQLite guarda sobretudo
eventos de ciclo de vida.

**Ação recomendada:** estender o cano de hooks já existente, adicionar um watcher de rollouts
do Codex no backend Rust, preservar IDs nativos e persistir um ledger normalizado em SQLite.
Na UI, apresentar esses fatos num Inspector ligado ao nó e no Histórico de Sessões. O canvas
principal continua sendo o canvas espacial do OmniRift; o grafo de execução é um drill-down
temporal de uma sessão.

### Veredito por dimensão

| Dimensão | Nota | Leitura |
|---|---:|---|
| Ideia de produto | 9/10 | Torna a execução depurável e ensina como o agente trabalhou |
| Parser Codex | 8/10 | Melhor subsistema; cobre os cinco tipos de rollout e compactação |
| Observação Claude | 6/10 | Boa cobertura, mas junta duas fontes com dedup heurístico |
| Fidelidade do grafo | 5/10 | IDs são perdidos no protocolo visual; nomes podem colidir |
| UI/performance | 8/10 | Canvas 2D, refs, virtualização e stress scenarios bem pensados |
| Persistência/replay | 3/10 | Buffer em memória; replay durável não é um ledger normalizado |
| Testes | 5/10 | Parser Codex razoavelmente testado; UI e parser Claude sem testes |
| Privacidade para o OmniRift | 5/10 | Local-first, mas o `npx` tem telemetria opt-out |
| Dependência/fork direto | 3/10 | Stack e abstrações duplicariam partes melhores do OmniRift |
| Blueprint arquitetural | **9/10** | Fecha exatamente a opacidade dos workers PTY |

---

## 1. O que o Agent Flow é — e o que não é

### É

- Visualizador em tempo real de Claude Code e Codex.
- Leitor/tailer de transcripts Claude e rollouts Codex.
- Receptor de hooks de ciclo de vida do Claude Code.
- Normalizador de eventos para uma representação visual comum.
- Visualização de múltiplas sessões, transcript, timeline e file attention.
- Ferramenta de diagnóstico e aprendizado pós-execução.

### Não é

- Dono das sessões ou dos processos dos agentes.
- Gerenciador PTY.
- Orquestrador com comandos entre agentes.
- Executor de workflows declarativos.
- Gerenciador de worktrees/branches.
- Memória compartilhada entre agentes.
- Gate de review/merge ou motor de permissões.
- Fonte autoritativa de billing.

Essa distinção é essencial. No Agent Flow, uma linha significa **"observei estes eventos e
inferi esta relação"**. No OmniRift, uma linha pode comandar, transportar payload, representar
time, pipe, review, filtro ou vínculo semântico. Não se deve misturar os dois níveis.

---

## 2. Snapshot de maturidade auditado

No snapshot analisado:

- ~17,5 mil linhas TS/TSX/JS, 153 arquivos no checkout.
- Monorepo pequeno: `extension/`, `scripts/relay`, `app/` e `web/`.
- Frontend React 19 + Next/Vite + Canvas 2D + `d3-force`.
- Extensão e relay compartilham os mesmos parsers/watchers.
- CI executa testes Node, testes da extensão e typecheck de extensão/web.
- 60 casos de teste em seis arquivos:
  - 20 do parser Codex;
  - 8 de leitura incremental de arquivo;
  - 32 de telemetria, sync, sanitização e formatação de modelos.
- Não há teste do frontend renderizado.
- Não há teste dedicado do parser de transcript Claude.
- O CI não faz um gate explícito de build de produção.

O projeto é ativo e já corrigiu problemas reais de sessões longas, Windows, CRLF, Unicode,
duplicação de subagentes e perda de eventos. Porém ainda é v0.x e há um sinal de higiene de
release: changelog/release anunciam `0.9.1`, enquanto os manifests auditados do app e da
extensão continuam em `0.8.1`.

**Leitura:** bom laboratório e boa fonte de casos de borda; cedo demais para virar uma
dependência infra do OmniRift.

---

## 3. Arquitetura real

```text
Claude Code
├─ hooks command → hook.js → POST loopback
└─ ~/.claude/projects/**/*.jsonl

Codex
└─ $CODEX_HOME/sessions/YYYY/MM/DD/rollout-*.jsonl

                │
                ▼
       parsers/watchers Node
                │
                ▼
 AgentEvent { time, type, payload, sessionId }
                │
       ┌────────┴────────┐
       ▼                 ▼
 VS Code postMessage   relay SSE local
       └────────┬────────┘
                ▼
     reducer/simulação em memória
                │
                ▼
 Canvas 2D + d3-force + painéis React
```

### Protocolo visual

O protocolo contém tipos como:

```ts
type AgentEventType =
  | "agent_spawn"
  | "agent_complete"
  | "agent_idle"
  | "message"
  | "context_update"
  | "model_detected"
  | "tool_call_start"
  | "tool_call_end"
  | "subagent_dispatch"
  | "subagent_return"
  | "permission_requested"
  | "error";
```

É simples e portável, mas simples demais para ser ledger autoritativo: o envelope não exige
`eventId`, `turnId`, `toolCallId`, `parentId`, timestamp absoluto, runtime/source ou número de
sequência. Parte desses IDs existe na fonte e é descartada antes da UI.

---

## 4. Auditoria por subsistema

### 4.1 Claude: hooks + transcript JSONL

O Agent Flow combina duas fontes:

1. **Hooks** para baixa latência (`SessionStart`, `PreToolUse`, `PostToolUse`,
   `PostToolUseFailure`, `SubagentStart/Stop`, `Notification`, `Stop`, `SessionEnd`).
2. **Transcript JSONL** para mensagens, thinking, conteúdo de tool results, modelo e catch-up.

Pontos bons:

- O hook é best-effort, tem timeout curto e sempre devolve sucesso vazio.
- O script de forwarding encontra a instância viva por arquivos de discovery.
- `fs.watch` tem polling de fallback.
- Há prescan para conectar a uma sessão já em andamento.
- Resultados são resumidos antes de ir ao renderer.
- Thinking redigido pelo provider vira placeholder em vez de sumir.
- O parser entende subagente em arquivo separado e progress inline.

Fragilidades:

- Hook e transcript podem emitir o mesmo evento; a UI deduplica `agente + nome da tool` numa
  janela de três segundos.
- O `tool_use_id` é usado no parser, mas não preservado obrigatoriamente no `AgentEvent`.
- Um `tool_call_end` visual fecha o primeiro card `running` com mesmo agente e nome da tool.
  Duas leituras concorrentes podem ser correlacionadas errado.
- Subagentes são indexados por um nome derivado de `description`, `subagent_type` ou
  simplesmente `subagent`; nomes repetidos colidem.
- Sessão Claude é declarada encerrada após cinco minutos sem atividade e reativada se o
  transcript voltar a crescer. Serve à UX, não a automação autoritativa.
- A configuração standalone escreve hooks automaticamente no `~/.claude/settings.json`.

**Para o OmniRift:** aproveitar os eventos e casos de borda, mas manter `tool_use_id`,
`agent_id` e sequência desde a origem. Usar settings por agente, como já fazemos, em vez de
alterar a config global.

### 4.2 Codex: rollout watcher/parser

É a parte mais reutilizável conceitualmente.

O watcher:

- respeita `CODEX_HOME`;
- procura sessões em três dias de diretórios local/UTC;
- lê `cwd` do `session_meta` e filtra pelo workspace;
- acompanha arquivo com watcher + polling;
- reconstitui linha JSONL dividida entre reads;
- trata truncagem do arquivo;
- marca inatividade e retomada.

O parser cobre:

- `session_meta`: id, cwd, versão e instruções-base;
- `turn_context`: modelo e cwd autoritativos do turno;
- `response_item`: mensagens, function calls/outputs, custom tools e reasoning cifrado;
- `event_msg`: lifecycle, reasoning em texto e token counts;
- `compacted`: reset/reconstrução após compactação.

Ele também:

- correlaciona calls e outputs por `call_id` internamente;
- filtra `AGENTS.md`, `environment_context` e wrappers de IDE;
- usa `last_token_usage.input_tokens` e `model_context_window` do Codex;
- trata `exec_command`, `apply_patch`, `write_stdin`, `update_plan` e web search;
- tolera registros desconhecidos/malformados.

Limite declarado no próprio código: rollouts Codex não são convertidos em árvore de
subagentes. O parser emite apenas o orquestrador. Se `spawn_agent/wait_agent` aparecem como
tools, precisam de um mapeamento específico.

**Para o OmniRift:** portar watcher e normalização para Rust/Serde; não importar o relay Node.
Criar fixtures próprias com os formatos reais usados pelas versões Codex suportadas.

### 4.3 Correlação, deduplicação e identidade

Este é o principal ponto a melhorar em relação ao Agent Flow.

| Fonte | ID nativo disponível | Agent Flow visual | OmniRift alvo |
|---|---|---|---|
| ACP | `toolCallId`, session update, seq local | N/A no projeto | Preservar integralmente |
| Claude | `tool_use_id`, `agent_id`, UUID da entry | Parcialmente descartado | Preservar integralmente |
| Codex | `call_id`, session UUID, record type | Parser usa, UI perde parte | Preservar integralmente |
| Hook status | label/session resolvido | Nome | Resolver para `nodeId/sessionId` |

Regras alvo:

1. Nunca correlacionar fim de tool só por nome.
2. Nunca usar label humano como primary key de agente.
3. Dedup por `(source, native_event_id)` quando existir.
4. Se duas fontes descrevem o mesmo evento, eleger precedência de autoridade:
   `protocol > transcript estruturado > hook > inferência PTY`.
5. Registrar a origem e o nível de confiança em todo evento derivado.
6. Heurística pode enriquecer UI, mas não acionar merge, review ou rotina.

### 4.4 Frontend e performance

O renderer usa Canvas 2D e `d3-force`, não React Flow. As decisões boas são:

- `frameRef` é fonte da verdade visual a 60 fps.
- React é atualizado em frequência menor e apenas em mudanças estruturais.
- Posições do force layout não causam render React por frame.
- Timeline também usa canvas.
- Transcript/message feed usam virtualização.
- Tool cards e conversations possuem caps.
- Há cenários light/medium/heavy/extreme para profiling.
- O código separou draw, hit detection, camera, handlers e animation loop.

O que não cabe no OmniRift:

- Um segundo canvas de produto com navegação e seleção próprias.
- `d3-force` reposicionando nós que o usuário organizou espacialmente.
- Next.js e relay web dentro do desktop Tauri.
- Estado de sessão duplicado no renderer.

O que cabe:

- Timeline em canvas/Pixi quando o DOM ficar caro.
- Virtualização do transcript.
- Reducers puros por tipo de evento.
- Stress fixture com milhares de eventos.
- Painel de execução como drill-down, não como substituto do canvas.

### 4.5 Persistência e replay

No standalone:

- o relay guarda no máximo 5.000 eventos por sessão em memória;
- a UI mantém no máximo 5.000 eventos para seek;
- cada conversa visual guarda no máximo 200 mensagens;
- ao reiniciar, a representação normalizada some;
- o JSONL original pode ser relido, mas não há ledger indexado/pesquisável.

O OmniRift já possui duas bases melhores:

- `AcpManager` guarda uma janela observável de 500 eventos/2 MiB com seq, coalescência e
  attach/re-hidratação;
- `agent_sessions/session_events` em SQLite fornece Histórico durável.

O gap é juntar as duas ideias: eventos estruturados de ACP/hooks/rollouts devem alimentar
uma tabela durável. O buffer de attach continua sendo a janela quente; SQLite é o histórico.

### 4.6 Tokens e custo

No Claude, o Agent Flow estima:

- quatro caracteres por token;
- prompt de sistema-base com 5.000 tokens;
- resultado `Grep/Glob` com multiplicador 0,5;
- outras tools com multiplicador 0,3.

O custo usa tarifa blended por família com hipótese fixa de 75% input e 25% output. No Codex,
o preenchimento da janela pode ser autoritativo, mas a transformação de tokens em dólares
continua aproximada.

**Decisão:** não importar o modelo de billing. O `UsageModal` do OmniRift já separa input,
output, cache, modelo, projeto e chamadas. O Inspector deve consumir a mesma fonte e rotular
qualquer valor estimado explicitamente como estimativa.

### 4.7 Segurança e privacidade

Pontos positivos:

- servidores escutam em `127.0.0.1`;
- relay dev restringe CORS a origens localhost;
- hook limita body a 1 MiB;
- CSP da webview usa nonce em produção;
- a telemetria declara não enviar prompts, paths ou tool bodies.

Pontos incompatíveis ou insuficientes:

- `npx agent-flow-app` habilita telemetria por padrão;
- envia UUID persistente, sessões, duração, contagem, SO/arch, modelos e classes de erro a
  um Supabase fixo;
- hook server local não exige token;
- discovery files incluem PID, porta e path de workspace;
- raw reasoning/transcript é exibido e pode conter segredos;
- não há política de retenção durável porque não há persistência durável do transcript.

**Para o OmniRift:** zero telemetria; token por boot/agente; diretório 0700 e arquivos 0600;
redação antes do SQLite; paths relativos por default; modo de transcript completo opt-in.

---

## 5. Onde o OmniRift já está à frente

| Capacidade | Agent Flow | OmniRift atual |
|---|---|---|
| Dono do processo | Não | `PtyManager`/`AcpManager` no backend |
| Sessão estruturada | Reconstruída de logs | ACP JSON-RPC/stdio |
| Tool call ID | Perdido em parte da UI | Mantido no `AgentNode` |
| Permissão | Detectada/visual | Request/response real inline |
| Diffs | Resumo/preview | Payload semântico e ReviewNode |
| Conexão entre agentes | Visual | Comando, time, pipe e payload |
| Worktree/floor | Não | Nativo |
| Memória | Não | Provider plugável + blackboard |
| Orquestração | Não | MCP, claims, Goals, watchdog, Routines |
| Histórico durável | Não normalizado | SQLite de sessões/ciclo de vida |
| Uso real | Parcial/estimado | Input/output/cache/modelo/projeto |
| Telemetria | Opt-out no `npx` | Nenhuma |

Arquivos do OmniRift que formam a base:

- `apps/desktop/src-tauri/src/acp/mod.rs`: log observável, seq e attach.
- `apps/desktop/src/components/nodes/AgentNode.tsx`: tool calls, diffs, usage e permissões.
- `apps/desktop/src-tauri/src/commands/review_cfg.rs`: settings/hooks por agente.
- `apps/desktop/src-tauri/src/mcp/server.rs`: endpoint de status do worker.
- `apps/desktop/src/lib/session-client.ts`: recorder SQLite.
- `apps/desktop/src/components/SessionHistoryModal.tsx`: histórico/timeline atual.
- `apps/desktop/src/components/UsageModal.tsx`: token/custo real.

---

## 6. A lista do que adotar

### P0 — construir nativamente

| Item | Origem da ideia | Destino OmniRift |
|---|---|---|
| Evento estruturado dos workers Claude PTY | hooks + transcript | Hook listener Rust + session ledger |
| Watcher/parser de rollouts Codex | Codex runtime | `src-tauri/src/observability/codex/` |
| IDs nativos ponta a ponta | correção sobre o Agent Flow | schema `RunEvent` |
| Persistência append-only | gap do Agent Flow | SQLite |
| Inspector por nó/sessão | canvas + painéis | TerminalNode, AgentNode e Histórico |
| Redação/retention | requisito OmniRift | antes de persistir |

### P1 — alto valor depois do núcleo

- Anexar sessão Claude/Codex iniciada fora do OmniRift.
- Replay temporal com seek e velocidades.
- File heatmap por agente, floor, turno e sessão.
- Caminho crítico: tools/subagentes que mais consumiram tempo.
- Comparação entre duas execuções da mesma task.
- Export/import de trace sanitizado para bug report.
- Alertas locais: tool presa, repetição, custo anômalo, taxa de erro.

### Não adotar

- Next.js/relay SSE no desktop.
- D3/Canvas 2D como segundo canvas principal.
- Configuração global automática do Claude.
- Telemetria, mesmo opt-out.
- Cálculo blended de custo.
- Nome humano como identidade.
- Dedup por janela temporal como regra principal.
- Estado de sessão pertencendo ao React.

---

## 7. Design alvo: Inspector de Execução

### 7.1 Princípios

1. **Backend-owned:** ingestão, normalização, correlação e persistência vivem em Rust.
2. **Append-only:** eventos brutos normalizados não são reescritos; projeções podem ser
   reconstruídas.
3. **IDs autoritativos:** nunca reduzir ID nativo a label/nome.
4. **Múltiplas fontes:** ACP, hook, transcript e rollout implementam adapters explícitos.
5. **Fonte/confiança visível:** dado inferido não se passa por fato autoritativo.
6. **Local/private by default:** sem rede, com redação e retenção limitada.
7. **Canvas continua espacial:** execução temporal aparece no detalhe da sessão.

### 7.2 Schema lógico

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunEvent {
    pub id: String,
    pub session_id: String,
    pub node_id: Option<String>,
    pub turn_id: Option<String>,
    pub parent_id: Option<String>,
    pub native_event_id: Option<String>,
    pub native_call_id: Option<String>,
    pub runtime: RuntimeKind,       // acp | claude | codex | shell
    pub source: EventSource,        // protocol | hook | transcript | inferred
    pub confidence: EventConfidence,// authoritative | observed | inferred
    pub kind: RunEventKind,
    pub occurred_at_ms: i64,
    pub monotonic_seq: u64,
    pub duration_ms: Option<u64>,
    pub payload: serde_json::Value,
    pub redaction: RedactionState,
}
```

Kinds mínimos:

```text
session.started | session.ended | session.resumed
turn.started    | turn.completed | turn.failed | turn.cancelled
agent.spawned   | agent.completed
tool.started    | tool.updated   | tool.completed | tool.failed
message.user    | message.assistant | message.thought
permission.requested | permission.resolved
usage.updated   | context.compacted
file.read       | file.edited    | file.created
plan.updated    | error
```

### 7.3 Persistência SQLite

Evolução sugerida, aditiva ao recorder existente:

```sql
CREATE TABLE run_events (
  id              TEXT PRIMARY KEY,
  session_id      TEXT NOT NULL,
  node_id         TEXT,
  turn_id         TEXT,
  parent_id       TEXT,
  native_event_id TEXT,
  native_call_id  TEXT,
  runtime         TEXT NOT NULL,
  source          TEXT NOT NULL,
  confidence      TEXT NOT NULL,
  kind            TEXT NOT NULL,
  occurred_at_ms  INTEGER NOT NULL,
  monotonic_seq   INTEGER NOT NULL,
  duration_ms     INTEGER,
  payload_json    TEXT NOT NULL,
  redaction       TEXT NOT NULL DEFAULT 'sanitized',
  FOREIGN KEY(session_id) REFERENCES agent_sessions(id) ON DELETE CASCADE
);

CREATE UNIQUE INDEX idx_run_events_native_dedup
  ON run_events(session_id, source, native_event_id)
  WHERE native_event_id IS NOT NULL;

CREATE INDEX idx_run_events_timeline
  ON run_events(session_id, occurred_at_ms, monotonic_seq);

CREATE INDEX idx_run_events_turn
  ON run_events(session_id, turn_id);
```

`session_events` pode continuar atendendo ciclo de vida legado durante a migração. A UI nova
lê `run_events`; um backfill não é obrigatório.

### 7.4 Adapters de ingestão

```text
observability/
  mod.rs
  event.rs             # RunEvent + enums + invariantes
  registry.rs          # session/node/runtime mapping
  normalizer.rs        # dedup, autoridade, correlação
  redactor.rs          # segredo/path/content budgets
  store.rs             # batch insert/query/retention
  acp.rs               # session/update → RunEvent
  hooks/
    mod.rs
    claude.rs           # stdin hook payload → RunEvent
    auth.rs             # token por boot/agente
  codex/
    watcher.rs
    parser.rs
    types.rs
  projection/
    timeline.rs
    transcript.rs
    file_attention.rs
```

Não criar uma trait tão abstrata que apague diferenças dos runtimes. Um envelope comum e
adapters explícitos é suficiente; Claude, Codex e ACP têm semânticas distintas.

### 7.5 Hook Claude por agente

Estender o `agent-settings-<label>.json` atual com:

- `SessionStart`;
- `UserPromptSubmit`;
- `PreToolUse`;
- `PostToolUse`;
- `PostToolUseFailure`;
- `SubagentStart`;
- `SubagentStop`;
- `Notification`;
- `Stop`;
- `SessionEnd`.

Em vez de construir JSON no shell, gerar um script gerenciado no app-data que:

1. lê o payload bruto do stdin;
2. lê endpoint/token vivos de arquivo 0600;
3. envia body com limite e timeout curto;
4. nunca imprime conteúdo no stdout do agente;
5. sempre falha aberto;
6. sai antes do timeout do hook;
7. inclui um identificador do node/session criado no spawn.

O endpoint `/agent-hook/{label}` atual deve ganhar autenticação antes de aceitar payload
rico. O token do MCP control plane já fornece o padrão de comparação e rotação por boot.

### 7.6 UI

Entradas:

- Botão `⌁`/“Execução” no header do TerminalNode e AgentNode.
- Clique numa sessão do Histórico abre o mesmo inspector em modo read-only.
- Badge discreto durante execução: tools ativas, duração e erros.

Painéis do Inspector:

1. **Timeline:** lanes por agente/subagente; blocos thinking/tool/wait/error.
2. **Eventos:** lista virtualizada e filtrável por kind/agente/tool/status.
3. **Transcript:** user/assistant/thought/tool, com conteúdo sensível colapsado.
4. **Arquivos:** reads/edits/tokens/duração/último acesso/agentes.
5. **Custo:** consome a fonte do UsageModal; estimativas rotuladas.
6. **Grafo:** opcional; árvore temporal derivada, sem mover os nós do canvas principal.

Começar por timeline + lista + transcript. O grafo animado é polish, não fundação.

### 7.7 Privacidade e retenção

Três níveis locais:

| Modo | Default | Guarda |
|---|---:|---|
| Metadados | Sim | kind, duração, status, tool e path relativo sanitizado |
| Diagnóstico | Não | args/resultados resumidos e diffs limitados |
| Transcript completo | Não | mensagens/reasoning local, com aviso e retenção explícita |

Regras:

- Nunca persistir token, env completo, header auth ou secret detectado.
- Aplicar fingerprints já usados em `capability-risk` antes do SQLite.
- Path absoluto vira relativo ao workspace quando possível.
- Payloads têm budgets por kind.
- “Apagar sessão” remove eventos e projeções associadas.
- Retention configurável por dias/tamanho; default conservador.
- Export só sanitizado por default.

---

## 8. Fases de implementação

### Fase A — fundamento autoritativo

- `RunEvent` + enums e validação.
- Tabela `run_events` + queries paginadas.
- Adapter ACP alimentando o ledger.
- Eventos Tauri com seq e dedup.
- Testes de invariantes/correlação/redação.

**Entrega observável:** OmniAgent atual passa a ter histórico estruturado durável sem mudar a
UI principal.

### Fase B — workers Claude PTY

- Script de hook gerenciado e autenticado.
- Extensão dos eventos no settings por agente.
- Mapping label/node/session estável.
- Pre/PostToolUse e subagentes no ledger.
- Fallback de status atual preservado.

**Entrega observável:** TerminalNode Claude mostra tool calls reais ao vivo.

### Fase C — Codex

- Watcher de `$CODEX_HOME/sessions` em Rust.
- Parser dos cinco tipos de rollout.
- Tokens/context window autoritativos.
- Compactação e linhas parciais/truncagem.
- Mapping de `spawn_agent`, `wait_agent`, `send_message` e afins quando presentes.

**Entrega observável:** TerminalNode Codex e sessões externas passam a ser inspecionáveis.

### Fase D — Inspector MVP

- Drawer/modal por sessão.
- Timeline simples.
- Lista virtualizada de eventos.
- Transcript filtrável.
- Drill-down de tool call e erro.
- Integração com Histórico.

### Fase E — inteligência e replay

- File attention/heatmap.
- Replay/seek.
- Caminho crítico e tools lentas.
- Repetição/falha/custo anômalo.
- Export/import sanitizado.
- Attach de sessão externa pelo canvas.

---

## 9. Gates de qualidade

### Backend/unit

- Cada `tool.started` com ID termina exatamente uma vez.
- Dois `Read` concorrentes não se cruzam.
- Duplicata hook+transcript converge para um evento/projeção.
- Evento atrasado não reabre tool já finalizada sem regra explícita.
- Arquivo truncado reinicia offset sem duplicar o ledger.
- Linha JSONL parcial é reconstituída.
- Compactação Codex reinicia projeção de contexto corretamente.
- Mesmo label em dois subagentes mantém duas identidades.
- Payload acima do budget é truncado e marcado.
- Segredos conhecidos não aparecem no SQLite.
- Retenção remove somente sessões elegíveis.

### Frontend/unit

- Reducer/projeção de timeline determinística.
- Filtros não alteram a fonte de eventos.
- Seek até `t` gera a mesma projeção que replay sequencial até `t`.
- Estimativa é visualmente diferenciada de métrica autoritativa.

### UI/DOM

Seguindo a convenção do repo, afirmar o que renderiza:

- tool ativa aparece no DOM;
- tool concluída muda de status visível;
- erro mostra detalhe;
- transcript sensível inicia colapsado;
- sessão histórica abre timeline;
- dois subagentes homônimos aparecem como duas lanes;
- evento truncado exibe aviso;
- apagar sessão remove a linha da tela após confirmação.

### Stress

- 10 agentes, 10 mil eventos e 2 mil mensagens sem crescimento ilimitado do DOM.
- Floor oculto continua ingerindo no backend sem render loop.
- Abrir o Inspector faz replay paginado, não carrega todo o SQLite.
- Windows: casing, drive letter, CRLF e WebView2.
- Linux: inotify perdido → polling recupera.

---

## 10. Riscos e casos de borda

| Risco | Mitigação |
|---|---|
| Schema JSONL privado muda | parser tolerante, fixtures por versão, unknown passthrough |
| Hook atrasa o agente | timeout curto, fail-open, body limitado, envio best-effort |
| Hook e transcript duplicam | native IDs + precedência de fonte |
| Raw transcript contém segredo | níveis de captura + redactor + budgets |
| SQLite cresce muito | retention, payload caps, paginação, índices |
| UI vira um segundo produto/canvas | Inspector subordinado ao node/session |
| Métrica estimada parece cobrança real | confidence/source e rótulo explícito |
| Sessão externa mapeada ao floor errado | resolver por cwd/worktree e pedir confirmação |
| Subagente não expõe identidade | ID sintético escopado ao parent call, nunca só label |
| Tool termina sem start | evento orphan preservado e projeção marcada incompleta |
| App reinicia com tool em voo | recovery marca `interrupted/unknown`, não inventa sucesso |

---

## 11. Licença

Agent Flow é Apache-2.0; OmniRift é MIT. Ideias e arquitetura podem ser reimplementadas.
Copiar código/fixtures substanciais exige manter a licença Apache, notices aplicáveis e avisos
de modificação nos arquivos derivados. O nome e logos “Agent Flow” têm política de trademark
separada e não devem ser usados no produto.

Recomendação: implementação nativa/clean-room baseada nos comportamentos documentados e em
fixtures geradas pelas próprias instalações Claude/Codex do time. Se algum arquivo for
derivado diretamente, registrar origem e licença em `THIRD_PARTY_NOTICES`.

---

## 12. Mapa de fontes

### Agent Flow

- README/features/privacy: <https://github.com/patoles/agent-flow>
- Codex parser:
  `extension/src/codex-rollout-parser.ts`
- Codex watcher:
  `extension/src/codex-session-watcher.ts`
- Claude transcript parser:
  `extension/src/transcript-parser.ts`
- Hook server/config/discovery:
  `extension/src/{hook-server,hooks-config,discovery}.ts`
- Protocolo:
  `extension/src/protocol.ts`
- Relay/buffer/SSE:
  `scripts/relay.ts`
- Telemetria:
  `scripts/telemetry.ts`, `scripts/telemetry/*`
- Simulação/reducer:
  `web/hooks/use-agent-simulation.ts`, `web/hooks/simulation/*`
- Canvas/painéis:
  `web/components/agent-visualizer/*`
- Custos/model families:
  `web/lib/canvas-constants.ts`
- CI:
  `.github/workflows/ci.yml`
- Changelog:
  `extension/CHANGELOG.md`
- Licença/trademark:
  `LICENSE`, `TRADEMARK.md`

### OmniRift

- ACP backend-owned: `apps/desktop/src-tauri/src/acp/mod.rs`
- Nó ACP: `apps/desktop/src/components/nodes/AgentNode.tsx`
- Hook/status do worker: `apps/desktop/src-tauri/src/commands/review_cfg.rs`
- Endpoint loopback: `apps/desktop/src-tauri/src/mcp/server.rs`
- PTY: `apps/desktop/src-tauri/src/pty/`
- Session recorder: `apps/desktop/src/lib/session-client.ts`,
  `apps/desktop/src-tauri/src/db.rs`
- Histórico: `apps/desktop/src/components/SessionHistoryModal.tsx`
- Uso/custo: `apps/desktop/src/components/UsageModal.tsx`,
  `apps/desktop/src-tauri/src/commands/usage.rs`
- Redação/riscos: `apps/desktop/src/lib/capability-risk.ts`
- Arquitetura ACP existente: `docs/omniagent-acp-features.md`

---

## 13. Decisão final

**Construir:** Inspector de Execução nativo, com eventos estruturados dos workers PTY,
persistência local e adapters Claude/Codex/ACP.  
**Não construir:** outro canvas, relay Node, telemetria ou billing estimado paralelo.  
**Primeiro corte:** ledger + ACP + hooks Claude; depois Codex; por último replay/grafo/polish.

O diferencial resultante é maior que o do Agent Flow: o usuário não apenas vê o que seus
agentes fizeram — ele vê isso no mesmo lugar onde os criou, conectou, isolou em worktrees,
deu memória, aprovou permissões e controlou o fluxo.
