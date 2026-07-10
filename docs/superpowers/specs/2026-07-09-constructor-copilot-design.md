# Constructor — Copiloto Conversacional do Sistema

> **Status:** DRAFT · 2026-07-09 · Branch `feat/orquestracao-integrada`
> **Distinto de:** Orquestrador (comanda agentes) e OmniPartner (tutor/parceiro Aprender).
> **Origem:** a "ConductorBar" (glm52) evolui para o **Constructor** — nome "Conductor" abortado
> (colide com concorrente conductor.build).

## O que é

Uma barra fixa embaixo do canvas onde o **humano conversa com o SISTEMA** — tipo um ChatGPT
que **sabe tudo**: o canvas inteiro (nós, agentes, estados, conexões) **e o código** do projeto.
Ordem de grandeza maior que um dispatcher: é um **copiloto do sistema**. Pode inclusive
**comandar o Orquestrador** (que por sua vez comanda os agentes).

**Não confundir:**
- **Constructor** = onde VOCÊ fala com o sistema (conversa, entende canvas+código).
- **Orquestrador** = quem comanda a frota de agentes (backend `orq_*`, peer-comms `agent_ask/tell/status`).
- **OmniPartner** = tutor/parceiro (modo Aprender) — outra coisa.

## Decisões (confirmadas com o Jessé 2026-07-09)

1. **Constructor é um conceito NOVO** (não é a interface do OmniPartner).
2. **Cérebro selecionável:** dropdown escolhe entre **claude / codex / hermes** — quem *pensa* na
   conversa. NÃO spawna agente-orquestrador (revertido o "abrir ao selecionar").
3. **Resposta em painel flutuante arrastável** (janela solta no canvas, arrasta/redimensiona/fecha).

## Arquitetura

```
┌─────────────────────────────────────────┐
│ ConstructorBar (input + dropdown cérebro) │  ← humano digita
└───────────────┬─────────────────────────┘
                │ mensagem + contexto(canvas+código)
                ▼
        ┌───────────────┐
        │  Constructor   │  agente persistente do cérebro escolhido (claude/codex/hermes),
        │  (cérebro LLM) │  com system = snapshot do canvas + mapa do código; pode chamar
        └───────┬────────┘  tools do Orquestrador pra comandar agentes.
                │ resposta (stream)
                ▼
   ┌──────────────────────────┐
   │ ConstructorPanel (float)  │  ← painel arrastável mostra a conversa
   │  você ↔ Constructor ↔ 🤖  │     (e mensagens de agentes que falam com o Constructor)
   └──────────────────────────┘
```

### Contexto que o Constructor recebe
- **Canvas:** `analyzeCanvas()` (`lib/companion.ts`) — já existe (nós, agentes, estados).
- **Código:** OmniFS (significado) + Serena (símbolos) + OmniGraph (estrutura) — plugar (Fase 2).

## Fases

- **Fase 1 (testável):** rename ConductorBar→ConstructorBar; dropdown = cérebro (claude/codex/hermes);
  **ConstructorPanel** flutuante arrastável mostrando a conversa; enviar mensagem → agente Constructor
  persistente (canvas-aware via `analyzeCanvas`) responde no painel.
- **Fase 2:** contexto do CÓDIGO (OmniFS/Serena/OmniGraph) no system do Constructor.
- **Fase 3:** Constructor **comanda o Orquestrador** a partir da conversa (dispara `orchestrator_dispatch`,
  lê `agent_status`, media com `agent_ask/tell`).

## O que reverter da direção anterior
- Label da barra "Orquestrador" → **"Constructor"**.
- `ensureConductorAgent` (abrir agente-orquestrador ao selecionar) → dropdown apenas **seleciona o cérebro**.

## Preservado (não recriar)
- Peer-comms do notebook (`agent_ask/tell/status`, `marker.rs`, `resolve_agent_fuzzy`) — é do Orquestrador, fica.
- Fixes desta sessão: hermes ACP, installs em `~/.omnirift/tools`.
