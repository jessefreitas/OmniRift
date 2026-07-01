# Hermes Agent via ACP — recomendação de integração

> Status: **recomendação** · 2026-06-30. Companion da [`2026-06-30-acp-agent-layer-design.md`](./2026-06-30-acp-agent-layer-design.md)
> (a camada ACP genérica). Este documento responde uma pergunta específica: **vale plugar o Hermes
> Agent como um agente ACP no canvas, e por quê?** Fonte: análise do repo `NousResearch/hermes-agent`
> (MIT) + mapeamento do Client ACP atual do OmniRift (`acp/mod.rs`), 2026-06-30.

## TL;DR — o que eu recomendo (e o que NÃO recomendo)

**Recomendo:** adicionar o Hermes como **mais um adapter ACP** ao lado do Claude Code / Codex. É
barato (o OmniRift já é Client ACP — muda o comando de launch, não a arquitetura) e entrega **o
primeiro ganho de capacidade que o OmniAgent hoje não tem: rodar um agente no canvas com modelo
open/local/grátis** (Ollama, OpenRouter, endpoint próprio) em vez de ficar amarrado a Claude/OpenAI.

**NÃO recomendo:** absorver memória, skills ou gateway do Hermes. Isso é **redundante ou conflitante**
com o que o OmniRift já constrói (Fase 8 memória plugável, Central de Skills, relay mobile próprio).

**A honestidade que sustenta isso:** em *capacidade de execução*, o Hermes **não é melhor** que o
OmniAgent. O OmniAgent roda Claude — modelo mais forte que os que o Hermes tipicamente usa. Plugar
Hermes **não te dá um agente mais inteligente**. Te dá **duas** coisas concretas:

1. **Independência de modelo/fornecedor** no canvas (capacidade — estreita mas real).
2. **Prova de que a camada ACP é ecossistema, não wrapper de Claude** (estratégica — o prêmio maior).

Se "rodar agente com modelo grátis/local dentro do canvas" **não** for uma feature que você quer
oferecer, o valor do Hermes-como-agente cai para quase zero, e o que sobra é só (2) + a referência de
design do `acp_adapter` dele. Decida por essa pergunta.

## O que o Hermes é (para não haver ilusão)

- Agente de IA **open-source, MIT** (Nous Research). Monolito de **~600k LOC Python** — TUI próprio,
  gateway multi-plataforma, memória curada com learning loop, skills auto-geradas, cron, subagents.
- **Já é um server ACP nativo.** Distribui pelo ACP Registry oficial via
  `uvx --from 'hermes-agent[acp]==0.17.0' hermes-acp` (entrypoint `hermes-acp = acp_adapter.entry:main`,
  extra `[acp]` puxa só `agent-client-protocol==0.9.0`).
- **Portar o código é inviável** (Python vs Rust/Tauri) e **não é o caminho**. A forma correta de
  "embarcar" um agente Python num app Rust é rodá-lo como **subprocesso ACP** — que é exatamente para
  o que o `acp_adapter` do Hermes foi feito.

## Por que integrar — os 2 ganhos reais

### 1. Modelo-agnóstico no canvas (capacidade exclusiva)

Hoje o OmniAgent é **amarrado ao fornecedor do adapter**: `claude-agent-acp` só roda Claude,
`codex-acp` só roda GPT. **Não existe "Claude Code com Ollama".** Se o usuário do OmniRift quiser
rodar uma tarefa no canvas com um modelo **local (custo zero)**, **não-Anthropic**, ou **self-hosted**,
hoje **não há caminho**. O Hermes é o primeiro: mesmo agente, qualquer modelo (Nous Portal, OpenRouter,
Ollama, endpoint próprio), trocável com `hermes model`.

Valor de produto: mata a objeção mais cara — *"o OmniRift só vale se eu pagar Claude"*. Com Hermes
plugado, o usuário liga um cérebro grátis no canvas e escolhe o modelo por tarefa (crítica → Claude;
repetitiva/barata → Hermes+Ollama). É exatamente o que um canvas de orquestração existe para fazer.

### 2. Prova de plataforma — ecossistema ACP

A spec ACP já argumenta que apostar em ACP **alinha o OmniRift ao ecossistema** (Zed, VS Code,
JetBrains, OpenCode). O Hermes é a **evidência concreta** de que essa camada funciona com um agente
que **não é Claude nem OpenAI** — nem foi feito pela Anthropic/OpenAI. Isso muda a narrativa de
*"OmniRift roda Claude Code"* para **"OmniRift é o canvas universal para qualquer agente ACP"**. É a
diferença entre ser wrapper e ser infraestrutura.

O passo seguinte natural (fora do escopo deste doc, mas é para onde isso aponta): em vez de hardcodar
adapters em `adapter_pkg()`, **consumir o ACP Registry** (`agentclientprotocol/registry`) e listar
todos os agentes ACP existentes e futuros automaticamente. O Hermes é o primeiro do catálogo; o
catálogo é o prêmio.

## O que NÃO absorver (anti-escopo — honestidade)

| Feature do Hermes | Por que NÃO trazer |
|---|---|
| Memória interna + learning loop | Você tem a **Fase 8 (memória plugável)**: blackboard SQLite + `MemoryProvider` injetado em todo agente. A memória do Hermes seria **redundante e provavelmente conflitante** com a sua, que é centralizada e você controla. |
| Skills auto-geradas | Você tem a **Central de Skills** (global + por-agente). Auto-geração autônoma é faca de dois gumes (qualidade, controle) — não é claramente melhor. |
| Gateway mobile (Telegram/Discord/…) | Você está fazendo o **relay mobile próprio** (Cloudflare Worker + DO). O gateway do Hermes você nem usaria. |

Absorver qualquer um desses = reinventar concorrência e brigar com o que já existe. O moat do
OmniRift é o **canvas**; o do Hermes não está lá.

## Por que é barato — viabilidade técnica (verificada)

O OmniRift já é **Client ACP** (`acp/mod.rs`): faz `initialize → session/new`, injeta MCP de
orquestração e proxia eventos. Hoje o `adapter_pkg()` (`acp/mod.rs:29`) só conhece `npx`. Adicionar o
Hermes é escolher **outro comando de launch**:

```rust
// acp/mod.rs — generalizar adapter_pkg() de "pacote npx" para "(comando, args)"
fn adapter_cmd(provider: &str) -> (&str, Vec<String>) {
    match provider {
        "codex"  => ("npx", vec!["-y".into(), "@agentclientprotocol/codex-acp".into()]),
        "hermes" => ("uvx", vec!["--from".into(),
                                  "hermes-agent[acp]==0.17.0".into(),
                                  "hermes-acp".into()]),
        _        => ("npx", vec!["-y".into(), "@agentclientprotocol/claude-agent-acp".into()]),
    }
}
```

**O detalhe que decide a integração — e que já verifiquei no código do Hermes:** o OmniRift injeta o
MCP de orquestração no `session/new` (`mcpServers` → `omnirift-agents` via `mcp-remote`, `acp/mod.rs:128`).
O Hermes **aceita `mcpServers` por sessão** — `acp_adapter/server.py:792` `_register_session_mcp_servers`
suporta `McpServerStdio | McpServerHttp | McpServerSse`. Ou seja: **o nó Hermes nasce com as tools de
orquestração do OmniRift** (`terminal_*`, `workspace_*`, `memory_*`, `claim_*`), igual ao OmniAgent
Claude. Não é teoria — está no código dos dois lados.

O handshake de auth também encaixa: o OmniRift já trata `authMethods` no `initialize` (`acp/mod.rs:159`),
e o Hermes anuncia um método de terminal (`--setup`) para primeiro uso.

## Riscos e mitigação (validar antes da UI)

1. **`uv`/`uvx` no PATH.** App GUI não herda o shell de login — você já apanhou com isso (o
   `login_shell_path()` resolveu para `nvm`). Confirmar que resolve para `uvx` também. **Risco #1.**
2. **Auth.** Exige `hermes model` rodado uma vez (grava `~/.hermes/.env`). Sem isso, o primeiro spawn
   cai em `acp://auth-required`. É o mesmo "Risco #1 = auth do adapter" da spec ACP, versão Hermes.
3. **Primeiro `uvx` baixa o wheel inteiro** (pesado, lento). Para dev, `pip install -e .[acp]` local +
   chamar `hermes-acp` direto. Para produção, considerar pinar via binary-manager (como o omnicompress).
4. **Protocolo ACP instável** (Hermes roda com `use_unstable_protocol=True`; sua spec já nota churn do
   SDK). Manter o proxy transparente atual (robusto a mudança de schema) ajuda.

## Bônus — o que o `acp_adapter` do Hermes ensina de design (referência, não cópia)

Independente de plugar o agente, o `acp_adapter/` do Hermes (~5.2k linhas, isolado, limpo) é uma
**referência de qualidade para o lado server do ACP** — útil quando você for desenhar permissões/review
da sua fatia ACP (que hoje é Client):

- **`permissions.py`** — modelo de permissão 3-tier (`allow_once` / `allow_session` / `allow_always` /
  `deny`) com o tier **session-scoped** (allow-for-session que reseta ao fechar), exatamente o que
  falta no seu gating de permissão. Roube o **padrão**, não o Python.
- **`edit_approval.py`** — aprovação de edit pré-execução, com **auto-approve negado** para
  `.env`/`id_rsa`/`id_ed25519`. Mapeia direto no fs-gate do seu hardening.

## Recomendação faseada

| Nível | Ação | Custo | Ganho |
|---|---|---|---|
| **1** | Plugar Hermes como provider `hermes` no `adapter_cmd` + smoke do handshake (initialize → session/new com mcpServers) em branch isolado; validar os 3 riscos antes de tocar UI | dias | Prova viva: agente não-Claude rodando no canvas com modelo open/local |
| **2** | Consumir o ACP Registry → catálogo dinâmico de agentes (todo agente ACP aparece sozinho) | maior | Ecossistema inteiro plugável — o prêmio real |
| **3** | Usar `acp_adapter/{permissions,edit_approval}.py` como referência ao desenhar permissões/edit-approval da fatia ACP | — | Design acelerado das Fases de permissão/review |

## Decisão em uma pergunta

**"Rodar agente com modelo grátis/local dentro do canvas é uma feature que interessa ao produto?"**

- **Sim** → Nível 1 agora (barato, prova de plataforma + capacidade nova). Depois Nível 2.
- **Não** → pula o Hermes-como-agente; fica só o Nível 3 (referência de design) e o caminho do registry
  com os adapters que você já tem. O Hermes não te dá superpoder de execução — não invente um.

## Nota de repositório

Este documento descreve **técnica de integração ACP** com o Hermes como caso concreto — legítimo do
mesmo jeito que a spec ACP cita Claude Code / Codex / Gemini como adapters. O Hermes é agente
open-source (MIT) que se **integra**, não um concorrente de canvas. Nenhuma menção a concorrente
direto do OmniRift entra no repo.
