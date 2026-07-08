# OmniSwitch — Roteador de chave LLM nativo (design)

> **Data:** 2026-07-07 · **Status:** design aprovado (brainstorming) · **Próximo:** plano de implementação (writing-plans)
> **Escopo:** um gateway de LLM **nativo, in-process** dentro da OmniRift que roteia requests entre múltiplas chaves/providers com fallback, rotação e regra de custo/capacidade — servindo tanto o protocolo **Anthropic** (claude) quanto **OpenAI** (codex/hermes/dispatch). Referência conceitual: OmniRoute (não adotado — copiamos só as ideias essenciais).

---

## 1. Problema e objetivo

Hoje cada agente recebe `key` + `base_url` no spawn e aponta pro `omnicompress-proxy`, que tem **upstream fixo por instância** (Anthropic @ `127.0.0.1:8787`, OpenAI @ `127.0.0.1:8788`). Não há:

1. **Rotação/fallback de chave** — se uma chave bate rate-limit (429) ou quota, o agente trava; não há troca automática pra outra chave/provider.
2. **Endpoint único com roteamento** — a escolha de provider/modelo é feita fora (env por agente, cascade do `multi_agent_dispatch`), fragmentada.
3. **Roteamento por custo/capacidade** — não há um lugar que diga "código → coder barato; crítico → modelo forte" de forma centralizada e observável.

**Objetivo:** um endpoint interno único (`OmniSwitch`) que os agentes/serviços do ecossistema apontam, que resolve provider+chave por request com fallback e rotação, e é a **fonte única** de roteamento de LLM.

### Não-objetivos (YAGNI — cortado do OmniRoute)
- Catálogo de 237 providers embutido (começamos com os providers já cadastrados na Central de Providers).
- 17 estratégias de roteamento (v1 tem 4).
- Tradução cross-protocol Anthropic↔OpenAI (Fase 2 — ver §3.4).
- Compressão embutida (a OmniRift já tem OmniCompress; integração é Fase 2 — ver §4).
- PWA / Electron / desktop app / site de marketing.

---

## 2. Arquitetura

Novo módulo Rust `apps/desktop/src-tauri/src/llm_router/`, seguindo o padrão do `mcp/server.rs`:

- Server **axum 0.7** em loopback `127.0.0.1:<ROUTER_PORT>` (porta aleatória por boot, gravada no `runtime.json`, como o MCP), protegido por **token de auth** (Bearer / `?token=`) — só processos locais autorizados falam com ele.
- Cliente HTTP de upstream via **reqwest 0.12** (rustls) — já é dependência.
- Sobe no `setup()` do app (`tauri::async_runtime::spawn`), degrade limpo se a porta não bindar (fail-soft, igual ao MCP e ao proxy).

### Rotas expostas
| Rota | Protocolo | Consumidor |
|------|-----------|------------|
| `POST /v1/messages` | Anthropic Messages | claude CLI (`ANTHROPIC_BASE_URL`) |
| `POST /v1/messages/count_tokens` | Anthropic | claude CLI |
| `POST /v1/chat/completions` | OpenAI | codex/hermes/dispatch (`OPENAI_BASE_URL`) |
| `GET /v1/models` | OpenAI | listagem (clientes que sondam modelos) |
| `GET /healthz` | — | watchdog/diagnóstico |

### Módulos internos
```
llm_router/
  mod.rs          # boot do server, state (RouterState), token
  server.rs       # axum Router + handlers das rotas /v1/*
  table.rs        # RoutingTable: classes → cadeia ordenada de alvos (load/parse/validate)
  engine.rs       # decisão de roteamento (PURO/testável): (tabela, req) → alvo escolhido
  health.rs       # KeyHealth: estado por chave (healthy | cooling{until}) — PURO/testável
  forward.rs      # forward reqwest pro upstream escolhido + classificação de erro (429/5xx/timeout)
  keys.rs         # resolução da chave via keychain (credential.llm.<id>) — nunca em disco claro
```

**Fronteiras claras:** `engine.rs` e `health.rs` são **puros** (sem IO, sem axum) → testáveis em unidade direto (disciplina failproof). `forward.rs` isola o IO de rede. `table.rs` isola parsing/validação da config.

---

## 3. Roteamento

### 3.1 Tabela de roteamento (config)
Estende a Central de Providers. Arquivo `~/.omnirift/llm_router.json` (config, **sem segredo**):

```jsonc
{
  "version": 1,
  "classes": {
    "code":   [ { "providerId": "ollama-cloud", "model": "kimi-k2.7-code", "keyRef": "credential.llm.ollama-cloud", "cost": "low", "capability": "high" },
                { "providerId": "groq",         "model": "llama-70b",       "keyRef": "credential.llm.groq",         "cost": "low", "capability": "mid"  } ],
    "text":   [ /* … */ ],
    "agent":  [ /* … */ ],
    "claude": [ { "providerId": "anthropic", "model": "claude-sonnet-5", "keyRef": "credential.llm.anthropic", "cost": "mid", "capability": "high" } ]
  },
  "defaultStrategy": "explicit"
}
```

- **Classe** = cadeia **ordenada** de alvos (mesma semântica do `CASCADE_*` do `models.env`). A ordem é o fallback natural.
- **Chave** referenciada por `keyRef` (nome no keychain), **nunca** o valor. Resolvida em `keys.rs` no momento do forward.
- Semente inicial: importar da Central de Providers existente + dos `CASCADE_CODE/TEXT/AGENT` do `models.env`.

### 3.2 Estratégias (v1 = 4)
| Estratégia | Escolha |
|-----------|---------|
| `explicit` | o `model` do request casa 1:1 com um alvo (default; comportamento previsível) |
| `cost-first` | menor `cost` entre os alvos capazes da classe |
| `capability-first` | maior `capability` |
| `round-robin` | alterna entre chaves do MESMO provider (load-balance) |

A classe é resolvida do request por: (a) header `x-omniswitch-class`, (b) mapeamento `model → classe` na tabela, (c) fallback pra classe default por protocolo.

### 3.3 Fallback + rotação + saúde de chave
- **Fallback**: erro classificado como retriável (`429`, `5xx`, timeout, connection-refused) → tenta o **próximo alvo** da cadeia da classe. Erros do cliente (`4xx` exceto 429) **não** fazem fallback (repassa o erro — não mascara bug do request).
- **Rotação de chave**: `429`/quota num alvo → a chave entra em **cooldown** (`health.rs`: `cooling { until: <ts> }`, backoff configurável, ex. 60s). Requests seguintes **pulam** chaves em cooldown até esfriarem.
- **Teto de tentativas**: N alvos por request (config, ex. 3) → evita varrer a cadeia inteira num pico. Esgotou → devolve o último erro do upstream (com header `x-omniswitch-exhausted: true`), nunca fabrica resposta.

### 3.4 Protocolo (escopo v1)
v1 roteia **dentro da mesma família de protocolo**:
- `/v1/messages` (Anthropic) → alvos cujo provider fala Anthropic (`api.anthropic.com` ou qualquer upstream com `/v1/messages`).
- `/v1/chat/completions` (OpenAI) → alvos OpenAI-compat.

**Fase 2:** tradução Anthropic↔OpenAI (permite servir um request `/v1/messages` a partir de um provider OpenAI e vice-versa). É a parte mais cara (mapeamento de mensagens/tools/streaming) e fica fora do v1 de propósito.

---

## 4. Integração com agentes

No spawn (`agent-roles.ts` / `acp/mod.rs` / spawn PTY), as env de base URL apontam pro **OmniSwitch** em vez do upstream fixo:
- `ANTHROPIC_BASE_URL = http://127.0.0.1:<ROUTER_PORT>` (+ token)
- `OPENAI_BASE_URL   = http://127.0.0.1:<ROUTER_PORT>/v1`

Fluxo v1: **agente → OmniSwitch (escolhe provider/chave + fallback) → provider**.

**Compressão (Fase 2):** encadear o `omnicompress-proxy` no caminho de saída (`OmniSwitch → omnicompress-proxy(do provider escolhido) → provider`). Fica fora do v1 pra não acoplar roteamento com compressão; o proxy atual segue funcionando em paralelo durante a migração (feature flag — ver §7).

---

## 5. UI / Observabilidade

Estende o modal da **Central de Providers** (não cria tela nova):
- **Editor da tabela**: classes → alvos ordenados (arrastar pra reordenar = mudar prioridade de fallback), estratégia por classe.
- **Painel ao vivo** (lê `GET /healthz` + métricas do router): por alvo/chave — estado (🟢 saudável / 🟡 esfriando `até HH:MM:SS`), contador de requests, último erro, latência.
- Feature flag no painel de flags (default do rollout — ver §7).

---

## 6. Segurança

- Chave **só no keychain** (`credential.llm.<id>`), resolvida no forward, **nunca** persistida em `llm_router.json` nem logada (passa pelo `redactor`).
- Server em **loopback + token** (mesma garantia do MCP server): sem token → 401.
- `llm_router.json` gravado 0600 (carrega refs, não segredos, mas espelha o padrão do `agent-mcp.json`).
- Erros de upstream repassados sem vazar headers de auth.

---

## 7. Rollout (feature flag) e migração

- Flag `omniswitch` no painel de flags. **Default `false`** no v1 (experimental) → o comportamento atual (proxy de upstream fixo) segue intocado.
- Ligado: os spawns novos apontam pro OmniSwitch; agentes vivos não são afetados até reload.
- Kill-switch: desligar a flag volta pro proxy fixo sem perder nada (diretriz "features como feature flags").

---

## 8. Testes (failproof — validação por execução)

**Unidade (puros):**
- `engine`: (tabela, request, estratégia) → alvo esperado; cobre `explicit`/`cost-first`/`capability-first`/`round-robin`.
- `engine` fallback: alvo #1 em cooldown / com erro retriável → escolhe #2; cadeia esgotada → erro `exhausted`.
- `health`: 429 → cooling com `until` correto; após `until` → healthy de novo; chave cooling é pulada.
- `table`: parse/validação (classe vazia, keyRef inexistente, model duplicado) → erro claro.

**Integração:**
- Sobe o router contra um **upstream mock** (axum de teste): request OK → 200 forwardado; mock devolve 429 → router faz fallback pro 2º alvo; verifica header `x-omniswitch-exhausted` quando todos falham.
- Auth: sem token → 401.

**Regression guard:** suíte Rust inteira + `tsc` (a UI da Central de Providers).

---

## 9. Fases

| Fase | Escopo |
|------|--------|
| **1 (este design)** | módulo nativo + endpoints Anthropic/OpenAI mono-protocolo + tabela + 4 estratégias + fallback/rotação/cooldown + integração no spawn (flag) + UI básica + testes |
| **2** | tradução cross-protocol Anthropic↔OpenAI · compressão encadeada (OmniCompress) · sync da tabela com o cofre OmniMemory · métricas ricas (custo agregado, tokens salvos) |

---

## 10. Riscos

- **Streaming**: `/v1/messages` e `/v1/chat/completions` são streaming (SSE). O forward tem que repassar o stream sem bufferizar (reqwest stream → axum body). Risco médio; o proxy atual já faz isso (referência).
- **Classificação de erro no meio do stream**: um 429 pode vir ANTES do stream começar (fácil, faz fallback) ou o stream cair no meio (não dá pra re-rotear sem o cliente perceber). v1: só re-roteia em erro ANTES do primeiro byte do corpo; queda no meio = repassa como está (documentado).
- **Divergência com o proxy de compressão**: enquanto os dois coexistem (flag), garantir que não haja porta/duplo-forward. Mitigado pelo rollout por flag (§7).
