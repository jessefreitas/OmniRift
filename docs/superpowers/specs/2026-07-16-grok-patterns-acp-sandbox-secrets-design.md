# Padrões do grok-build aplicados ao OmniRift — ACP, Sandbox, Redação de segredos

**Data:** 2026-07-16
**Status:** draft (análise + plano, sem código)
**Origem:** análise comparativa do `jessefreitas/grok-build` (fork verbatim do CLI `grok` da xAI, 2.7M LOC Rust) contra os módulos correspondentes do OmniRift.

> Regra de ouro desta spec: **roubar padrão/arquitetura, não código.** O grok é Apache-2.0, mas
> acoplado ao ecossistema xAI (async-openai/responses, mixpanel, proto interno) e ao crate ACP
> oficial. Portar peça é mais caro que reimplementar a ideia no nosso desenho. Referência, não fonte.

---

## Enquadramento (vale pras 3 áreas)

O grok é um **CLI que É o agente** — aplica tudo no próprio processo. O OmniRift é um **app Tauri host**
que spawna agentes **externos** (claude-agent-acp, codex, hermes) por dois caminhos:
- **PTY** — `pty/session.rs:174` (`spawn_command`), comando montado em `build_command` (`session.rs:428`).
- **ACP** — `acp/mod.rs:405-448` (`tokio::process::Command` → `npx ... adapter`).

Consequência que atravessa as 3 áreas: contenção/redação tem que agir **no filho spawnado ou na fronteira
de saída**, nunca no processo Tauri (mataria o WebKitGTK). E o `acp/mod.rs` roda **4 providers em produção**
com cabeçalho honesto de "spike descartável" — qualquer refactor do transporte exige teste antes.

---

## Área 1 — ACP (protocolo)

### Estado atual (OmniRift)
Client ACP caseiro em JSON-RPC cru sobre stdio, arquivo único `acp/mod.rs` (~1143 linhas). Só o papel de
Client; fala com adapters de terceiros. Partes BOAS e próprias (manter): `EventLog` com caps duplos
(500 ev / 2 MiB) + coalescência de `agent_message_chunk` + `seq` pra dedup no reattach (`mod.rs:154-257`),
`AttachSnapshot` re-hidratável (backend-owned sessions), `gc` de órfãs (`mod.rs:810`), flag `killed` contra
stale-exit race (`mod.rs:366-369`).

### Defeitos confirmados
1. **IDs JSON-RPC fixos hardcoded** (init=1, session/new=2, prompt=3, auth=4, load=5, set_model=6,
   set_config=7). Read-loop faz `match id_num`. → **1 request in-flight por tipo**; dois prompts
   concorrentes colidem. O próprio comentário admite "produção usa contador + promptQueueing" (`mod.rs:713`).
2. **BUG LATENTE ATIVO** (confirma a memória antiga): as capabilities anunciam `fs.readTextFile/writeTextFile`
   e `terminal:true` (`mod.rs:518`), mas o read-loop só trata `session/request_permission` (`mod.rs:678`).
   Qualquer `fs/read_text_file`, `fs/write_text_file` ou `terminal/*` do adapter cai no fallback (`mod.rs:696`)
   que **só loga e nunca responde** → adapter **trava** naquele request.
3. Parsing frouxo (linha não-JSON = `continue` silencioso; campo ausente = `Null` propagado como evento).
4. Sem reconexão: EOF = `acp://exit` definitivo (`mod.rs:700-706`).
5. `write_line` serializa TUDO sob um `AsyncMutex` com `flush().await` (`mod.rs:873-880`) — adapter lento
   drenando stdin bloqueia prompt+cancel+permission-respond juntos.
6. **Zero teste do read-loop/handshake** (`mod.rs:912-1142` testam só estruturas puras).

### Alvo / o que o grok faz (crate oficial `agent-client-protocol` 0.10.4 + `xai-acp-lib`)
Tipos Rust por método, correlação req↔resp por `oneshot`, handler genérico que roteia TODOS os métodos
client-side pro `impl acp::Client`, `LineBufferedRead` (cap 64 MiB, cancel-safe), reconexão com backoff +
drop-stale de `session/load`, `session/set_mode`, notifs fire-and-forget.

### Plano (incremental — migração pro crate por ÚLTIMO)
| Passo | O que | Esforço | Risco |
|---|---|---|---|
| 1 | Contador de id + mapa `id→oneshot` (mata defeitos 1 e 2, destrava prompts concorrentes) | S–M | Médio (mexe no read-loop em prod) |
| 2 | Handler default p/ request desconhecido: **responder erro JSON-RPC** OU parar de anunciar `fs`/`terminal` em `mod.rs:518` (fecha o hang) | S | Baixo |
| 3 | Harness de teste com adapter FAKE (responde `initialize`) — pré-requisito de qualquer refactor | M | Baixo |
| 4 | Cap de linha 64 MiB + classificar não-JSON | S | Baixo |
| 5 | Reconexão + backoff + drop-stale de `session/load` | M–L | Médio |
| 6 | Migração completa pro crate 0.10.4 (some o `match id_num`; `impl acp::Client` emite eventos Tauri; `EventLog`/snapshot ficam por cima) | L | **Alto** — 4 providers em prod + conviver `LocalSet`(?Send)↔runtime multi-thread do Tauri (grok isola em thread dedicada c/ LocalSet própria) |

**Rota:** 1 → 2 → 3 → 4 → 5 → (6 só atrás dos testes do passo 3).

---

## Área 2 — Sandbox (contenção de execução)

### Estado atual (OmniRift): ZERO
Varredura de `landlock|seccomp|bwrap|unshare|nono|prctl|no_new_privs|cgroup` em `src-tauri/src` → só
falsos-positivos + um único `pre_exec` real (`compress/proxy.rs:138`, `PR_SET_PDEATHSIG` — não é segurança).
Agentes rodam com **permissões plenas do usuário** nos dois caminhos. Presets de role default usam
`claude --dangerously-skip-permissions` (auto-aprova tudo no CLI, sem rede de contenção embaixo).
A única "mitigação" é o `disallowedTools` (`AgentNode.tsx:888-891`) — mas é (1) só pro orquestrador
(workers nascem com todas as tools), (2) enforcement no CLI, trivialmente contornável, (3) não cobre PTY.
**Dá falsa sensação de segurança**: bloquear `Bash/Read/Edit` no CLI não impede syscalls — o processo
comprometido ainda lê `~/.ssh` e exfiltra.

### Alvo / o que o grok faz (Linux, crate `xai-grok-sandbox`)
3 camadas compostas, aplicadas 1x no startup: **Landlock** (via `nono`) pra FS in-process (fail-open nos
built-ins, irreversível); **bwrap** re-exec pra deny de path que Landlock não expressa (mount ns);
**seccomp-BPF** por filho pra bloquear rede (`connect/bind/sendto/...` → EPERM). 5 profiles
(`workspace` default / `devbox` / `read-only` / `strict` / `off`). macOS = Seatbelt (mesmo `nono`,
enforce glob em runtime). **Windows = nenhum sandbox** (no-op).

### Diferença de contexto crítica
Não aplicar Landlock no processo Tauri — aplicar **no filho spawnado**. Envelopar o comando, não o self.

### Plano
| Passo | O que | Esforço |
|---|---|---|
| 0 | Feature flag `sandbox_profile` (default `"off"` = paridade atual, zero regressão); nomes espelhando o grok | S |
| 1 | **Linux: envelope `bwrap` como programa** — prefixar cmd (PTY e ACP, é puro argv, sem `pre_exec`, sem crate): `--ro-bind / /`, `--bind <workspace>`, `--bind ~/.omnirift`, bind-over 000 em `~/.ssh`/`~/.aws`/`.env`, `--dev-bind /dev`, `--proc /proc` | M |
| 5 | **Inverter UX de aprovação** (insight do grok): `bypassPermissions` só quando sandbox ATIVO — menos prompts *ganhando* segurança | S |
| 3 | seccomp de rede por filho (portar `child_net.rs` ~100 linhas libc puro), profile "offline" opt-in por-repo | S/M |
| 2 | Fallback Landlock via `pre_exec` no ACP (`tokio Command` suporta) onde `bwrap` falta — crate `landlock` ou `birdcage` (abstrai Linux+mac) | M |
| 4 | Windows: documentar como não-sandboxed (igual grok) ou WSL2; nativo (AppContainer/Job Objects) é L | L |

**Ordem:** 0 → 1 → 5 → 3 → 2 → 4. **0+1+5 entregam ~80% do valor no Linux.**

### Trade-offs honestos (não ignorar)
- Agente de dev PRECISA editar o repo → default tipo `workspace` (workspace RW, `/` RO, `~/.omnirift/tools/bin` RW,
  `/tmp` RW). `strict` quebra git hooks globais, `~/.cache`, `~/.npm`, `~/.cargo`. Copiar o `essential_writable_paths`
  generoso do grok, não ser mais restritivo por default.
- `bwrap` não está em toda máquina (Flatpak/Snap, distros minimalistas). Decisão de produto: **fail-open + badge
  visível "sandbox inativo"** (honestidade) — fail-closed vira suporte; fail-open silencioso é segurança ilusória.
- Landlock exige kernel ≥5.13 (rede ≥6.7); degrada a no-op silencioso → precisa expor `is_active()` na UI.
- Deny de glob é best-effort no Linux (`.env` criado DEPOIS do launch não é coberto) → deny por diretório-pai
  (`~/.ssh` inteiro), não por glob de arquivo.
- Rede: bloquear só no FILHO do agente (o adapter/claude precisa da API); mesmo assim quebra `npm install`/`git fetch`
  → "offline" opt-in por-repo, nunca default.
- `portable-pty` não expõe `pre_exec` limpo → PTY provavelmente usa envelope bwrap enquanto ACP pode usar
  `pre_exec`. Padronizar tudo no bwrap no Linux evita dois mecanismos.

---

## Área 3 — Redação de segredos

### Estado atual (OmniRift)
`redactor.rs` (bom: rótulos por-provedor `[REDACTED:<tipo>]`, idempotência testada, cobre Anthropic+Cloudflare
que o grok não distingue). Fronteira documentada "redija só no ponto de saída de rede". **Problema: só 2 sinks
lógicos passam por ele** — bundle `/diag` (`diagnostics.rs:46`) e provider OmniMemory remoto (`omnimemory.rs:96,119`).

### Os buracos (o ponto central), por risco
1. **`omnirift.log` gravado CRU no disco** (`lib.rs:350-373`, fern sem scrub na escrita). A redação só acontece
   na LEITURA pro `/diag` → o arquivo local tem segredos em claro (e é lido por qualquer coisa com acesso ao FS).
2. **PTY espelhado pro mobile SEM redação** — `pty.snapshot` (`methods.rs:199-210`) trafega o VT cru pelo relay.
   `e2ee.rs` cifra (NaCl box), mas **cifrar ≠ redigir**: o device pareado decifra e vê o terminal inteiro,
   incluindo `sk-...` na tela.
3. Eventos ACP crus pro frontend (`mod.rs:10-12`) — risco menor (IPC local), mas herda o problema se espelhados.
- Por design (OK, manter): blackboard SQLite local e vault Obsidian ficam crus (`redactor.rs:22-27`).

### Padrões que faltam (grok cobre, OmniRift não): JWT nu, URLs (query/userinfo/fragment), Google `AIza`,
GitLab `glpat-`, GitHub fine-grained `github_pat_`, xAI `xai-`, path scrubbing (`$HOME`→`~`, username→`<user>`).

### Plano
| Passo | O que | Esforço |
|---|---|---|
| 1 | **Redação na ESCRITA do log** (não na leitura): wrapper de format do fern (`lib.rs:367`) chamando `redactor::redact` por linha → fecha buraco #1 de vez | M |
| 2 | Redigir `pty.snapshot` antes do relay (`methods.rs:208`), mantendo xterm local cru se for decisão consciente → fecha buraco #2 | M |
| 3 | Ampliar padrões: JWT nu, URL (query/userinfo/fragment, parse real), Google/GitLab/GH-fine-grained/xAI | S/M |
| 4 | Path scrubbing (`$HOME`→`~`, username) — útil pro log e `/diag` | S/M |
| 5 | **Canários de teste** sistemáticos (`sk-CANARY...`) + assert sobre o blob inteiro serializado | S |
| 6 | (L, futuro) Se estruturar telemetria/Insights: **default-deny por allowlist de chaves** (fail-closed) em vez de deny-list de valores | L |

**Manter o que já é melhor que o grok:** rótulos por-provedor + idempotência explícita + skip-de-já-redigido.

---

## Ordem sugerida entre as 3 áreas

Sequência por risco×valor (não bloqueiam entre si — podem virar 3 branches):
1. **Redação passos 1–2** (log na escrita + PTY→mobile) — menor risco, fecha vazamento real de segredo hoje.
2. **ACP passos 1–3** (contador de id + handler default + harness) — mata bug latente de hang + destrava concorrência.
3. **Sandbox passos 0+1+5** (flag + envelope bwrap + UX de aprovação) — maior valor de segurança no Linux.
4. Resto (ACP reconexão/migração, sandbox seccomp/landlock, redação padrões/canários) conforme prioridade.

Tudo atrás de feature flag (diretriz do projeto: nova feature toggleável entra no painel de flags).
