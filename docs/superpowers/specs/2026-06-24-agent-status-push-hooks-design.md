# Status de Agente via Push-Hooks — Design

> Status: **active** · 2026-06-24. Aprendizado do teardown do ref (P0, "joia da coroa").
> Ver `docs/research/2026-06-24-ref-teardown-learnings.md` + memória `project-ref-teardown`.

**Goal:** Saber o estado real de cada agente (working/blocked/waiting/done) por **push** do próprio
agente (hooks), em vez de **adivinhar** pelo PTY (fg-pid + parse de tela), que é frágil por shell/TUI.

**Por quê:** o ref nunca lê o stream do PTY pra status — instala hooks na config do agente e recebe
POSTs normalizados. É muito mais confiável (sabe `done` de verdade, o tool em uso, se foi interrompido).
O OmniRift já tem TODA a infra pra isso: servidor MCP axum rodando + injeção de `--settings` com hooks
por agente + evento `agent://status` consumido pelo front. Falta só ligar os pontos.

---

## Arquitetura (encaixe no existente)
```
spawn claude → --settings <file> (já injetado) agora COM hooks de status
  agente, a cada evento (UserPromptSubmit/PreToolUse/Stop/Notification):
    curl POST http://127.0.0.1:<MCP_PORT>/agent-hook/<label>?state=<estado>[&tool=<x>]
       ↓
  axum (mcp/server.rs) nova rota /agent-hook/:label → mapeia → atualiza AgentStateMap
       ↓ emite o MESMO evento agent://status (já existente)
  front: terminalStatuses[sessionId] = state   (já consumido — zero mudança no front)
```

## Componentes / pontos de edição
1. **`src-tauri/src/mcp/server.rs`** — nova rota `POST /agent-hook/:label`:
   - lê `state` (e opcional `tool`) do **query param** (NÃO body JSON — evita inferno de quoting
     cross-platform no hook). Mapeia string→`AgentState` (working/blocked/waiting→Blocked/done→Done).
   - resolve `label`→`session_id` via `AgentRegistry` (já existe), atualiza `AgentStateMap`, e
     **emite `agent://status`** (mesmo `AgentStatusEvent` do detector.rs). Persiste `last-status`
     (opcional, p/ recovery). Sem auth (loopback 127.0.0.1 only).
2. **Injeção dos hooks** — onde hoje monta o `--settings` (`commands/mcp.rs` `agent_settings_config`
   + `agent-contract.ts`): **merge** (não sobrescrever o Stop hook do review) dos hooks do Claude Code:
   - `UserPromptSubmit` → `?state=working`
   - `PreToolUse` → `?state=working&tool=<...>` (tool do stdin é opcional no MVP; fixo working serve)
   - `Notification` (permissão/espera) → `?state=blocked`
   - `Stop` → `?state=done` (somado ao Stop hook de review já existente)
   - comando do hook = `curl -s -m 2 -X POST "http://127.0.0.1:<MCP_PORT>/agent-hook/<label>?state=..."`
     (curl existe no Win10+/Linux/Mac; query param = zero quoting). `<label>` e `<MCP_PORT>` embutidos
     no arquivo de settings montado no spawn (já é por-agente).
3. **Fallback**: `detector.rs` (fg-pid + tela) **continua** como fallback p/ shells e agentes sem hook.
   O hook é autoritativo p/ claude; se chega POST, ele ganha. (Sem hook → cai no detector de hoje.)
4. **Frontend**: **nada** — já consome `agent://status`/`terminalStatuses`.

## Estados
`AgentState` já existe (Working/Blocked/Done/Idle/Dead). Mapa do hook:
`working→Working`, `blocked|waiting→Blocked`, `done→Done`. (Idle/Dead seguem do detector/lifecycle.)

## Error handling / segurança
- Rota só em loopback (o servidor MCP já é 127.0.0.1). `label` desconhecido → 204 no-op (não 500).
- Hook com `-m 2` (timeout 2s) → nunca trava o agente se o app não responder.
- `>30 min` sem evento de um agente que estava Working → o detector/lifecycle já degrada; opcional
  sintetizar `Done` (como o ref). MVP: confia no Stop hook + fallback do detector.

## Testing
- Rust: `POST /agent-hook/x?state=done` com label registrado → AgentStateMap[x]=Done + evento emitido;
  label desconhecido → 204; state inválido → ignora. Mapa de string→AgentState (puro).
- Manual/integração: subir um claude agent, mandar um prompt, ver `working` no spawn e `done` no Stop
  (mais confiável que o parse de tela).
- Boot-test obrigatório antes de release.

## Faseamento
- **Fase A (MVP):** rota `/agent-hook/:label` + hooks Claude Code (working/blocked/done via query param)
  + merge com o Stop hook de review. Fallback detector intocado.
- **Fase B:** enriquecer (tool em uso via stdin, prompt, interrupted) + `last-status.json` recovery +
  hook do Codex.

## Decisões
1. Estado via **query param** (não JSON body) — portabilidade cross-platform do comando de hook.
2. Reusa a rota no **servidor MCP axum** existente (não abre porta nova).
3. Reusa o evento **`agent://status`** + `AgentStateMap` (front não muda).
4. **Merge** com o Stop hook de review existente (não sobrescreve).
5. Detector PTY vira **fallback** (shells / agentes sem hook), não é removido.
