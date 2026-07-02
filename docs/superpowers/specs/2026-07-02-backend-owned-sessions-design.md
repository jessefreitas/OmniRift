# Backend-owned sessions (ACP) — nó ANEXA, não possui — Design

> Status: **draft** · 2026-07-02 · task #19. Irmã de `2026-06-25-terminal-backend-owned-design.md`
> (PTY) e continuação de `2026-06-30-acp-agent-layer-design.md` (aposta ACP).

**Problema:** o ciclo de vida da sessão ACP vive no MOUNT do `AgentNode.tsx`: o useEffect
(`[reloadKey]`) gera um `session_id` novo (nanoid) por montagem, spawna, e o cleanup do unmount
chama `acpCancel` → **mata o subprocesso**. Todo o estado (msgs, usage, permission pendente,
`acpSessionIdRef` p/ resume) é React state/ref — morre junto. Hoje a troca de floor/projeto só não
mata agentes porque TODOS os FloorCanvas ficam montados em `display:none` (`Canvas.tsx`) — gambiarra
que custa N ReactFlows vivos e **proíbe `onlyRenderVisibleElements`** (virtualizar = desmontar =
matar). Qualquer caminho que desmonte de verdade (restoreWorkspace/abrir projeto, closeFolder,
closeProject) mata e re-spawna do zero; sleep/wake e restore são remendos por cima. Os PTYs já
resolveram isso pela metade: `PtyManager`+`TermEmulator` são a fonte da verdade e o `TerminalNode`
re-anexa via `pty_snapshot`/`config.attach` (`useTerminalSession.ts`) — **é a referência**.

## 1. Objetivo e não-objetivos

**Objetivo:** desacoplar sessão ACP de mount. O `AcpManager` (que JÁ possui o processo) passa a
possuir também o **estado observável** (status + buffer de eventos + permission pendente); o
`AgentNode` vira **view descartável que anexa** — mesmo contrato do PTY. Destrava: virtualização
React Flow, fim da obrigação de N ReactFlows montados, restore com resume real, sleep/wake 1ª classe.

**Não-objetivos:** NÃO migrar PTY (já é backend-owned; nada muda em `pty/`). NÃO mexer no protocolo
ACP nem no adapter (proxy transparente permanece). NÃO persistir a conversa em disco — cold-restart
usa o `session/load` do adapter (mecanismo de resume + fallback exit-129 já existem), não replay de
buffer. NÃO redesenhar a UI do nó (fullscreen via portal, dock, LOD ficam como estão).

## 2. Modelo proposto

**Rust — `acp/mod.rs`.** `AcpSession` ganha estado próprio (a mudança é de CONTRATO, não de dono):

- `state: Running | Sleeping | Dead` — `Running` = processo vivo; `Sleeping` = processo morto DE
  PROPÓSITO, entry mantida (`acp_session_id` + buffer) p/ wake via `session/load`; `Dead` = morte
  real (EOF/erro), buffer mantido p/ post-mortem até o nó ver.
- `event_log: VecDeque<(u64 seq, kind, Value)>` — TODO evento emitido (`ready`, `update`,
  `permission`, `turn-done`, `exit`, `auth-*`, `model-rejected`) entra no log ANTES do
  `app.emit(...)`, com `seq` monotônico por sessão na mesma escala do live (padrão do emulador PTY).
  Caps: N eventos (ex. 500) e bytes (ex. 2 MB); `agent_message_chunk` consecutivos são **coalescidos**
  numa entry (como o front já faz nas bolhas) — derruba o volume em ordens de grandeza.
- `pending_permission: Option<(req_id, params)>` — setado no request, limpo no respond. Sobrevive
  ao unmount: o adapter espera a resposta indefinidamente; o nó re-renderiza o pedido no attach.
- `last_ready: Value` — payload do último `acp://ready` (models/modes/configOptions), p/ o attach
  reconstruir dropdown de modelo sem esperar novo handshake.

**Comandos novos/alterados (`commands/acp.rs`):**
- `acp_attach(session_id) -> AcpSnapshot { state, acpSessionId, lastReady, events, pendingPermission, seq }`
  — espelho do `pty_snapshot`. Erro se a sessão não existe (→ front spawna).
- `acp_kill(session_id)` — o `cancel()` de hoje (remove + kill). Chamado SÓ em remoção explícita.
- `acp_cancel(session_id)` — passa a SÓ cancelar o turno (`session/cancel`), sem matar.
- `acp_sleep(session_id)` — mata o processo, marca `Sleeping`, preserva entry. Wake = `acp_spawn`
  com `resume_session_id` (o backend já sabe o seu) reusando a MESMA entry/buffer.
- `acp_gc(known_ids: Vec<String>)` — reaper: mata sessões cujo id não está em nenhum nó do canvas.

**Front — `AgentNode.tsx`:**
- `session_id` **estável** = `data.id` do nó (hoje: nanoid por mount). Reload/troca de provider
  seguem re-spawnando pelo mesmo id (kill + spawn, id reusado).
- Mount: subscreve listeners (por session_id, com dedup por `seq` — padrão pronto do
  `useTerminalSession`) → `acp_attach`; sucesso = re-hidrata `msgs` (replay do log → bolhas),
  status, model/usage, permission pendente. Falha (sessão não existe) = `acp_spawn` (criação/wake).
  Corrida attach×live: buffer-durante-snapshot + filtro de seq, igual `replayFromSnapshot`.
- Cleanup do unmount: **só** unlisten + `acpAgentUnregister`. NENHUM cancel/kill.
- Kill explícito: `removeNode` (X) dispara `acp_kill`; fechar floor/projeto dispara p/ os nós deles.
- Resume pós-restart: no `ready`, `patchNode(data.id, { acpSessionId })` — persiste no workspace
  (hoje é só ref, perde-se). Boot/restore: `acp_attach` falha → spawn com
  `resumeSessionId: data.acpSessionId` → `session/load` (fluxo + fallbacks já existentes).
- Fullscreen/dock: sem mudança (portal reusa a mesma árvore); deixam de ser risco de re-mount caro.
- `acp_agent_register` (label→id) move p/ o backend no ready (o front deixa de ser o único que sabe).

## 3. Ciclo de vida (contrato)

| Gatilho | Antes | Depois |
|---|---|---|
| criar nó | spawn no mount | spawn explícito (attach falhou → spawn) |
| fechar nó (X) / fechar floor/projeto | cancel no unmount | `acp_kill` explícito no removeNode |
| trocar floor / virtualização / re-mount | morte (se desmontasse) | **NADA morre** — attach re-hidrata |
| reload subagentes / troca de provider | re-spawn | igual (kill+spawn, mesmo id) |
| app restart | sessão nova, conversa perdida | spawn + `session/load` via `data.acpSessionId` persistido |
| sleep/wake | inexistente | `acp_sleep` / spawn-resume — 1ª classe (base p/ economizar RAM de frota) |

## 4. Migração incremental (3 fases shippáveis)

- **F1 — buffer + attach (aditivo, zero mudança de contrato).** `event_log`+`seq`+`pending_permission`
  no Rust; `acp_attach`; front tenta attach antes de spawnar e re-hidrata. Cleanup AINDA cancela
  (comportamento externo idêntico). Valor: re-mounts deixam de perder estado; groundwork testável.
- **F2 — inverter a posse.** Remove o cancel do cleanup; `acp_kill` no `removeNode`/close-floor/
  close-project; `session_id = data.id`; persiste `data.acpSessionId` no ready; `acp_gc` no
  restoreWorkspace (ids remapeados → sessões antigas viram órfãs → reaper mata). Valor: troca de
  floor/restore sem matar agente; restore resume a conversa.
- **F3 — colher a virtualização.** Liga `onlyRenderVisibleElements` no `FloorCanvas` (agentes e
  PTYs já sobrevivem a unmount); integra com o LOD existente (nó fora do viewport nem monta; perto
  do limiar, LOD atual). Follow-up (fora do escopo #19): parar de montar FloorCanvas inativos.

## 5. Riscos e mitigação

- **Sessões órfãs** (nó removido sem kill, restore remapeia ids, crash do front) → `acp_gc(known_ids)`
  chamado no restoreWorkspace e num tick lento; `Dead` sem attach há X min também é colhida.
- **Memória do buffer** → caps duplos (eventos+bytes) + coalescing de chunks; estourou = trunca do
  início e marca `truncated` no snapshot (o nó mostra "… histórico truncado", conversa REAL segue
  viva no adapter — buffer é só view).
- **Corrida attach × eventos live** → seq monotônico compartilhado log/emit + buffer-durante-attach
  no front (padrão já validado no PTY, GLM-audit #1–4).
- **Double-attach** (StrictMode double-mount, futuro multi-view) → attach é idempotente/read-only;
  listeners dedupam por seq; register de label já é idempotente.
- **Permission pendente atravessando unmount** → vive no backend; attach re-exibe; respond limpa.
- **Msgs re-hidratadas ≠ transcript completo** (cap do log) → aceito por design: fonte da verdade
  da conversa é o adapter (session/load); o buffer é só a janela visível — igual scrollback do PTY.
- **`data.acpSessionId` stale** (adapter não retoma) → fallback já existente: session/load falha →
  session/new; exit-129 → sessão nova (commit `13216fb`).

## 6. Estimativa

| Fase | Esforço | Risco |
|---|---|---|
| F1 buffer+attach | ~1–1.5 dia (Rust log/caps/attach + front re-hidratação) | baixo (aditivo) |
| F2 posse invertida | ~1 dia (kill explícito, id estável, persistência resume, gc) | médio (contrato) |
| F3 virtualização | ~0.5–1 dia (flag + LOD + validação com frota barulhenta) | baixo (colheita) |

**Critério de aceite:** 4 agentes em 2 floors, trocar de floor 10×, ligar
`onlyRenderVisibleElements` e pan até sumirem do viewport → nenhuma sessão morre, conversa e
permission pendente re-hidratam; fechar e reabrir o projeto → agentes voltam via resume.
