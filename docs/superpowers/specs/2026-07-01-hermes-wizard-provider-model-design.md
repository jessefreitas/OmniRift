# OmniAgent · Hermes — Wizard de provider + BYOK + seletor de modelo — Design

> Status: **DRAFT / design-first** · 2026-07-01. Derivado de um furo real batido ao vivo: o card
> "Este provider precisa de login" do Hermes chama o setup **interativo** do adapter e **trava**
> ("depois daqui nada acontece"). Direção do Jessé: **"tem que ter o wizard pra escolher o modelo"**
> + **"imagina OpenRouter não poder escolher"**. Não buildar até o desenho estar bom (mesmo princípio
> das specs [ACP layer](2026-06-30-acp-agent-layer-design.md) e [Hermes integration](2026-06-30-acp-hermes-integration-design.md)).

## Problema — o login do Hermes não fecha no ACP, e modelo fixo mata o Hermes

Hoje o OmniAgent · Hermes sobe, o handshake ACP retorna `authMethods` não-vazio (`[hermes-setup]`), o
app mostra o card **"Entrar com Configure Hermes provider"**, e ao clicar → chama o método ACP
`authenticate` (id=4). O adapter Hermes **não resolve** isso programaticamente: o `hermes acp --setup`
é um **wizard de terminal** (TTY: OAuth no browser ou paste manual). Sem TTY, o `authenticate` fica
pendurado → a UI trava em "aguarde…". **O login nunca conclui.**

E mesmo se concluísse: forçar **um modelo fixo** anularia o motivo de existir do Hermes. Ele é
**model-agnostic** — o valor é justamente **escolher**: o OpenRouter é aggregator de **centenas** de
modelos; o Ollama Cloud tem vários; local (LM Studio/vLLM) idem. Sem seletor, o Hermes vira um Claude
capado. **Tem que ter wizard: provider → key → modelo.**

## Descoberta técnica (engenharia reversa do `hermes-agent` 0.17.0)

Confirmado lendo `hermes_cli/providers.py` + `runtime_provider.py` + `_parser.py` + `oneshot.py`:

- **Catálogo de providers** (`providers.py`): overlays `ollama-cloud` (`base_url=https://ollama.com/v1`,
  `transport=openai_chat`), `openrouter` (`is_aggregator=True`), `local`/`lmstudio`, `openai`, `xai`,
  `glm`, `kimi`, … — cada um com `auth_type` (`api_key` | `oauth_*`) e `base_url_env_var`.
- **BYOK por env, host-gated (seguro)**: a key é lida por env var **casando o HOST** do endpoint
  (`runtime_provider.py:1004-1022`) — `OLLAMA_API_KEY` só quando o host é `ollama.com`,
  `OPENROUTER_API_KEY` só quando é openrouter, etc. (mitigação GHSA-76xc-57q6-vm5m: não vaza credencial
  entre endpoints). Ou seja: **injetar a key certa por env é o caminho oficial e seguro.**
- **Forçar provider+modelo SEM wizard**: `HERMES_INFERENCE_PROVIDER` (lido em `runtime_provider.py:454`)
  e `HERMES_INFERENCE_MODEL` (`_parser.py:125`, `oneshot.py:19`) sobrescrevem a config default. Com os
  dois setados no ambiente do processo ACP, o Hermes **nasce configurado** → `initialize` devolve
  `authMethods` **vazio** → o nosso backend já faz `session/new` direto (código atual, `acp/mod.rs:177`).
- **Lista de modelos**: todo provider `openai_chat` expõe **`GET {base_url}/v1/models`** (OpenAI-compat,
  `Authorization: Bearer {key}`). É o mesmo que o `hermes model --refresh` faz ("re-fetch every
  provider's live /v1/models list"). Alguns aggregators (OpenRouter) listam sem key.

**Conclusão:** dá pra fazer BYOK + seleção 100% pelo OmniRift, **sem** o wizard interativo do Hermes —
substituindo o card de login por um wizard nativo que termina num spawn com 3 env vars.

## Solução — wizard nativo (provider → BYOK → modelo) no lugar do card de login

Quando o provider é **Hermes** e o handshake pede auth (ou o usuário abre "configurar"), em vez do
card "Entrar com…", mostrar um **wizard de 3 passos** dentro do AgentNode:

### Passo 1 — Provider
Dropdown do catálogo (v1: **Ollama Cloud**, **OpenRouter**, **Local/LM Studio**; extensível). Cada item
sabe seu `base_url` default, o `base_url_env_var` e a **env var da key** (host-gated).

### Passo 2 — Key (BYOK)
- Campo de API key (password). **Ollama Cloud**: opção "usar a key da OmniForge" (puxa do cofre/keychain
  se existir) **ou** colar a própria. **OpenRouter / outros**: usuário cola a dele.
- **Local** (LM Studio/vLLM/Ollama local): sem key, só `base_url` (default `http://127.0.0.1:...`).
- A key é gravada no **keychain do SO** (`memory/secret_store.rs`, crate `keyring` — já existe da Fase 2),
  fallback ofuscado. **Nunca** em texto no store do canvas.

### Passo 3 — Modelo
- App faz **`GET {base_url}/v1/models`** com a key → popula um dropdown com os modelos reais do provider.
- Busca/filtro (OpenRouter tem centenas). Mostra id + (se vier) context length / preço.
- Fallback: se o fetch falhar (rede/401), permitir **digitar o id do modelo à mão** (não travar).

### Concluir → spawn autenticado
Salva `{provider, model, keyRef}` no nó (`AgentNode`) + keychain. O backend spawna o Hermes ACP com:
```
HERMES_INFERENCE_PROVIDER=<provider>
HERMES_INFERENCE_MODEL=<model>
<PROVIDER>_API_KEY=<key>              # host-gated: OLLAMA_API_KEY / OPENROUTER_API_KEY / …
[<PROVIDER>_BASE_URL=<url>]           # só se custom (local)
```
→ `initialize` volta com `authMethods` vazio → `session/new` direto → **card operacional, sem login**.
O **seletor de modelo que já temos** (dropdown ACP `session/set_model`) segue funcionando pra trocar
de modelo **dentro** da sessão, quando o provider suporta.

## Arquitetura — arquivos tocados (estimativa)

- **`src-tauri/src/acp/mod.rs`** (`spawn`): aceitar um `provider_config` (provider/model/base_url/key) e
  **injetar as env vars** no `Command` do adapter Hermes (hoje o spawn não passa env custom). A key vem
  resolvida do keychain no backend — não trafega em claro pelo IPC mais que o necessário.
- **`src-tauri/src/commands/acp.rs`**: `acp_spawn` ganha o `provider_config` opcional; novo comando
  **`hermes_list_models(provider, keyRef|key, base_url?)`** → faz o `GET /v1/models` (reqwest) e devolve
  a lista (o app não fala HTTP de provider direto do front — passa pelo Rust, uniformidade + CORS).
- **`src-tauri/src/memory/secret_store.rs`**: reusar pra `set/get` da key BYOK por provider
  (`hermes.<provider>.api_key`).
- **`src/components/nodes/AgentNode.tsx`**: quando `provider==="hermes"` e precisa de config, renderizar o
  **`HermesWizard`** (3 passos) no lugar do bloco de auth atual (`authMethods.map`). Passar o
  `provider_config` pro `acpSpawn`.
- **`src/components/nodes/HermesWizard.tsx` (NOVO)**: os 3 passos (provider/key/modelo) + estado.
- **`src/lib/acp-client.ts`**: `acpSpawn` aceita `providerConfig`; `hermesListModels(...)`.
- **`src/types/canvas.ts`**: `AgentNode` ganha `providerConfig?: { provider, model }` (keyRef vive no
  keychain, não no nó). Catálogo de providers (const) no front pra o dropdown do passo 1.
- **Preset**: "OmniAgent · Hermes" abre já no wizard (passo 1) em vez de spawnar cego.

## Faseamento (rumo à próxima release)

- **Fase 1 — BYOK + spawn por env (destrava o Hermes):** wizard mínimo (provider dropdown + campo de key
  + campo de modelo texto) → spawn com as 3 env vars → sessão nasce autenticada. **Entregável com valor:
  Hermes funciona com Ollama Cloud/OpenRouter usando a MINHA key, sem travar no login.**
- **Fase 2 — Model picker ao vivo:** `hermes_list_models` (`GET /v1/models`) → dropdown real com
  busca/filtro; fallback pra digitar à mão. **É o "wizard pra escolher o modelo" de verdade.**
- **Fase 3 — Key no keychain + "usar key da OmniForge":** persistência segura por provider + atalho da
  key do cofre pro Ollama Cloud.
- **Fase 4 (opcional):** providers OAuth (xAI, Nous Portal) via device-code — fora do BYOK simples.

## Segurança

- Key **host-gated** (o próprio Hermes já garante que `OLLAMA_API_KEY` só vai pro host ollama.com, etc.).
- Key no **keychain do SO** em repouso (nunca no JSON do canvas, nunca em log; redactor já cobre `sk-`/
  `OPENROUTER`/etc. no terminal).
- O `GET /v1/models` roda no **backend Rust** (não expõe a key ao front além do necessário).

## Não-objetivos / fora de escopo

- Providers OAuth-only (device-code/browser) na v1 — só `api_key` (BYOK) + `local` (sem key).
- Descoberta de preço/limites por modelo (só o que o `/v1/models` já devolver).
- Aplicar isso ao Codex (Codex tem auth própria ChatGPT/API — fluxo separado já existente).

## Decisões a travar (Jessé revisa)

- **D1:** Providers no wizard v1 — recomendação: **Ollama Cloud + OpenRouter + Local** (cobre "grátis/
  local", "aggregator", "cloud com key"). Demais entram por extensão do catálogo.
- **D2:** Fase 1 (modelo por texto) já entra sozinha na próxima release, ou espera a Fase 2 (picker ao
  vivo)? Recomendação: **1+2 juntas** — o valor do Jessé é *escolher da lista*, texto puro é meia-feature.
- **D3:** "Usar a key da OmniForge" pro Ollama Cloud aparece na v1 (atalho) ou só BYOK manual primeiro?
  Recomendação: **BYOK manual na Fase 1**, atalho do cofre na Fase 3 (evita acoplar ao cofre cedo).
- **D4:** O wizard **substitui** o card de auth do Hermes ou **coexiste** (auth p/ OAuth, wizard p/
  api_key)? Recomendação: **substitui** pro Hermes (o `authMethods=[hermes-setup]` vira o gatilho do
  wizard); OAuth real fica pra Fase 4.
