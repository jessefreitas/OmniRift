# Design — Compressores de Token Plugáveis (camada `Compressor`)

> Data: 2026-06-17 · Status: **spec aprovada (seções 1–2), 3–4 inline** · Codename: OmniRift (ex-Maestri)
> Spec irmã do design da Fase 8 (`2026-06-15-maestri-brain-interface-design.md`) — mesmo DNA de provider plugável.

## 1. Objetivo

Permitir que o usuário **ligue e escolha compressores de token pelo canvas, para todos os CLIs existentes** (Claude Code, Codex, Antigravity, Shell e os que vierem). Dois mecanismos no v1:

- **RTK** (*Rust Token Killer*, `rtk-ai/rtk`) — binário Rust único, zero-dep, comprime **saída de comandos shell** (60–90%). Opera *abaixo* do agente, no nível do PTY.
- **Headroom** (`chopratejas/headroom`, fork `jessefreitas/headroom`) — comprime a **chamada ao LLM** (prompt + histórico + tools + RAG) via proxy local (60–95%). Python 3.10+.

São **camadas diferentes e complementares** — dá pra rodar os dois juntos. A arquitetura é uma camada plugável `Compressor`, espelhando o `MemoryProvider` da Fase 8 (43/43 testes, zero regressão).

### Decisões de escopo (fixadas no brainstorming)

| Eixo | Decisão |
|------|---------|
| Resultado | Feature de produto, controlável pelo canvas, universal a todos os CLIs |
| Granularidade | **Default global + override por node** |
| Provisionamento | **Bring-your-own**: nada embutido; detecta no PATH; mostra como instalar se faltar |
| Visibilidade | **Badge por node** (% / tokens economizados) + **total agregado** na Área de Conexões |
| Abordagem | **A** — trait `Compressor` que decora o spawn do agente (só `env`) |

### Não-objetivos (YAGNI v1)

- Embutir binários (RTK/Headroom) ou runtime Python no bundle.
- Adotar a **memória cross-agent / `headroom learn`** do Headroom — sobrepõe a Fase 8 (interface do cérebro). Usamos o Headroom **só como compressor**.
- Keychain pros segredos do compressor (segue a ofuscação v1 da Fase 8; keychain é o item de Fase 2 já mapeado).
- Compressão de imagem do Headroom, AST `--code-graph`, CCR retrieval avançado — backlog.

## 2. Invariante de arquitetura (o que torna a Abordagem A segura)

O orquestrador detecta o estado de cada agente (`blocked`/`ready`/`done`) por `profile_for(command)`, que casa pelo **basename do comando** (`pty/profile.rs:84`). Logo:

> **A decoração NUNCA pode alterar `command`/`args` — só `env` (incluindo `PATH`).**

Se reescrevêssemos `claude` → `headroom wrap claude`, o basename viraria `headroom` → cairia no perfil `shell` → quebraria a detecção do orquestrador. Por isso **os dois providers se prendem apenas por env**:

- **RTK** → prepende um dir de *shim* no `PATH` (wrappers que roteiam `git`/`grep`/`ls`/… por `rtk`).
- **Headroom** → sobe um **proxy local** e seta `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` (por família de CLI) + `HEADROOM_SESSION_ID=<node_id>`. **Modo proxy, não `wrap`.**

`command`/`args` intactos ⇒ `profile_for` e todo o detector/orquestrador seguem funcionando sem saber que existe compressão ⇒ **zero regressão**.

## 3. Módulo & trait (Seção 1)

Novo módulo `apps/desktop/src-tauri/src/compress/`, espelhando `memory/`:

```
compress/
  mod.rs        // re-exports + CompressorRegistry
  provider.rs   // trait Compressor
  registry.rs   // CompressorRegistry (default global + override por node)
  rtk.rs        // RtkProvider     (PATH shim)
  headroom.rs   // HeadroomProvider (proxy + BASE_URL + MCP)
  types.rs      // SpawnDecoration, DetectStatus, SavingsReport, CompressorKind, CliFamily
```

```rust
pub enum CompressorKind { None, Rtk, Headroom }
pub enum CliFamily { Claude, Codex, Antigravity, Shell } // de profile_for(&cfg.command)

pub trait Compressor: Send + Sync {
    fn kind(&self) -> CompressorKind;
    fn detect(&self) -> DetectStatus;                 // BYO: which/probe + install_hint
    /// SÓ muta env (+ PATH). NUNCA command/args. Fail-open.
    fn decorate(&self, cli: CliFamily, spec: &mut SpawnDecoration);
    /// MCP servers pra merge no agent_mcp_config (Headroom usa; RTK = vazio).
    fn agent_wiring(&self) -> AgentWiring { AgentWiring::none() }
    /// Economia atribuída a um node (best-effort, lida da fonte do compressor).
    fn metrics(&self, node_id: &str) -> SavingsReport;
}

pub struct SpawnDecoration { pub env: Vec<(String, String)> } // só env é mutável

pub struct DetectStatus {
    pub installed: bool,
    pub version: Option<String>,
    pub install_hint: String,   // RTK: cargo install --git ...; Headroom: pip install "headroom-ai[all]"
}

pub struct SavingsReport {
    pub tokens_before: u64,
    pub tokens_after: u64,
    pub pct: f32,
    pub estimated: bool,        // Headroom output-savings é counterfactual → honesto
}
```

`CompressorRegistry` (igual `MemoryRegistry`): mantém o **default global** + mapa de **overrides por node**, ambos no SQLite. `effective_for(node_id) -> Arc<dyn Compressor>` resolve **override → global → None**. Fallback seguro pra `None` se o kind não estiver detectado (nunca deixa o agente sem spawnar).

## 4. Pontos de enxerto (Seção 2 — fluxo de dados)

Dois enxertos, **ambos em pontos já existentes**:

1. **No spawn** — em `commands/pty.rs`, antes de `manager.spawn`, pega `CompressorRegistry` como `State` (idêntico a `agent_mcp_config` pegando `memory_registry`), resolve `effective_for(node_id)`, deriva `CliFamily` de `profile_for(&cfg.command)`, e chama `decorate(cli, &mut deco)` → faz merge de `deco.env` em `cfg.env`.

   > **Origem do `node_id`**: o `pty_spawn` já recebe o `SessionId` do front. O front passa o **id do node do canvas** (chave de override + atribuição de métrica) — ou via campo novo `node_id` no payload do comando, ou reusando o `SessionId` quando há 1:1 node↔sessão. A chave NÃO entra no `PtySpawnConfig` (que é só o contrato de processo); fica no comando `pty_spawn`, que tem acesso à `State` e ao id.

   Concreto:
   - **RtkProvider**: cria (idempotente) `~/.local/share/OmniRift/rtk-shim/` com wrappers fail-open (`exec rtk "$0" "$@" || exec "$REAL"`); prepende ao `PATH`; seta `RTK_STATS_DIR=<app_data>/rtk-stats/<node_id>`.
   - **HeadroomProvider**: garante o proxy de pé (porta configurável, default 8787); seta `ANTHROPIC_BASE_URL`/`OPENAI_BASE_URL` por `CliFamily`; seta `HEADROOM_SESSION_ID=<node_id>`; opcional `HEADROOM_OUTPUT_SHAPER=1`.
2. **No MCP** — em `commands/mcp.rs:161`, mais um merge: `compressor_registry.effective_global().agent_wiring()` adiciona os `headroom_*` tools quando Headroom é o ativo global (RTK/None não mexem no mapa → preserva o teste de zero-regressão existente).

## 5. Modelo de dados, detecção BYO, comandos & UI (Seção 3)

### 5.1 SQLite (via `db.rs`, no padrão `conn_*` da Fase 8)

```sql
-- default global (linha única)
CREATE TABLE IF NOT EXISTS compressor_active (
  id   INTEGER PRIMARY KEY CHECK (id = 1),
  kind TEXT NOT NULL DEFAULT 'none'
);
-- override por node
CREATE TABLE IF NOT EXISTS compressor_override (
  node_id TEXT PRIMARY KEY,
  kind    TEXT NOT NULL
);
-- config por compressor (ex.: porta do proxy Headroom, output_shaper)
CREATE TABLE IF NOT EXISTS compressor_config (
  kind TEXT PRIMARY KEY,
  json TEXT NOT NULL DEFAULT '{}'
);
```

RTK não exige config. Headroom: `{ "port": 8787, "output_shaper": false }`.

### 5.2 Detecção BYO

`detect()` roda `which rtk` / `which headroom` + probe de versão (`rtk --version`, `headroom --version`), cacheado no startup e re-probável por comando. **Nunca auto-instala.** `install_hint`:
- RTK: `cargo install --git https://github.com/rtk-ai/rtk`
- Headroom: `pip install "headroom-ai[all]"`

### 5.3 Comandos Tauri (espelham a superfície `memory_*`)

| Comando | Faz |
|---------|-----|
| `compressor_list()` | kinds + `DetectStatus` + qual é o global ativo |
| `compressor_set_global(kind)` | define o default global (valida instalado) |
| `compressor_set_node(node_id, kind?)` | define/limpa override do node (`kind=null` limpa) |
| `compressor_effective(node_id)` | kind resolvido pro node (estado do badge) |
| `compressor_detect()` | re-probe BYO |
| `compressor_config_set(kind, json)` | porta/flags do Headroom |
| `compressor_metrics(node_id?)` | `SavingsReport` do node + total agregado |

### 5.4 UI (React)

- **Área de Conexões** (painel da Fase 8): seção **“Compressão de Tokens”** — seletor do default global (None / RTK / Headroom), cada linha com status de detecção (✓ instalado v.X / ✗ não encontrado + botão **“Como instalar”** com o hint), config do Headroom (porta), e o **total agregado** da sessão (“tokens economizados: N — X%”).
- **Node de agente** (canvas): **badge** com o compressor efetivo + % (ex.: `RTK · −82%`). Clique → popover de override (trocar / desligar). Reusa o chrome de node existente (padrão `CanvasNodePatch` / `useNodeMaximize`).

## 6. Métrica, fallback & testes (Seção 4)

### 6.1 Captura de métrica (parte mais “solta” — alvo de spike na implementação)

- **RTK**: shim aponta `RTK_STATS_DIR=<...>/<node_id>`; o backend lê/agrega os stats por node. Se o formato do RTK não expuser isso de imediato, v1 mostra on/off e preenche o número quando disponível.
- **Headroom**: proxy atribui por `HEADROOM_SESSION_ID`; consulta `headroom output-savings` / endpoint de stats do proxy filtrado por sessão. `estimated=true` quando counterfactual (honestidade do número).
- Um poller leve (ou comando sob demanda) emite evento Tauri `compress://savings` por node → atualiza o badge.

### 6.2 Error handling (regra cardinal: **NUNCA quebrar o agente**)

Toda a decoração é **aditiva em env e fail-open**. Degrada pra “sem compressão”, jamais pra “sem agente”:

- Compressor não detectado no spawn → fallback silencioso pra `None`, log de warning, UI marca “indisponível”. Agente spawna normal (espelha o fallback seguro do `MemoryRegistry` pro Local).
- Proxy Headroom não sobe → não seta `BASE_URL` → agente fala direto com o provedor. Sem hang.
- Criação do dir de shim falha → pula a injeção de `PATH`.
- RTK/Headroom caem no meio da sessão → wrappers de shim são **fail-open** (`rtk … || comando real`); LLM volta a falar direto se o proxy morrer.

### 6.3 Testes (espelham 43/43, zero regressão)

- **Unit `decorate()`**: RTK injeta shim no PATH e **preserva command/args**; Headroom seta `BASE_URL` correto por `CliFamily` + `HEADROOM_SESSION_ID`; `None` deixa o spec **intacto** (assert de zero-regressão).
- **Preservação de perfil**: após `decorate`, `profile_for(cfg.command)` ainda devolve `claude`/`codex` (guarda a regressão do orquestrador).
- **Registry**: resolução override → global → None; limpar override cai no global; kind não detectado → fallback None.
- **`agent_wiring()` merge**: Headroom adiciona `headroom_*`; RTK/None deixam o mapa do `agent_mcp_config` inalterado (reusa o teste de zero-regressão existente).
- **Detect**: `which` mockado → installed/not + hint.
- **Fail-open**: decoração com compressor ausente → spec intacto.

## 7. Sequenciamento de entrega

1. **Spike de validação** (1 terminal, fora do app): `rtk git diff` e `headroom proxy` num workload real; medir economia/latência/qualidade. Confirma os números antes de instrumentar a métrica.
2. **Backend `compress/`** + trait + `RtkProvider` + registry + decoração no spawn + tabelas + comandos + testes (RTK primeiro, zero-dep).
3. **HeadroomProvider** (proxy + BASE_URL + MCP merge) + config.
4. **UI**: seção na Área de Conexões + badge no node + evento de métrica.
5. **Verificação**: `npm run typecheck` + `cargo test` (todos os testes, regression guard) + smoke de GUI (spawn de agente com cada compressor; confirmar detector intacto).

## 8. Riscos & mitigação

| Risco | Mitigação |
|-------|-----------|
| `headroom wrap` quebraria o detector | **Resolvido por design**: modo proxy + env, `command` intacto |
| Formato de stats do RTK por-node incerto | Spike no passo 1; v1 degrada pra on/off se não der atribuição |
| Headroom (Python) ausente na máquina | BYO + detecção + hint; fallback None nunca bloqueia |
| Shim de PATH conflitar com aliases do usuário | Dir próprio, só prepend; wrappers fail-open; cobre só comandos suportados pelo RTK |
| Proxy local como porta fixa colidir | Porta configurável + checagem de porta livre antes de subir |
```