# Spec — Code Review IA com LLM do usuário (BYOK) + política configurável

- **Data:** 2026-06-15
- **Status:** Design — aguardando revisão
- **Branch alvo:** novo, a partir do estado atual
- **Depende de:** `floor_git_diff` (Diff viewer, já existe), Land flow + `onLand` hook, padrão de
  config da "Área de Conexões" da memória (`ConnectionsModal` + token ofuscado).
- **Origem:** decisão de produto (Jesse, 2026-06-15) — review de código dentro do Maestri, com o
  **usuário plugando a chave/LLM dele** e definindo **as próprias regras** (métricas, gates, %, contratos, tamanho de PR).

---

## 1. Objetivo

Um **Review** por floor (= branch git) que pega o diff vs base, manda pro LLM **configurado pelo
usuário** com uma **rubrica/política também configurável**, devolve findings estruturados num
painel, e (opcionalmente) **gateia o Land**. Espelha o `code-review-ai` do CI (6 categorias,
thresholds GO/NO-GO) mas **tudo parametrizável pelo usuário**.

Sucesso quando:
- [ ] O usuário configura provider + chave + modelo (OpenAI / Anthropic / Ollama) e o review usa.
- [ ] O usuário edita métricas, pesos, thresholds de gate, % de cobertura, contratos e limites de PR.
- [ ] Rodar Review num floor mostra findings (severidade/categoria/arquivo/linha/sugestão).
- [ ] Gate on/off por projeto: quando on, 1+ CRITICAL ou 2+ WARNING (ou o que o user definir) bloqueia o Land.
- [ ] Chave nunca em texto plano (ofuscada v1 → keychain Fase 2, igual a memória).

## 2. Config de IA / LLM (BYOK) — reusável

Config **geral** (não só review — explainshell/assistente futuro reusam). Multi-provider **nativo**:

| Provider | Endpoint | Auth | Body |
|---|---|---|---|
| **OpenAI-compat** (OpenAI/Groq/OpenRouter/Together/custom) | `{baseUrl}/chat/completions` | `Authorization: Bearer` | `{model, messages}` |
| **Anthropic** | `{baseUrl}/v1/messages` | `x-api-key` + `anthropic-version` | `{model, max_tokens, messages}` |
| **Ollama** | `{baseUrl}/api/chat` (ou `/v1/chat/completions`) | nenhum (local) | `{model, messages, stream:false}` |

Config: `{ provider, baseUrl, apiKey, model }`. Dropdown de preset autopreenche baseUrl. Chave
ofuscada em repouso (padrão `memory_connections`). Mora numa **seção da Conexões** (`ConnectionsModal`)
ou aba "IA" — discoverável junto com os outros backends.

- **Rust**: `llm/` (espelha `memory/`) — trait `LlmProvider { chat(messages) -> String }` +
  `OpenAiProvider`/`AnthropicProvider`/`OllamaProvider` + registry com config persistida.
- **Front**: `llm-client.ts` + cards na Área de Conexões.

## 3. Política de review configurável (o pedido-chave do user)

Tudo editável pelo usuário, salvo **por projeto** (e um default global). Estrutura:

```
ReviewPolicy {
  enabled: bool                      // liga/desliga o review
  gate: "block" | "warn" | "off"     // gateia o Land, só avisa, ou nada
  categories: [                       // MÉTRICAS — o user edita nomes/pesos/se bloqueia
    { key, label, weight, blocking }  // ex: security w=10 blocking, style w=2 nunca-bloqueia
  ]
  thresholds: {                      // GATES — o que reprova
    maxCritical: 0, maxWarning: 1,    // 1+ CRITICAL ou 2+ WARNING bloqueia (default)
    minScore?: number                // opcional: score mínimo agregado
  }
  coverage: number                   // % de cobertura/profundidade do review (passa no prompt)
  contracts: string                  // CONTRATOS — regras extra em texto (vão no prompt)
  prLimits: {                        // TAMANHO DE PR — pré-flight determinístico
    maxFiles?, maxLines?, maxFileLines?  // estoura → WARNING automático antes do LLM
  }
}
```

- Defaults = as 6 categorias + thresholds do `code-review-ai` global (security w10 … style w2).
- **PR limits** rodam **antes** do LLM (pré-flight barato, igual o estágio 1 do CI).
- `contracts` + `coverage` + `categories` entram no **prompt** montado pro LLM.
- UI: editor de política (tabela de categorias com peso/blocking, campos de threshold/coverage/contracts/PR-limits).

## 4. Fluxo

1. Botão **Review** no floor → `floor_git_diff(worktree, base)`.
2. **Pré-flight** (sem LLM): aplica `prLimits` → findings automáticos (PR grande demais etc.).
3. Monta o **prompt**: diff + categorias+pesos + contracts + coverage + "responda SÓ JSON `[{severity,category,file,line,title,suggestion}]`".
4. `llm.chat(prompt)` no provider ativo → parseia o JSON (tolerante: extrai o 1º bloco JSON).
5. Agrega: conta por severidade/categoria, calcula score (pesos), decide GO/NO-GO pelos thresholds.
6. **Painel de Review**: findings agrupados por severidade, com arquivo:linha clicável + sugestão; veredito GO/NO-GO + score.
7. **Gate**: se `gate=block` e reprovou → `landFloor` é bloqueado (alert com o motivo). `warn` → confirma "tem N problemas, land mesmo assim?". `off` → nada.

## 5. Arquitetura / arquivos

- **Rust** `llm/` (trait + 3 providers + registry) — `commands/llm.rs` (config CRUD + `llm_chat`).
- **Rust** `commands/review.rs` — `code_review(worktree, base, policy) -> ReviewResult{findings, verdict, score}` (chama diff + pré-flight + llm + agrega).
- **Front** `lib/llm-client.ts`, `lib/review-client.ts`, `lib/review-policy.ts` (load/save por projeto, localStorage v1).
- **Front** `components/ReviewModal.tsx` (painel), `components/ReviewPolicyModal.tsx` (editor de política), card de IA na `ConnectionsModal`.
- **Wire**: botão Review por floor na Sidebar (perto do Diff/Land); gate no `landFloor`.

## 6. Segurança / honestidade

- Chave ofuscada em repouso (v1) → keychain Fase 2 (mesma dívida da memória).
- Diff pode conter código sensível → vai pro LLM **do usuário** (a chave é dele; sem proxy nosso).
- Timeout + corpo do erro no `llm.chat`. Parsing tolerante (LLM às vezes embrulha o JSON em prosa).
- Pré-flight determinístico roda mesmo se o LLM falhar (degrada gracioso).

## 7. Fora de escopo (v1)

- NÃO review inline no editor (é num painel).
- NÃO auto-fix dos findings (só reporta + sugere).
- NÃO histórico de reviews persistido (Fase 2 — pode reusar o session recorder).
- NÃO streaming da resposta do LLM (request único, sem stream).

## 8. Fases

- **1**: config de IA (3 providers) + `llm_chat`. Critério: "testar" um provider devolve resposta.
- **2**: `code_review` (diff + pré-flight + prompt + parse + agregação) + ReviewModal.
- **3**: editor de ReviewPolicy + gate no Land + por-projeto.
