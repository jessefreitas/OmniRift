# Spec — Motor de Detecção de Estado de Agente (herdr → maestri, Sub-projeto A)

- **Data:** 2026-06-12
- **Status:** Aprovado (design) — aguardando revisão do spec
- **Referência:** [github.com/ogulcancelik/herdr](https://github.com/ogulcancelik/herdr) (AGPL-3.0 — usado como **referência de padrões**, não cópia de código)
- **Autor:** brainstorming Jesse + Claude

---

## 0. Contexto: decomposição em 3 subsistemas

O herdr é um "multiplexador de agentes" de terminal cujo valor real, traduzido pro canvas do maestri, são 3 subsistemas independentes construídos **fundação-primeiro**:

| # | Subsistema | herdr | Estado no maestri hoje | Depende de |
|---|-----------|-------|------------------------|-----------|
| **A** | **Motor de detecção de estado** | detecção `idle/working/blocked/done` por foreground process + output | ⚠️ heurística ingênua de 2s (`useTerminalSession.ts`) | — |
| B | API de orquestração | socket API `pane.*`, `wait`, `events` | 🟡 `mcp/server.rs` (1 tool/agente + `send_task`) | A |
| C | Modelo workspace/tab | Workspace→Tab→Pane | 🟡 stub `workspace.rs` (save/load de arquivo) | — |

O que **não** se porta (TUI-específico já resolvido pelo canvas GPU): 18 temas, mouse-split, seleção copy-friendly, attach SSH.

**Este spec cobre apenas o Sub-projeto A.** B e C terão seus próprios specs (`spec → plano → build`). A é a fundação: o `wait agent-status` e o `events.subscribe` de B consomem o estado que A produz.

---

## 1. Problema

Detecção de estado atual, em `apps/desktop/src/hooks/useTerminalSession.ts`:

```ts
unlistenOutput = await listenPtyOutput(sessionId, (data) => {
  term.write(data);
  setTerminalStatus(sessionId, "busy");        // qualquer byte = busy
  busyTimerRef.current = window.setTimeout(() => {
    setTerminalStatus(sessionId, "idle");       // 2s sem byte = idle
  }, 2000);
});
```

Problemas:
- Só distingue "saiu byte / não saiu byte". Nunca detecta **blocked** (agente parado esperando uma confirmação do usuário) nem **done** (terminou a tarefa e está no prompt, mas você ainda não olhou).
- A heurística de 2s mente: um agente "pensando" sem emitir output vira `idle` falsamente; um agente que só imprimiu um spinner fica `busy` pra sempre.

O herdr resolve isso com **2 sinais** que agora estão disponíveis no stack do maestri (confirmado: `portable-pty 0.9` expõe `MasterPty::process_group_leader()`).

## 2. Objetivo e critérios de sucesso

Substituir a heurística por um classificador de 4 estados por sessão PTY, emitido como evento `agent://status`, dirigido por foreground process + padrões de tela com perfis por agente.

Sucesso quando:
- [ ] Um Claude Code rodando uma tarefa longa mostra `working` enquanto produz/pensa e **não** cai pra `idle` no meio.
- [ ] Um Claude Code parado num prompt de confirmação (`Do you want to proceed?`) mostra `blocked`.
- [ ] Um Claude Code que terminou e voltou ao input box mostra `done` (e vira `idle` ao focar o nó).
- [ ] Um shell no prompt mostra `idle`; processo encerrado mostra `dead`.
- [ ] O estado vive num `AgentStateMap` central consultável e assinável (contrato pro Sub-projeto B).
- [ ] Classificador coberto por testes unitários com capturas reais (sem PTY de verdade).

## 3. Os dois sinais

### 3.1 Foreground process (`process_group_leader`)

`session.master.process_group_leader() -> Option<pid_t>` devolve o líder do grupo de processos em **foreground** do PTY. Lê-se `/proc/<pid>/comm` (Linux) pra obter o nome do processo.

- Captura-se o **pid do processo raiz** (o que o maestri spawnou) via `child.process_id()` em `PtySession::spawn`, antes do `child` ser movido pra thread de `wait`.
- Classificação:
  - `fg_pid == root_pid` → o processo raiz está no controle (shell no prompt, ou agente no seu próprio loop).
  - `fg_pid != root_pid` → um subprocesso está em foreground → **definitivamente `working`** (ex.: Claude rodando uma tool de bash).
  - `comm(fg_pid)` casa com `proc_names` do perfil → agente ativo; casa com um shell conhecido (`bash/zsh/sh/fish`) sob perfil de agente → o agente abriu um shell (working).

O foreground é sinal **corroborante**; o classificador primário pra agentes é o padrão de tela (3.2). Pra `role = shell` puro, o foreground é o sinal principal (root no prompt = idle).

### 3.2 Buffer de tela + atividade

Tap no `output_tx` (broadcast `Vec<u8>` que **já existe** em `session.rs:47`, hoje consumido por pipes/MCP). O detector:
- atualiza `last_activity: Instant` a cada chunk;
- mantém um **bottom buffer** rolante (≈ últimos 2 KB / 20 linhas, sem ANSI), via `clean_terminal_output` promovido a módulo compartilhado (ver §6);
- `now - last_activity < quiet_ms` → atividade recente → `working`.

## 4. Máquina de estados

Estados: `Working`, `Blocked`, `Done`, `Idle`, `Dead` (interno inicial: `Unknown`).

Entradas: chegada de bytes; tick de poll (~300 ms); `fg` (classificação foreground §3.1); match do bottom buffer (`blocked` / `ready`); evento de saída do processo; evento de foco do nó (frontend, opcional).

Constantes (tunáveis): `POLL = 300ms`, `QUIET = 400ms`.

Lógica por tick (se não `Dead`):

```
quiescent = (now - last_activity) > QUIET

se evento de saída recebido        → Dead         (terminal)
senão se !quiescent                → Working
senão se bottom ~ blocked_pattern  → Blocked
senão se fg == shell-no-prompt
        e perfil == shell           → Idle
senão se bottom ~ ready_pattern (agente no input box):
        prev ∈ {Working, Blocked}   → Done
        prev == Done                → Done         (até foco)
        prev ∈ {Idle, Unknown}      → Idle
senão                               → mantém estado anterior
```

Transição de foco (opcional v1): nó em `Done` recebe foco no canvas → `Idle`.
Bytes chegando sempre marcam `Working` imediatamente (sem esperar o tick), exceto se `Dead`.

Mapa de cores (frontend, padrão herdr): 🔴 `blocked` · 🟡 `working` · 🔵 `done` · 🟢 `idle` · ⚫ `dead`.
(Nota: o `StatusDot` atual usa vermelho pra "dead" — dead passa a cinza.)

## 5. Perfis de agente (manifests do herdr, em Rust)

```rust
pub struct AgentProfile {
    pub name: &'static str,            // "claude" | "codex" | "shell"
    pub proc_names: &'static [&'static str],   // match em /proc/<pid>/comm
    pub blocked_patterns: Vec<Regex>,  // bottom buffer → Blocked
    pub ready_patterns:   Vec<Regex>,  // bottom buffer → input box pronto
}
```

Built-ins v1:

- **`claude`** (Claude Code) — `proc_names: ["claude","node"]`; `ready`: linha `^\s*[❯>]\s*$` e a caixa de input; `blocked`: `Do you want`, `\(y/n\)`, `❯\s*1\.`, `Press enter`, `│\s*>`. Seed reaproveita o `is_cc_idle` que já existe em `mcp/server.rs`.
- **`codex`** — `proc_names: ["codex"]`; padrões análogos.
- **`shell`** (fallback genérico) — `proc_names: ["bash","zsh","sh","fish"]`; `ready`: prompt de shell (`[$#❯]\s*$`); sem semântica de agente → só `idle`/`working`.

Seleção do perfil por sessão: no spawn, casa o basename de `cfg.command` / `role` (`AgentRole`) contra os perfis; fallback `shell`. Perfil escolhido fica guardado por sessão.

**v1 é built-in em Rust** (struct + `OnceLock`). A struct é desenhada pra virar TOML carregável depois — **fora de escopo agora** (YAGNI).

## 6. Módulo compartilhado de texto de terminal

Hoje há **3** implementações de strip-ANSI/linha: `manager.rs` (relay de pipe), `mcp/server.rs` (`clean_terminal_output` + `flush_line`), e a que o detector precisa. Extrair pra `pty/text.rs`:

- `pub fn clean_terminal_output(bytes: &[u8]) -> String`
- `pub fn bottom_lines(bytes: &[u8], n: usize) -> String`

O detector usa este módulo. Refatorar `mcp/server.rs` e o relay de `manager.rs` pra usá-lo é **melhoria alvo recomendada** (reduz 3 cópias → 1), mas pode ser feita junto ou como follow-up imediato; não bloqueia A.

## 7. Arquitetura Rust

Arquivos novos:
- `apps/desktop/src-tauri/src/pty/detector.rs` — `StateDetector`, classificador (função pura) e máquina de estados.
- `apps/desktop/src-tauri/src/pty/profile.rs` — `AgentProfile` + built-ins + seleção por sessão.
- `apps/desktop/src-tauri/src/pty/text.rs` — texto compartilhado (§6).

`AgentState` (enum serializável) e o evento:

```rust
#[derive(Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentState { Working, Blocked, Done, Idle, Dead }

#[derive(Clone, Serialize)]
pub struct AgentStatusEvent {
    pub session_id: SessionId,
    pub state: AgentState,
    pub agent: String,          // nome do perfil
    pub message: Option<String> // ex.: linha do prompt de confirmação
}
```

`StateDetector` — um por sessão, criado pelo `PtyManager::spawn`:
- task async assina `output_tx` → atualiza `last_activity` + bottom buffer + dispara `working` imediato;
- loop de poll (`POLL`) → lê `process_group_leader()` + roda o classificador puro → se o estado mudou: emite `agent://status` (via `AppHandle::emit`), grava em `AgentStateMap` e publica no broadcast de estado.

`PtyManager` ganha:
```rust
state_map: Arc<DashMap<SessionId, AgentState>>,
state_tx:  broadcast::Sender<(SessionId, AgentState)>,   // contrato pro Sub-projeto B
```
- `spawn` cria o detector; `kill` remove do `state_map` e marca `Dead`.
- API exposta (contrato pra B): `agent_state(&self, id) -> Option<AgentState>` e `subscribe_state(&self) -> broadcast::Receiver<(SessionId, AgentState)>`.

`PtySession` ganha: `root_pid: Option<u32>` (de `child.process_id()`) e acessor `process_group_leader() -> Option<i32>` delegando ao `master`.

Modificados: `pty/session.rs`, `pty/manager.rs`, `pty/mod.rs` (exports), `lib.rs` (somente se o detector precisar de `AppHandle` não já disponível — `session.rs` já recebe `AppHandle`, então o detector o reaproveita).

## 8. Mudanças no frontend

- `src/types/pty.ts` — `export type AgentState = "working" | "blocked" | "done" | "idle" | "dead";`
- `src/components/StatusDot.tsx` — 5 entradas (4 + dead), cores do §4, títulos PT.
- `src/store/canvas-store.ts` — alargar o union de `terminalStatuses` e `setTerminalStatus` de `"idle"|"busy"|"dead"` → `AgentState`.
- `src/hooks/useTerminalSession.ts` — **remover** `busyTimerRef` e o `setTimeout` de 2s; assinar `agent://status` e chamar `setTerminalStatus`. `dead` continua vindo de `pty://exit`.
- `src/lib/pty-client.ts` — `listenAgentStatus(sessionId, cb: (s: AgentState, msg?: string) => void)`.
- `src/components/nodes/TerminalNode.tsx` — já usa `StatusDot`; opcionalmente emite foco → backend pra transição `done→idle` (opcional v1).

## 9. Testes

- `pty/detector.rs` `#[cfg(test)]` — classificador é **função pura** `(bottom: &str, fg: FgClass, prev: AgentState, quiescent: bool) -> AgentState`. Tabela de casos:
  - stream do Claude trabalhando (não-quiescente) → `Working`;
  - quiescente + buffer com `Do you want to proceed?` → `Blocked`;
  - quiescente + buffer com input box pronto, prev=Working → `Done`;
  - quiescente + prompt de shell, perfil shell → `Idle`;
  - prev=Done + sem mudança → `Done`.
- Fixtures: capturas reais de output (Claude trabalhando / blocked / ready / shell) em `src-tauri/tests/fixtures/` ou inline como byte-strings.
- `profile.rs` — testes de seleção de perfil por comando e de match dos regex.

## 10. Fora de escopo (YAGNI para A)

- Manifests em TOML (v1 é Rust built-in).
- Notificações / rate-limiting / "foreground only" do herdr.
- Injeção de estado via socket (`report_agent`) — é do Sub-projeto B.
- Rastrear `done→idle` por "inspeção" além do evento de foco simples.
- macOS/Windows: `process_group_leader` é Unix; em outras plataformas o detector cai pro sinal de atividade/padrão apenas (degradação graciosa, sem `/proc`).

## 11. Contrato exposto ao Sub-projeto B

```rust
impl PtyManager {
    pub fn agent_state(&self, id: &str) -> Option<AgentState>;
    pub fn subscribe_state(&self) -> broadcast::Receiver<(SessionId, AgentState)>;
}
```
`wait agent-status` (B) = assinar `subscribe_state` e bloquear até `(id, alvo)`. `events.subscribe` (B) = repassar o stream. Sem isso, A está incompleto.

## 12. Arquivos afetados (resumo)

**Criar:** `pty/detector.rs`, `pty/profile.rs`, `pty/text.rs`, `tests/fixtures/*`.
**Modificar:** `pty/session.rs`, `pty/manager.rs`, `pty/mod.rs`, `lib.rs` (talvez), `types/pty.ts`, `components/StatusDot.tsx`, `store/canvas-store.ts`, `hooks/useTerminalSession.ts`, `lib/pty-client.ts`, `components/nodes/TerminalNode.tsx`.
**Melhoria alvo (recomendada):** dedup de strip-ANSI em `mcp/server.rs` e `manager.rs` via `pty/text.rs`.
