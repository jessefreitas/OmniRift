---
status: draft
title: Aprendizados do AIOX — o que absorver (e por que não integrar o framework)
date: 2026-07-25
related:
  - docs/superpowers/specs/2026-07-25-mission-orchestration-design.md
  - docs/superpowers/specs/2026-07-09-orquestracao-design.md
  - docs/superpowers/plans/2026-07-25-aiox-padroes-missao.md
source: https://github.com/jessefreitas/aiox-core (fork SynkraAI/aiox-core, MIT)
---

# Aprendizados do AIOX

**Goal:** registrar o que o AIOX ensina de útil para o OmniRift — e deixar explícito
por que **não** devemos integrar `@aiox-squads/core` como dependência ou segundo
control plane.

**Decisão:** absorver padrões (M1–M4) clean-room no host Missão/PTY/ACP.
**Não** plugar o framework AIOX.

---

## 1. O que AIOX é / não é

| AIOX é | AIOX não é |
|---|---|
| Framework de **scaffold** (`npx … init/install`) + CLI | Runtime de frota com PTY/ACP vivos |
| Método ágil agentic em **markdown** no repo do usuário | Host desktop com canvas + SQLite + MCP |
| Stories/checklists como progresso | Mission DAG com wait real + verify + recibo |
| Constituição CLI-first / UI terciária | Produto canvas-first |
| Packs de papéis BMAD + domínio | Capability tipada + roles do projeto |

AIOX responde: *“instale um método no meu repositório e deixe o LLM do IDE operar
em cima desses arquivos.”*

OmniRift responde: *“hospede N agentes reais num canvas, isole em floors/worktrees,
conecte, despache missões e prove o que aconteceu.”*

---

## 2. Por que “problema errado” pra OmniRift

São problemas vizinhos na conversa (“multi-agente”), ortogonais na arquitetura.

| Pergunta | AIOX | OmniRift |
|---|---|---|
| Onde vive a inteligência? | Arquivos MD no repo | Host (Tauri + PTY/ACP + MCP + SQLite) |
| Como o trabalho avança? | LLM lê story e “segue o método” | Host despacha agentes vivos, wait, gates, recibo |
| Fonte da verdade | CLI + markdown no disco | Canvas + `mission_events` + MemoryProvider |
| UI | Terciária (observar CLI) | Primária (controlar a frota) |

Integrar o framework criaria um **segundo sistema de estado** (stories MD)
concorrendo com Mission/SQLite que já existe — e inverteria a tese do produto
(canvas deixa de ser o cockpit).

Analogia: AIOX é o **manual + formulários** na pasta do projeto; OmniRift é a
**oficina** (máquinas PTY, planta Mission, inventário de capabilities, canvas,
`mission_events`). Colocar o manual *como se fosse a oficina* não melhora a
oficina.

O que o AIOX **não** entrega e nós precisamos: PTY/ACP com Idle/Working/Done,
Floor=worktree+Land, MCP `omnirift-agents`+claims, Mission DAG+verify,
MemoryProvider plugável. Tudo isso já é OmniRift.

---

## 3. O que NÃO copiar

| Anti-padrão | Por quê |
|---|---|
| Depender de `@aiox-squads/core` / vendorar `.aiox-core` | Segundo control plane; drift com roles/Mission |
| CLI-first como constituição | Produto é canvas-first |
| Story MD como banco de estado | Estado em SQLite / `mission_events` |
| Installer que muta o repo do usuário em massa | Modelo scaffold ≠ app desktop |
| Doze papéis ágeis BMAD como default | Roles + capabilities bastam; squads = conteúdo opcional |
| Greeting teatral / persona-cosplay | Estrutura sim; teatro não |
| Hooks do IDE como única governança | Governança no host (Rust/MCP) |
| Segundo orquestrador (`aiox` / `aiox-delegate` ao lado do nosso) | Orquestrador OmniRift já é o maestro |
| Sync IDE como núcleo | Nós já spawnamos runtimes; sync de arquivos é secundário |

---

## 4. O que absorver (M1–M4)

Absorver **contratos**, reimplementar no schema OmniRift (`mission/`,
`agent-contract`, `first-value`, blackboard, dock, health). Licença MIT ajuda;
ainda assim código próprio — sem portar o tree deles.

### M1 — First-value no spawn (alto ROI)

**Deles:** ativação = persona curta + status + comandos chave + próximo passo;
só então espera input.

**Nós hoje:** contrato longo (`ORCHESTRATOR_CONTRACT` / `DEV_CONTRACT`); muitos
spawns ficam mudos até o humano digitar.

**Fazer:** após spawn (PTY ready / ACP ready), injetar bloco estruturado
(5–8 linhas, sem teatro) com label/role, floor, status, comandos chave e
próximo passo; opcional missão/capability ativa.

### M2 — Handoff tipado (alto ROI — fecha Missão §8)

**Deles:** artefato YAML consumível (`from`/`to`/`last_command`/`decisions`/
`files_modified`/`blockers`/`next_action`/`consumed`/`timestamp`).

**Nós hoje:** `agent_ask` / `agent_tell` em prosa; Mission despacha task string.

**Fazer:** gravar no blackboard `handoff:<mission>:<from>:<to>`; marcar
`consumed` quando o alvo ler; greeting do próximo aponta para o artefato.

### M3 — Suggested-next na Missão (alto ROI)

**Deles:** workflow-chains sugere próximo agente/comando.

**Nós hoje:** `layer_finished` / `gate_*` nos eventos; UI não sugere.

**Fazer:** OrchestratorDock (ou toast) mostra “próximo: @QA · mission_verify”
a partir do package + última layer.

### M4 — Doctor da orquestração (médio-alto ROI)

**Deles:** health-check paralelo (IDE, hooks, memory, MCP, git) + healers.

**Nós hoje:** health de código parcial; pouco “por que o agente não ativou?”.

**Fazer:** checks: CLIs no PATH, MCP up, memory provider, worktree ok, hooks.

### Fora do corte imediato (depois)

- Context brackets (budget de prompt em sessão longa)
- AgentPack versionável (formato nosso, não tree AIOX)
- `human_approved` na cadeia de qualidade L3
- Run artifact dir por nó (`outputs/<mission>/<node>/`)

---

## 5. Encaixe na Missão existente

```
Missão (capability · DAG · verify · chain)   ← feat/mission-orchestration
        │
        ├─► M1 First-value no spawn          ← priming / 1ª mensagem
        ├─► M2 Handoff tipado                ← blackboard + greeting do próximo
        ├─► M3 Suggested-next no dock        ← reage a layer_finished / gate_*
        ├─► M4 Doctor orquestração           ← painel/checks pré-missão
        └─► M5 brackets · AgentPack · human_approved   (depois)
```

| Peça Missão | Como M1–M4 encaixam |
|---|---|
| `capability_*` | M1 opcionalmente cita capability ativa; M3 sugere invoke |
| DAG / layers | M3 lê `layer_finished` e aponta próximo nó |
| `verify` / `gate_*` | M3 após gate; M4 checa pré-condições do verify |
| `mission_events` | M2/M3 não substituem eventos — complementam UX/artefato |
| Orquestrador dispatch-only | M1 greeting do orch reforça “só despacha”; M2 handoff bounded |

Ordem: **M1 → M2 → M3 → M4**. Não abrir PR de “integração AIOX”.

Plano acionável: `docs/superpowers/plans/2026-07-25-aiox-padroes-missao.md`.

---

## 6. Decisão registrada

| Opção | Decisão |
|---|---|
| Depender de `@aiox-squads/core` | **Não** |
| Vendorar `.aiox-core` / clonar como submodule | **Não** |
| Chamar CLI `aiox` / `aiox-delegate` do canvas | **Não** |
| Absorver padrões M1–M4 clean-room | **Sim** |
| Usar AIOX como conteúdo opcional no futuro | Talvez (fora do core) |

**Uma frase:** AIOX é um excelente *método de arquivo* para quem só tem um IDE;
OmniRift é um *runtime de frota*. Melhoramos o runtime com quatro contratos
deles — não trocando o runtime pelo método.

---

## 7. Referências internas (estudo; não portar)

Estudo sobre o fork `jessefreitas/aiox-core` (upstream Synkra). Pontos úteis
para implementar M1–M4: agent greeting / activation pipeline, handoff YAML
fixtures, workflow-chains, doctor/health, quality-gates em camadas.
Implementação nasce em código OmniRift, não como cópia do tree deles.
