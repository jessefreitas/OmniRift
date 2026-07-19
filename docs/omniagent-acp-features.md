# OmniAgent & Camada ACP — Referência Completa de Funcionalidades

> Tudo que a camada de **agente estruturado (ACP)** trouxe pro OmniRift. Branch `feat/acp-spike`.
> Formato: **o que faz** + **como usar**. Atualizado 2026-07-19.

A aposta: deixar de tratar agente como **terminal cego** e passar a tratá-lo como **objeto
estruturado**. O app passa a *entender* o que o agente faz (tool-calls, diffs, custo, permissões) —
não só repassar bytes. Base: **ACP (Agent Client Protocol)** — JSON-RPC/stdio, padrão aberto do Zed.

---

## 1. OmniAgent — o agente estruturado

Um novo tipo de nó no canvas, **aditivo** (coexiste com os terminais PTY).

| Funcionalidade | O que faz | Como usar |
|---|---|---|
| **Sessão estruturada** | Roda Claude/Codex via adapter ACP; o app entende os eventos (não bytes) | Painel "Novo agente" → **OmniAgent** |
| **Tool-calls ao vivo** | Cada ação (ler · executar · editar) aparece como card com status | Automático durante o turno |
| **Badges reais** | Modelo, **contexto usado** (ex: 78k/1M) e **custo em USD** da sessão | Topo do card (do `usage_update`) |
| **Permissões inline** | O agente pede permissão pra uma ação → você aprova/nega no card | Aparece quando o agente pede |
| **Empty-state explicativo** | Explica o que é o OmniAgent e como operar | Card vazio |
| **Fullscreen (⤢)** | Abre a conversa em tela cheia (ESC fecha) | Botão no header |
| **Redimensionar** | Igual aos terminais (alça no hover/seleção) | Arrasta as bordas |
| **Scroll sem zoom** | Rolar dentro do card não dá zoom no canvas (`nowheel`) | Automático |

## 2. Providers & Autenticação

| Funcionalidade | O que faz | Como usar |
|---|---|---|
| **Claude** | OmniAgent via `@agentclientprotocol/claude-agent-acp` (herda `~/.claude`, zero setup) | Preset "OmniAgent" |
| **Codex** | OmniAgent via `@agentclientprotocol/codex-acp` (GPT-5) | Preset "OmniAgent · Codex" |
| **Hermes (BYOK)** | OmniAgent model-agnostic via `hermes-agent[acp]` (`uvx`) — **wizard** escolhe provider + modelo | Preset "OmniAgent · Hermes" |
| **Login (Entrar)** | Quando o provider exige (Codex): botão "Entrar com ChatGPT / API Key" | Card mostra sozinho |

### 2.1 Wizard do Hermes (provider → BYOK → modelo)

O Hermes é **model-agnostic**; o card abre um **wizard de 3 passos** em vez de um login travado:

1. **Provider** — Ollama Cloud (`ollama.com/v1`) · OpenRouter (aggregator, centenas de modelos) · Local (LM Studio/Ollama, sem key).
2. **Key (BYOK)** — cola a sua API key; fica no **keychain do SO** (`memory/secret_store.rs`), **host-gated** (o Hermes só manda `OLLAMA_API_KEY` p/ ollama.com, `OPENROUTER_API_KEY` p/ openrouter — não vaza entre endpoints). A key **não** é serializada no canvas; nos re-spawns o backend a resolve do keychain.
3. **Modelo** — lista **ao vivo** via `GET /v1/models` (backend Rust, `hermes_list_models`) com busca; fallback pra digitar o id à mão.

Ao concluir, o backend injeta `HERMES_INFERENCE_PROVIDER` + `HERMES_INFERENCE_MODEL` + `<PROV>_API_KEY` no spawn → o `initialize` volta **sem authMethods** (autenticado) → `session/new` direto, **sem o setup interativo de terminal** (que travava no ACP). O seletor de modelo do card (`session/set_model`) segue trocando modelo dentro da sessão.

## 3. Conexões & Linhas — o que cada linha faz

| Origem → Destino | O que a linha faz | Cor |
|---|---|---|
| **Terminal → Terminal** | **Pipe PTY** (stdout de A → stdin de B, tempo real) **+** entra no time MCP | cyan animada |
| **OmniAgent → Terminal** | **Time/comando**: marca no MCP; o OmniAgent comanda via `terminal_send_text` | roxa |
| **Agente → Agente** | **Cano de dados** (a saída de A vira input de B; encadeia) | branca |
| **Alça de baixo → vazio** | **Subagente** (`.claude/agents`) | âmbar |
| **→ ReviewNode** | **Gate**: segura o payload até aprovar (Fase 2) | amarela |
| **→ FilterNode** | **Roteamento por conteúdo**: só passa o que casa (Fase 2) | sky |
| **Soltar no vazio** | **Menu** de Agentes + Roles → cria o nó já conectado | — |

**Comportamentos gerais:** qualquer linha num terminal **marca ele no "MCP AGENTS"** (checkbox
reflete); **edges animadas por estado** (idle/sending/received/error/review) + cor por tipo;
remover a linha de pipe desfaz o pipe no backend.

## 4. Times & Orquestração

| Funcionalidade | O que faz | Como usar |
|---|---|---|
| **OmniAgent orquestrador** | Recebe o MCP do OmniRift → tools `terminal_*`, `memory_*`, `claim_*` | Automático (injetado no session/new) |
| **OmniAgent comandável** | Aparece no `terminal_list` → o Orquestrador-terminal delega pra ele | Automático quando ready |
| **Auto-conexão = time** | Puxar a linha num terminal já o adiciona ao time MCP | Ligar a linha |
| **Awareness (sempre)** | O orquestrador fica ciente da equipe de graça (roster no próximo prompt) | Automático |
| **Reação proativa (⚡reagir)** | Se ligado, o orquestrador dispara um turno ao mudar a equipe. **Default OFF** (não gasta token) | Toggle na seção MCP AGENTS |
| **Menu ao soltar linha** | Seletor de Agentes + Roles ao soltar a linha no vazio | Puxar linha → vazio |

## 5. Subagentes (`.claude/agents`)

Nó-filho **privado** de um agente Claude Code (OmniAgent ou terminal).

| Funcionalidade | O que faz | Como usar |
|---|---|---|
| **Plugar (2 formas)** | Cria o subagente-filho | Alça de baixo **ou** botão "+ subagente" |
| **Escreve o arquivo** | Materializa `.claude/agents/<role>.md` na pasta do pai | Automático ao plugar |
| **Escopo honesto** | Badge **GLOBAL · todos veem** vs **privado do projeto** | Visível no nó |
| **Awareness** | O agente sabe quais subagentes tem plugados (no próximo prompt) | Automático |
| **Recarregar (↻)** | Reinicia a sessão pra CARREGAR subagentes criados após o boot | Botão ↻ (agente e terminal) |
| **↻ mantém a conversa** | Terminal via `claude --continue`; OmniAgent via `session/load` (resume) | Ao clicar ↻ |

### 5.1 Aviso do Claude Code ao retomar uma sessão grande

O botão **“Recarregar subagentes mantendo a conversa”** do terminal reinicia o Claude Code
com `--continue`. O preset `claude --continue` produz o mesmo comportamento. Isso é diferente
da reconexão normal do terminal: `--continue` pede explicitamente ao Claude Code para localizar
e retomar a conversa anterior daquele diretório.

Quando a conversa encontrada é antiga ou possui muitos tokens, o próprio Claude Code pode
interromper a retomada e mostrar:

1. **Resume from summary (recommended)** — retoma a partir de um resumo compacto;
2. **Resume full session as-is** — recarrega o histórico completo;
3. **Don't ask me again** — deixa de mostrar essa proteção nas próximas retomadas.

**Decisão operacional padrão:** escolher **Resume from summary**. O resumo preserva as decisões
e o contexto essencial com menor consumo de cota, latência e pressão de contexto. A retomada
completa fica reservada a casos em que detalhes exatos da conversa antiga sejam indispensáveis.
Não é recomendado desativar permanentemente o aviso.

Se a conversa anterior não deve ser retomada, pressione `Esc` e use a reconexão normal ou o
preset `claude`, sem `--continue`. Para agentes de trabalho, prefira sessões novas apoiadas por
`AGENTS.md`, memória compartilhada e artefatos persistidos; uma sessão gigante deve ser exceção,
não o mecanismo principal de memória do projeto.

O tempo exibido no cabeçalho do nó mede a idade do nó/sessão no OmniRift. O tempo informado
pelo aviso mede a conversa que o Claude Code encontrou; por isso os dois valores podem diferir.

## 6. Conexões Semânticas (Fase 2 do ACP) — a linha carrega ESTRUTURA

| Funcionalidade | O que faz | Como usar |
|---|---|---|
| **Payload tipado** | A saída do agente vira `diff`/`result`/`text`; a linha mostra badge (📄 diff / ✅ result) | Automático quando o agente edita |
| **ReviewNode (gate)** | Segura o diff, mostra renderizado (DiffViewer), **Aprovar/Rejeitar** antes de fluir | Toolbar → Review; ligue Agente→Review→nó |
| **FilterNode** | Só deixa passar o que casa (por tipo/regex/path) | Toolbar → Filtro; ligue no meio da linha |

## 7. Blackboard & Memória

| Funcionalidade | O que faz | Como usar |
|---|---|---|
| **Blackboard por floor** | O agente usa `scope=<floor>` no `memory_*` → mural compartilhado só do time | Automático (injetado no 1º prompt) |
| **Coordenação assíncrona** | Membros leem/escrevem o mural pra trocar info sem falar direto | Via `memory_remember`/`memory_recall` |

## 8. Fixes de comportamento (nesta linha de trabalho)

- Linha de time **não despeja mais o chat cru** do OmniAgent no terminal (comanda via MCP).
- Acabou o **dump de 20 linhas** (contrato) no input do Orquestrador a cada mudança.
- Subagente sem projeto → grava no `~/.claude/agents` global (em vez de erro).
- Linha do subagente sai da **alça de baixo** (não do lado), subagente centrado abaixo.

## 9. Roadmap — o que ainda falta (v2)

- **Conexões semânticas v2**: minimal-diff no lugar do patch cru; distinguir `result`/`artifact`;
  inserir Review/Filtro **na linha existente** (hoje cria solto).
- **Times = Grupo/Floor com worktree** (spec `2026-06-30-times-grupo-subagentes-design.md`):
  subagentes **realmente** isolados por time (cwd próprio), blackboard namespaceado, orquestrador
  escopado aos membros.
- **`session/load` do OmniAgent**: confirmar suporte ao vivo do adapter Claude (fallback já existe).
- **Reload preservando contexto** no terminal via `--resume <id>` (hoje `--continue`).
- **UX de retomada longa**: antes de usar `--continue`, oferecer escolha explícita entre
  “iniciar sessão limpa” e “retomar conversa”; manter o aviso nativo do Claude Code como proteção.

---

**Specs de design (design-first):**
`docs/superpowers/specs/2026-06-30-acp-agent-layer-design.md` ·
`…-times-grupo-subagentes-design.md` · `…-conexoes-semanticas-fase2-design.md`
