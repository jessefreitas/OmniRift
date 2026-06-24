# Desmonte do ref → aprendizados pro OmniRift

**Data:** 2026-06-24
**Objeto:** `stablyai/ref` @ v1.4.96-rc.0 (MIT, Electron) — "The AI Orchestrator for 100x builders"
**Por quê:** O ref é o concorrente mais próximo do OmniRift (orquestrador multi-agente: roda Codex/Claude Code/OpenCode/Pi lado a lado, cada um no seu worktree git). É bem mais maduro (~5.700 arquivos TS/TSX, ~2.000 arquivos de teste colocados, faz release diário). Isto aqui é a lista de peças do que copiar, mapeada pras fases do OmniRift.

---

## 0. Enquadramento estratégico (leia isto primeiro)

- **Stack:** ref = Electron 42 + `node-pty` + terminal WebGL próprio + mobile Expo/React-Native + 1 store Zustand (~50 slices). OmniRift = Tauri 2 (Rust) + `portable-pty` + `@xterm/xterm` + canvas React Flow/Pixi.
- **O canvas é o moat, não um problema.** O ref — mais bem financiado e mais maduro — *escolheu de propósito* o workspace estilo VS Code (abas + painéis divididos). O canvas infinito espacial do OmniRift é o diferenciador de verdade. **Não** reconstrua a UX de abas/painéis do ref. Minere o ref por *profundidade de subsistema* (terminal, status de agente, fan-out de worktree, mobile, CLI) e mantenha o canvas.
- **Maior lição isolada:** o ref empurra o estado pesado e "fonte da verdade" pro backend (main process / daemon). O renderer é uma *view descartável*. O OmniRift guarda mais verdade no frontend; essa é a primeira lacuna a fechar.

---

## 1. A lista do que copiar (priorizada)

### P0 — faça; corrigem lacunas reais de arquitetura

| # | Padrão | Mapeia pra | Esforço |
|---|--------|------------|---------|
| 1 | **Status de agente via push (hooks)** (listener HTTP loopback + scripts de hook por agente; o agente faz POST `{state,...}`) | Orquestrador de agentes (`src-tauri/src/agents/`) | M |
| 2 | **Terminal headless dono no backend + scrollback limitado** (Rust mantém o emulador autoritativo; xterm do renderer é view com teto) | Terminal (`src-tauri/src/pty/`, `terminal-node`) | G |
| 3 | **Snapshots com guarda de sequência** (seq monotônico por chunk; ao revelar a aba, replay do snapshot e depois só `seq > snapshot.seq`) | Terminal | P–M |
| 4 | **Scheduler de output com orçamentos** (foreground 128 KB/150 ms; background 16 KB/16 ms; teto de descarte 2 MB → marca "stale") | Terminal | M |

### P1 — features de alto valor que cabem no roadmap

| # | Padrão | Mapeia pra | Esforço |
|---|--------|------------|---------|
| 5 | **Abstração `executionHostId`** (`local | ssh:<id> | runtime:<id>` em cada worktree → um campo, não dois caminhos de código) | Floors / Fase 6 | P (refactor) |
| 6 | **Fan-out por grupo de orquestração** (decompõe→despacha→monitora→portão-de-merge→pronto; endereçamento `@all/@idle/@worktree:id/@agente`) | Fase 6 Routines / Fase 8 | G |
| 7 | **Companion mobile = servidor WebSocket LAN no backend Rust** (pareamento QR + E2EE NaCl + token por dispositivo + allowlist de RPC) | Novo (sem fase ainda) | G (~3 sem MVP) |
| 8 | **CLI: trilogia specs → handlers → runtime-client** (specs declarativos, handlers puros, ponte RPC pro app rodando) | Novo (OmniRift não tem CLI) | M |
| 9 | **Payload de grab do Design Mode** (overlay→hover→captura-clique→payload do elemento com orçamento+redação→prompt do agente) — *portável pro WebKitGTK* | Portais / Fase 5 | M |

### P2 — disciplina e polimento (barato, juros compostos)

| # | Padrão | Mapeia pra | Esforço |
|---|--------|------------|---------|
| 10 | **Lint `max-lines`, nunca desabilitado** (300/.ts, 400/.tsx; quebra o arquivo) | Repo todo | P |
| 11 | **Design-doc-por-feature, com gate** (`Problema→Causa Raiz→Não-objetivos→Design→Fluxo de Dados→Casos de Borda→Plano de Teste`; PR linka) | `docs/superpowers/specs` | P |
| 12 | **E2E afirma no DOM, nunca no store** | testes | P |
| 13 | **`.ts` e não `.d.ts` pra tipos próprios** (CI reprova `.d.ts` do projeto; `skipLibCheck` os alarga pra `any`) | Repo todo | P |
| 14 | **Redator de segredos com fingerprints de provedor** (`sk-ant-…`, `ghp_…`, PEM, KV, linhas de env) antes de qualquer coisa cair em log/OmniMemory | Observability / Fase 8 | P–M |
| 15 | **Precedência de consentimento de telemetria** (`DO_NOT_TRACK` → `OMNIRIFT_TELEMETRY_DISABLED` → CI → setting do usuário; union discriminada com motivo) | Observability | P |
| 16 | **Release-cut só via CI** ("recusa se a versão não for estritamente maior que a última") | CI (Forgejo Actions) | P |

---

## 2. Detalhe P0 — as correções de arquitetura

### 2.1 Status de agente via push (a joia da coroa)

O ref **não** lê o output do terminal pra saber se o agente está trabalhando/pronto — isso é frágil por shell e por TUI. Em vez disso:

1. O ref roda um **listener HTTP loopback** em `http://127.0.0.1:${ORCA_AGENT_HOOK_PORT}`.
2. Ele instala **scripts de hook gerenciados** dentro da config do próprio agente (hooks do Claude Code, hooks do Codex, Gemini `--listen`, etc.). A cada evento de ciclo de vida (UserPromptSubmit, PreToolUse, Stop…) o script faz POST de JSON pra `/hook/{agente}`.
3. Todo agente normaliza pra **uma máquina de 4 estados**: `working | blocked | waiting | done`, com payload `{ state, prompt, toolName, toolInput, lastAssistantMessage, interrupted }`.
4. Estado persistido em `last-status.json` pra recuperação de crash; **>30 min de silêncio ⇒ sintetiza `done`** (fallback degradado).
5. **Sem interface genérica de agente.** Serviços de hook explícitos por agente (`ClaudeHookService`, `CodexHookService`…). Adicionar um agente ≈ 400–500 LOC: registra → implementa install/remove/getStatus → define eventos → emite o script gerenciado → (opcional) extração de retomada de sessão.

**Arquivos-chave:** `src/main/agent-hooks/server.ts`, `src/shared/agent-status-types.ts:10-37`, `src/main/agent-hooks/managed-agent-hook-controls.ts:23-38`.

**Ação OmniRift:** troque qualquer lógica de "adivinhar pelo stream do PTY" por um listener HTTP em Rust + um instalador de hooks gerenciados. Como o OmniRift é Claude-Code-first e já injeta config MCP por agente (`agent_mcp_config`), dá pra entregar o hook do Claude primeiro e o Codex depois. Retomada de sessão é por agente e opcional — não force a abstração.

**Pular:** instalação de hook via SSH, chaves HMAC de trust do Codex, marcadores OSC-777 de shell-ready, migração de pane-key legada.

### 2.2 Terminal headless dono no backend + scrollback limitado

Problema que o ref resolve: o Chromium estrangula os timers de abas escondidas enquanto os PTYs continuam escrevendo → um buffer só no renderer cresce sem limite e dá OOM. (Mesmo risco no OmniRift: um nó-terminal escondido no canvas ainda recebe bytes do PTY.)

- Os bytes do PTY batem **primeiro num emulador headless no backend** (chaveado por pty id), *e só então* fazem fan-out pro xterm do renderer em paralelo (sem latência extra pro painel visível).
- O xterm do renderer é uma **view descartável com teto rígido de ~2 MB**; em overflow ele **descarta bytes + imprime aviso + marca o painel como stale**, nunca retém.
- Uma **cadeia de escrita assíncrona serializada** (`writeChain = writeChain.then(write).catch(noop)`) preserva a ordem do parser ANSI sob escritas/encerramento concorrentes.

**Arquivos-chave:** `src/main/runtime/ref-runtime.ts:969-975` e `:5338-5349`, `src/main/runtime/scrollback-limits.ts`, `src/renderer/.../pane-terminal-output-scheduler.ts:61-84`.

**Ação OmniRift (Rust):**
```
src-tauri/src/pty/
  headless.rs   # HeadlessTerminal { ring buffer, cadeia de escrita async, output_sequence }
  snapshot.rs   # serializa estado limitado; replay com guarda de seq
  recovery.rs   # recuperação de nó escondido, marcação de stale
```
Use um crate de parser VT (ex.: `vte`/`alacritty_terminal`) pro emulador headless, ring limitado a ~50k linhas por terminal. O renderer pede um snapshot ao revelar o nó.

**Pular por enquanto:** checkpoint de PTY em disco no nível de daemon entre reinícios completos do app (o ref precisa disso pra sessões de vários dias com milhares de painéis; o OmniRift pode persistir um snapshot limitado em SQLite/IndexedDB).

### 2.3 Snapshots com guarda de sequência

O bug clássico "o scrollback dobra quando clico de volta na aba". Todo chunk carrega um `outputSequence` monotônico. Ao revelar: `xterm.clear(); xterm.write(snapshot.buffer)`, e depois aplica só os chunks vivos com `seq > snapshot.outputSequence`. Barato, elimina uma classe inteira de bug.

### 2.4 Scheduler de output

Três caminhos: **foreground** (imediato pra <2 KB; coalesce se >128 KB numa janela de 150 ms — mata o jank de redraw 60fps do vim/tmux), **background** (flush 50 ms, 16 KB/tick, teto de descarte 2 MB), **recuperação** (uma restauração inativa por frame ~16 ms pro painel ativo seguir suave). Envolva os nós xterm do OmniRift num scheduler equivalente.

---

## 3. Detalhe P1 — as features

### 3.1 `executionHostId` — junta local/remoto num campo só
O `Worktree` do ref carrega `hostId: 'local' | 'ssh:${id}' | 'runtime:${id}'`, e um `ProjectHostSetup` guarda o path remoto + id da conexão. `id` do worktree = `${repoId}::${path}` (estável, não UUID). Os fatos de git (`GitWorktreeInfo`) ficam separados do enriquecimento de app (`Worktree`). **Adote o campo já, antes mesmo do SSH** — blinda os Floors pro futuro e evita um fork em todo caminho de código depois. (`src/shared/types.ts:434-499`, `src/main/git/worktree.ts`.)

### 3.2 Fan-out por grupo de orquestração (a feature "espalha um prompt por N agentes")
Um coordenador de polling em 5 fases respaldado por tabelas SQLite (`messages`, `tasks`, `dispatch_context`): **decompõe** spec → tasks → **despacha** pros destinatários resolvidos com um preâmbulo injetado (spec da task + drift check + cadência de heartbeat) → **monitora** (timeout de heartbeat ~10 min) → **portão-de-merge** → **pronto**. Endereçamento de grupo resolve por **regex de fronteira de palavra no título do terminal**: `@all`, `@idle`, `@worktree:<id>`, `@claude`. (`src/main/runtime/orchestration/coordinator.ts:91-200`, `groups.ts:36-87`.) É o blueprint pras Routines da Fase 6 do OmniRift e casa naturalmente com o canvas (cada nó-worktree = um destinatário). O merge é manual no ref v1 — não exagere no auto-merge.

### 3.3 Companion mobile (uma feature *nova* crível pro OmniRift)
O "relay" **não é infra de nuvem** — é um servidor WebSocket LAN (porta 6768) **embutido no app desktop**. Fluxo:
- **Parear:** desktop mostra deep-link QR `omnirift://pair?code=<base64url>` codificando `{ v, endpoint, deviceToken(24B hex), publicKeyB64(Curve25519) }`.
- **Cifrar:** NaCl box (X25519 ECDH + XSalsa20-Poly1305); chave estática do desktop em disco, chave efêmera do celular por conexão (forward secrecy); frames = `base64([nonce 24B][ciphertext])`.
- **Autorizar:** registro de token por dispositivo (em arquivo: `{deviceId,name,token,scope,pairedAt,lastSeenAt}`); revogar = "Esquecer dispositivo".
- **Limitar:** o mobile só pode chamar uma **allowlist de métodos RPC** (~120 no ref; ~40 pra um MVP: `terminal.subscribe/send`, `worktree.*`, `notifications.subscribe`). Sem escrita de arquivo / spawn de processo.
- **Sobreviver à rede do celular:** servidor faz ping a cada 15 s (mata sockets meio-abertos); cliente com backoff exponencial 500 ms→60 s, desiste ~12 tentativas; probe de atividade de 20 s; teto de frame de 1 MiB → upload de imagem em chunks.
- **Framework:** Expo + React Native; terminal renderizado via `react-native-webview` + xterm; lógica de pareamento espelhada (o Metro não importa de fora de `mobile/`).

**Veredito:** vale construir. Porta limpo pra Tauri/Rust (`tokio-tungstenite` + `libsodium`/`crypto_box`). MVP = monitorar + push "agente terminou" em ~3 semanas; pilotar (mandar input) é Fase 2. **Copiar inteiro:** o loop de reconexão, o schema de pareamento, o registro de dispositivos, a allowlist, o upload em chunks.

### 3.4 CLI: specs → handlers → runtime-client
- **Specs** (`src/cli/specs/*.ts`): `{path, summary, usage, allowedFlags, examples}` declarativo — uma fonte DRY pra help + validação de flags.
- **Handlers** (`src/cli/handlers/*.ts`): funções puras recebendo um `HandlerContext {flags, client, cwd, json}` tipado — testáveis à toa.
- **Runtime client**: descobre/sobe o app rodando, então `client.call(method, params)` por Electron-IPC (local) ou WebSocket (pareado/remoto), com negociação de versão de protocolo + grace de timeout pra long-poll.

O OmniRift não tem CLI. É o padrão mais limpo pra copiar quando você adicionar `omnirift worktree create / snapshot / send`. O mesmo registro de métodos RPC serve de transporte mobile e de superfície "agentes pilotam o OmniRift". Handlers usam **params validados por Zod + injeção de contexto** (sem globals) — adote os dois.

### 3.5 Design Mode — *e o veredito honesto sobre Portais/Fase 5*
- **O grab é JavaScript puro** → portável pro WebKitGTK via `evaluate_script()` do Tauri: injeta um overlay shadow-root cobrindo a viewport → rastreador de hover → captor de clique no guest → extrai um **payload com orçamento e segredos redatados** (seletor, 15 estilos computados, ARIA, texto vizinho, nomes de fiber React, screenshot recortado) → formata como markdown no prompt do agente. O tipo `BrowserGrabPayload` + `GRAB_BUDGET` (`textSnippet 200`, `htmlSnippet 4 KB`, `screenshot ≤2 MB`) é basicamente uma spec pronta. (`src/main/browser/grab-guest-script.ts`, `browser-grab-types.ts`, `useGrabMode.ts`.)
- **Sua limitação iframe-localhost é FUNDAMENTAL, não um bug a corrigir.** O ref embute *abas cross-origin reais* só porque o Electron entrega Chromium + sandbox. O WebKitGTK genuinamente não consegue. **Aceite o escopo iframe-localhost** pro portal de browser e invista o esforço no *payload de grab* (a metade realmente valiosa, voltada pro agente).
- **Computer Use** = um **processo sidecar** (`fork()` → JSON-RPC → helper nativo Swift/Linux/Windows), isolado por plataforma + resiliente a crash. Porta limpo pra um sidecar Rust no Tauri se um dia quiser (Fase 7+). Recorte de screenshot no WebKit precisa de cálculo manual de retângulo (overlay + foto da viewport + crop em JS).

---

## 4. Detalhe P2 — disciplina que vale importar (barato, amigável pra time solo)

- **`max-lines` com gate, nunca desabilitado** (`.oxlintrc.json`: 300/.ts, 400/.tsx, 800/testes). O `AGENTS.md` proíbe o comentário de disable — "quebra o arquivo". Mais **switch-exhaustiveness** (`allowDefaultCaseForExhaustiveSwitch:false`) e uma regra de **nomes de arquivo não-vagos** (`utils/helpers/common/misc` banidos). O OmniRift usa Biome — adicione max-lines + um check de switch exaustivo.
- **Design-doc-por-feature, com gate.** 45 docs em `docs/`, template consistente, PRs têm que linkar. Você já tem `docs/superpowers/specs + plans` — a lição é o *template* + o *gate de enforcement*.
- **E2E afirma no DOM, não no store.** Bug real (#1186): um modal deletado ainda passava no round-trip do store mas não renderizava nada. Pros testes Tauri do OmniRift: afirme o que renderiza (`getByRole`, `toBeVisible`), teste unitário da lógica pura via slices do store.
- **`.ts` e não `.d.ts` pra tipos do projeto.** `skipLibCheck:true` alarga silenciosamente nomes `.d.ts` não resolvidos pra `any` (já enviou uma assinatura de IPC quebrada por isso). CI: `find src/preload src/shared -name '*.d.ts'` ⇒ reprova.
- **Redator de segredos**, 5 famílias de regra ordenadas incl. fingerprints de provedor (`sk-ant-…`, `ghp_…`, PEM), aplicado em 3 camadas. **Diretamente relevante** porque a OmniMemory ingere SQL/contexto de agente que pode conter segredos — redija antes de persistir. (`src/main/observability/redactor.ts`.)
- **Precedência de consentimento de telemetria**, union discriminada com um *motivo* (`do_not_track | ci | user_opt_out | pending_banner`), env ganha de setting. Avisa-uma-vez em `DO_NOT_TRACK` inválido.
- **Release só via CI** (`release-cut.yml`): recusa release estável cuja versão não seja estritamente maior que a última (protege o auto-update); cron de RC 2×/dia a partir da main; release fora da main só dá push de tag. Espelhe no Forgejo Actions; mate qualquer `npm release` local.
- **Dial do Vitest no Windows** (`maxWorkers:4` no win32) + timeouts de hook/teste generosos pra fixtures reais de git/http — você faz build Windows, então importe isso.

---

## 5. O que explicitamente *não* vale copiar na escala do OmniRift

- UX de abas/painéis divididos (o canvas é o diferenciador).
- Checkpoint de PTY no daemon entre reinícios completos (use um snapshot limitado em SQLite no lugar).
- Pseudo-localização + 5 fases de PR de localização + 5 idiomas (prematuro pra ferramenta dev; adote só o *padrão audit-allowlist* quando de fato localizar).
- Homebrew casks (Tauri entrega .deb/.AppImage/.msi/.dmg).
- Ring buffers de memória por PTY / atribuição de recursos via `app.getAppMetrics()` (o subsistema "memory" do ref é só métricas de dashboard — *não* é memória semântica; o MemoryProvider da Fase 8 do OmniRift é a coisa de verdade e não tem relação).
- Varredura de sessões do AI-vault (só se quiser atribuição cross-agente de uso/tokens).
- 30+ integrações de agente de cara — entregue Claude + Codex, adicione o resto sob demanda.

---

## 6. Sequência sugerida pro OmniRift

1. **Agora (P0):** hooks de status de agente via push (Claude primeiro) + terminal headless dono no backend com snapshots guardados por seq + scheduler de output. Corrigem lacunas de correção/perf que ficam mais caras de retrofit depois.
2. **Em seguida (P1, Fase 6):** adiciona o campo `executionHostId` → fan-out por grupo no canvas → depois execução remota SSH atrás do mesmo campo.
3. **Então:** a CLI `specs→handlers→runtime-client` + registro RPC (é o substrato compartilhado da CLI e do companion mobile).
4. **Aposta de feature:** MVP do companion mobile (WS LAN + QR/E2EE + monitorar + push) assim que o registro RPC existir.
5. **Contínuo (P2):** lint max-lines, E2E só-DOM, gate CI `.ts`-não-`.d.ts`, redator de segredos no caminho de ingest da OmniMemory, release-cut só-CI.

---

## Apêndice — mapa de fontes (caminhos do ref citados)

- Status de agente: `src/main/agent-hooks/`, `src/shared/agent-status-types.ts`
- Terminal: `src/main/runtime/ref-runtime.ts`, `scrollback-limits.ts`, `src/renderer/src/lib/pane-manager/pane-terminal-output-scheduler.ts`, `src/main/ghostty/mapper.ts` (mapeador de config, *não* um emulador)
- Worktrees/SSH/orquestração: `src/shared/types.ts:434`, `src/main/git/worktree.ts`, `src/main/ssh/`, `src/main/runtime/orchestration/`
- Browser/Design Mode/Computer Use: `src/main/browser/`, `src/main/computer/`, `native/computer-use-*`
- Mobile/relay: `src/relay/`, `src/main/runtime/runtime-rpc.ts`, `src/shared/pairing.ts`, `mobile/` (Expo/RN)
- Memory/skills/automations/CLI/vault: `src/main/memory/`, `src/main/skills/`, `src/main/automations/`, `src/cli/`, `src/main/ai-vault/`
- Práticas: `AGENTS.md`, `docs/STYLEGUIDE.md`, `.oxlintrc.json`, `.github/workflows/`, `docs/*.md` (design-doc-por-feature)
