# Orquestração inter-agente — STATUS da sessão 2026-07-09

> Documento de progresso: o que foi feito, o que está validado e o que ainda falta.
> Branch: **`spec/orquestracao`**. Nome "Conductor" foi **abortado** (colide com o produto
> conductor.build) → o sistema é o **Orquestrador** que já existe no código.

---

## 1. O que é

Camada de **comunicação ativa peer-a-peer** entre os agentes do canvas: um agente pergunta
a outro, avisa, ou espia o estado — sobre a orquestração que já existia (Orquestrador coroado,
teto/ondas, Times=Floor, claims/blackboard). Spec das 7 camadas em
`docs/superpowers/specs/2026-07-09-orquestracao-design.md`; plano em
`docs/superpowers/plans/2026-07-09-orquestracao.md`.

---

## 2. O que foi FEITO (validado: `cargo check` + `tsc` verdes; parser rodado standalone)

### Fase 4a — as 3 tools MCP novas
| Tool | O que faz | Onde |
|---|---|---|
| `agent_status(target)` | vê o que o agente faz **sem interromper** (estado + últimas linhas) | `mcp/tools.rs::orq_dispatch` |
| `agent_ask(target, question, from?, timeout_s?)` | pergunta e **espera** a resposta natural | `mcp/server.rs::orq_ask_and_wait` |
| `agent_tell(target, message, from?)` | avisa **fire-and-forget** | `mcp/server.rs::orq_deliver_msg` |

- Resolução de alvo: `mcp/server.rs::resolve_agent_fuzzy`.
- Formatação de mensagem: `mcp/marker.rs::incoming` (`[mensagem de {from}] {text}`).
- Routing: match EXATO em `mcp/server.rs::handle_jsonrpc` (não prefixo `agent_` — labels viram `agent_01`).
- Preâmbulo injetado no role: `Sidebar.tsx::mcpRoleText` const `ORQ_PREAMBLE`.

### Task 7 — identidade de quem pergunta
`from` é argumento opcional (o agente passa o próprio label; não há header por-agente no MCP SSE).
`orq_from` normaliza o `@`, default `@orquestrador`.

### Rename Conductor → Orquestrador
Marcadores → `[[OMNIRIFT-*]]` (hoje quase só o prefixo `[mensagem de ...]`), funções `conductor_*` → `orq_*`,
docs renomeadas. Branch renomeada `spec/conductor` → `spec/orquestracao`.

### FIX "agentes não conversam" (debug ao vivo com screenshot de 2 GLM52)
Três causas raiz, todas corrigidas:
1. **`agent_ask` esperava um marcador `[[OMNIRIFT-REPLY id=N]]` que o LLM nunca emite** (ele responde
   em prosa) → travava até timeout. **Corrigido:** captura a resposta natural via *settle* do PTY
   (Working→Done), igual o `do_send_task` que já funcionava. Marcador de reply abandonado.
2. **Resolução era match EXATO de label** ("Security" não casava "Security GLM52" → "não registrado").
   **Corrigido:** `resolve_agent_fuzzy` (exato→palavra→substring, 2 sentidos).
3. **Registry apontava para sessão morta** (respawn dos GLM52) → "dormindo (dead)".
   **Corrigido:** fuzzy prefere sessão viva; `agent_ask`/`agent_tell` avisam claro se o alvo está morto.

**App rodando na tela com os fixes** (o `tauri:dev` recompila e reinicia sozinho ao salvar `src-tauri`).

---

## 3. O que FALTA

### Do fluxo de comunicação
- [ ] **Re-testar o chat de 2 agentes no app** (validação manual — é o teste que fecha a Fase 4a).
      Roteiro: `docs/superpowers/plans/2026-07-09-orquestracao-4a-validacao-manual.md`.
- [ ] **Task 12** — esconder o prefixo `[mensagem de @X]` do que o xterm mostra ao humano
      (hoje aparece na tela). Precisa verificação visual.
- [ ] **Fase 7** — monitor passivo ("avisa quando um agente termina"): hook em
      `lib/pty-global-sink.ts` (já escuta `agent://status`). ⚠️ `notify.ts` é **modal bloqueante** —
      precisa de um toast não-intrusivo (decidir com a tela à vista).
- [ ] **Fase 5** — barramento pub/sub (só se `memory_recall` por tag não bastar).
- [ ] **Fase 6** — FS guard / hard-claim. Provável **never** (Floor/worktree já é a garantia dura).

### Bugs pendentes (não resolvidos)
- [ ] **Agente deletado consta como "morto" no canvas ocupando memória/espaço.**
      Investigação parcial: `store/canvas-store.ts::removeNode` (l.1020) só age no **paralelo ativo**
      (`f.id !== s.activeParallelId` → early return) e **não limpa `terminalStatuses[sid]`**. Deletes:
      tecla = `FloorCanvas.tsx::deleteSelected`; X no card = `TerminalNode.tsx`; card dormant =
      `DormantTerminalCard`. Hipóteses a confirmar: (a) node em floor de fundo não é removido;
      (b) persistência/restore ressuscita como dormant/dead; (c) registry MCP não limpa no EOF
      (`registry.rs::unregister` existe mas o EOF em `pty/session.rs:359` não o chama). **Falta
      reproduzir + rastrear qual path foi usado.**
- [ ] **Spawn flaky do GLM52 / `claude-ollama`** (contribui pro fix #3): `claude-ollama` é função bash,
      não binário — spawn direto falha, só via `cli:"shell"`+startupCmd. Agentes morrem/respawnam
      (EOF loops), deixando sessões mortas no registry. Decisão A/B pendente (mem OmniMemory 507370).

---

## 4. Como rodar/testar (máquina de dev)

```bash
# relançar o app (se cair) — display :1, X11/GNOME
cd ~/Projetos/OmniRift
source ~/.omnirift-tauri-dev-env.sh
export DISPLAY=:1 XAUTHORITY=/run/user/1000/gdm/Xauthority \
       XDG_RUNTIME_DIR=/run/user/1000 DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus \
       GDK_BACKEND=x11 ; unset WAYLAND_DISPLAY
nohup npm run tauri:dev > /tmp/omnirift-dev-orq.log 2>&1 &

# teste do parser (link completo, na máquina com GTK)
cd apps/desktop/src-tauri && cargo test -p omnirift marker::
```

### Gotchas de build
- `cargo check -p omnirift --lib` **passa** (não linka). `cargo test`/build completo **linka** e
  precisa dos symlinks `.so` sem-versão em `/tmp/tauri-sysroot` (o linker quer `libgtk-3.so`, o
  sistema só tem `libgtk-3.so.0`). `/tmp` é volátil → somem no reboot. Recriar:
  ```bash
  SR=/tmp/tauri-sysroot/usr/lib/x86_64-linux-gnu; mkdir -p $SR
  for d in /lib/x86_64-linux-gnu /usr/lib/x86_64-linux-gnu; do
    for so0 in $d/*.so.0 $d/*.so.[0-9]; do [ -e "$so0" ]||continue
      b=$(basename $so0); u=${b%.so.*}.so; [ -e "$SR/$u" ]||ln -sf "$so0" "$SR/$u"; done; done
  ```
- Hook `pre_code_guard.py` bloqueia writes de código >30 linhas → `touch /tmp/ollama_bypass`.
- Display real é **`:1`** (socket X1), auth `/run/user/1000/gdm/Xauthority`. NÃO `:0`, NÃO Wayland.

---

## 5. Commits desta sessão (branch `spec/orquestracao`)

1. `docs(spec)` — spec Conductor (7 camadas) + absorve specs antigas
2. `docs(plan)` — plano de implementação
3. `feat` — Fase 4a (parser, agent_status/ask/tell, routing, preâmbulo)
4. `feat` — Task 7 (from via argumento)
5. `docs` — roteiro de validação manual
6. `refactor` — rename Conductor → Orquestrador (colisão de marca)
7. `fix` — 3 causas raiz de "agentes não conversam" (este é o estado atual)

---

## 6. Sessão noturna 2026-07-09/10 (autônoma, Jessé dormindo) — branch `feat/orquestracao-integrada`

### Validado ao vivo (screenshots do Jessé antes de dormir)
- ✅ **Fase 4a FUNCIONA de ponta a ponta**: "conversa com o frontend sobre se html é uma linguagem"
  → Orquestrador chamou `omnirift-agents` → Frontend respondeu naturalmente → edge animada.
  A validação manual pendente da seção 3 está FEITA.
- ⚠️ **Overhead dos hooks globais**: agentes spawnados herdam os 15 hooks do `~/.claude` do Jessé
  (failproof, local-review…) — o Frontend ficou 2m+ em "running stop hooks 11/15", o que atrasa o
  settle que o `agent_ask` espera. DECISÃO PENDENTE: spawnar agentes com config enxuta
  (CLAUDE_CONFIG_DIR isolado ou --settings) ou aceitar o custo.

### Fixes commitados nesta sessão
1. `0168d48` — **menu de engines invisível** (Codex/Hermes "não subiam"): o dropdown abre pra cima
   e era clipado pelo `overflow-hidden` do container da barra. + **autocomplete de @** (digitar @
   lista agentes do floor + @all/@idle, teclado completo) + **rename concluído**
   `ConductorBar.tsx → ConstructorBar.tsx` (tsc estava vermelho; em dev dava ReferenceError no boot).
2. `e3b3e1f` — **timestamp 12:27 fixo no painel**: backend stampa `orchestrator_log` em SEGUNDOS,
   front passava direto pro `Date` (ms) → 21/jan/1970. Normalizado na borda. + **aviso de agente
   ocupado**: mensagem pro agente busy entra na FILA do PTY e "nada acontece" — agora o log avisa.
3. (em validação) — **agente deletado ficava "morto" pra sempre**: `removeNode` só olhava o floor
   ativo (nó em floor de fundo nem era removido) e nunca limpava `terminalStatuses`; e o waiter do
   PTY não desregistrava a sessão morta do registry MCP (label fantasma → "dormindo (dead)").
   Fix nas 3 camadas: `canvas-store.ts::removeNode` (busca cross-floor + limpa status),
   `registry.rs::unregister_by_session`, `session.rs` (waiter desregistra no exit).

### Build
- `.deb` noturno em andamento (`/tmp/omnirift_build_night.log`); segundo build sai com o item 3.
- **NÃO reiniciei o app do Jessé** (agentes vivos no canvas) — instalar o .deb de manhã.

### Fechamento da noite (00:00)
- ✅ **`.deb` FINAL pronto** (= HEAD `5f43c22`, todos os fixes):
  `apps/desktop/src-tauri/target/release/bundle/deb/OmniRift_0.1.131_amd64.deb` (23:59)
  Instalar: `sudo dpkg -i` no caminho acima. (O "exit 1" nos logs de build é só a
  assinatura do updater — sem `TAURI_SIGNING_PRIVATE_KEY` local; o .deb sai normal.)
- ✅ Regression guard: `cargo test --lib` 593/593 (1 flaky de ambiente passou no re-run) + `tsc -b` + eslint.
- ✅ Branch pushada pro Forgejo (`omnirift-fj/feat/orquestracao-integrada`) — backup anti-divergência.
- 🧹 Lint pré-existente restante no ConstructorBar: `set-state-in-effect` na carga de config (não é desta noite).

### Decisões que esperam o Jessé (manhã)
1. **Hooks globais nos agentes spawnados** (15 hooks = 2min+ de stop hooks por turno) — isolar config ou aceitar.
2. **Task 12** — esconder `[mensagem de @X]` do xterm (precisa verificação visual).
3. **Fase 7** — toast não-intrusivo do monitor passivo (decidir com a tela à vista).
4. **Spawn flaky claude-ollama** — decisão A/B (mem 507370).
