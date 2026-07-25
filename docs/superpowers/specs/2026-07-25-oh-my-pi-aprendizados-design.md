---
status: active
title: Aprendizados do oh-my-pi (omp) — disciplina de tool I/O, não outro coding agent
date: 2026-07-25
related:
  - docs/superpowers/specs/2026-07-25-mission-orchestration-design.md
  - docs/superpowers/specs/2026-07-25-aiox-aprendizados-design.md
  - docs/superpowers/plans/2026-07-25-mission-orchestration.md
source: https://github.com/can1357/oh-my-pi (fork de Pi / badlogic/pi-mono; MIT)
---

# Aprendizados do oh-my-pi (omp)

**Goal:** registrar o que o omp ensina de útil ao OmniRift — e deixar explícito
por que **não** devemos integrar o core do omp (nem competir com Claude/Codex
como coding agent).

**Decisão:** absorver disciplina de tool I/O + higiene ACP + handoff (alinhado
a Missão / padrões AIOX M1–M2). **Não** vendorar `@oh-my-pi/*`. **Não** portar
hashline para o host. Spawn `omp`/`omp acp` como ROLE só sob demanda explícita.

---

## 1. O que omp é / não é

| omp é | omp não é |
|---|---|
| Coding agent de terminal completo (~55k LOC Rust + Bun/TS) | Host/canvas de frota |
| Concorrente de Claude Code / Codex (loop LLM + 32 tools) | Orquestrador desktop |
| Hashline + LSP + DAP + browser + subagents *dentro* do agente | Missão + floors + MCP `omnirift-agents` |
| TUI / RPC / ACP *server* | Client ACP / PTY manager (papel do OmniRift) |

omp responde: *“sou o agente que edita, busca, debugga e fan-outa subagents
no seu terminal.”*

OmniRift responde: *“hospedo N agentes (quaisquer CLIs), isolo em floors,
despacho missões com recibo e mostro tudo no canvas.”*

---

## 2. Por que “problema errado” se integrarmos o core

São problemas vizinhos (“agente que programa”), ortogonais no papel do produto.

| Pergunta | omp | OmniRift |
|---|---|---|
| Quem edita o código? | Tools do próprio agente (hashline, …) | Agente spawnado + Serena |
| Onde vive a orquestração? | `task` / swarm *dentro* de um processo | Missão + Orquestrador *são* o app |
| Memória | mnemopi / hindsight | MemoryProvider (Local / OmniMemory / Obsidian) |
| UI | TUI do agent | Canvas React Flow |
| Integração | `omp` binário / `omp acp` | Tauri spawna PTY/ACP de terceiros |

**Analogia:** omp é um **funcionário especialista** (com kit próprio de ferramentas).
OmniRift é a **empresa** (contrata vários funcionários, define missões, audita).
Comprar a empresa do funcionário e colar dentro da nossa não melhora a empresa —
vira duas empresas no mesmo CNPJ.

Se “integrar omp” virar dependência Bun+nativos no Tauri:

| Tentativa | Efeito |
|---|---|
| Vendorar `@oh-my-pi/*` | Segundo coding agent embutido; conflito com Claude/Codex/Serena |
| Portar hashline pro host | Dual edit surface; claims quebram |
| Adotar swarm YAML como orquestrador | Segundo control plane ao lado da Missão |
| Trocar MemoryProvider por mnemopi | Regressão da Fase 8 |

Conclusão: **biblioteca de ideias**, não dependência.

### O que omp não entrega (e nós precisamos)

- Canvas multi-agente com pipes A→B  
- Floor = worktree + Land  
- Mission DAG + `validate_chain` + verify ≠ gate:land  
- MemoryProvider plugável + Área de Conexões  
- Roles/capabilities do projeto OmniRift  

### O que omp entrega de sobra (e nós não precisamos como core)

- 32 tools de coding agent  
- LSP/DAP embutidos  
- Browser automation no agent  
- TUI própria  
- metaharness (bench lab)  

---

## 3. O que *é* bom para a gente (padrões)

Absorver **contratos**; reimplementar no host (`mcp/tools.rs`, `acp/`, Missão).
Licença MIT; ainda assim preferir código próprio.

### 3.1 Summarize > dump (T1 — alto ROI) ✅

**Deles:** `read` resume por default; caps; footer “re-leia `:5-16,40-80`”;
scout pode forçar dump.

**Nós:** `memory_recall` / `memory_list` (Local + provider) em
`apps/desktop/src-tauri/src/mcp/tools.rs` — helpers `summarize_memory_value`,
`memory_fmt_opts`, `fmt_memories` / `fmt_records`.

**Feito (SHA `9ead153`):**

- Default summary (1ª linha, 240 chars) + paginação `offset`/`limit`
- Flag `raw: true` ou `full: true` para dump
- Footer `meta: { truncation, mode, next_offset, returned, total_matched, … }`

### 3.2 Higiene ACP (T2 — alto ROI) ✅

**Deles (modo ACP server):** stdout só NDJSON; MCP vem do client em
`session/new.mcpServers`; caps ~4k em text updates; paths absolutos.

**Nós (client em `acp/mod.rs`):** helpers testáveis —

- `client_owned_mcp_servers` — MCP `omnirift-agents` via stdio/`mcp-remote` (não lê `.mcp.json`)
- `resolve_cwd_abs` — cwd absoluto no `session/new`
- `UPDATE_TEXT_SOFT_CAP` (4096) no coalesce do EventLog + `acp-hygiene.ts` no front

**Gaps restantes:** stdout do adapter third-party não é policado além do stderr log;
não há assert runtime de que o adapter *honrou* `mcpServers` (só ownership no payload).

### 3.3 Handoff tipado (T3 — alto ROI; = M2 AIOX/Missão)

**Deles:** pipeline de handoff + reinjeção com prefix estável.

**Nós:** Missão §8 / AIOX M2 já pedem artefato consumível.

**Fazer:** schema no blackboard/SQLite; greeting do próximo nó aponta pro
artefato, não pro scrollback.

### 3.4 Perfis scout vs integrator (médio)

**Deles:** task agents com `readSummarize` off + yield JSON.

**Fazer:** preâmbulo de role/Missão com perfil de I/O (`scout` | `integrator`).

### 3.5 Signals-via-FS (médio, opcional)

**Deles:** swarm comunica por arquivos de signal.

**Fazer:** opcional `signals/` no cwd do floor como complemento a `agent_tell`.
**Não** portar o runner swarm.

### 3.6 First-value (já M1)

Confirma: agente mudo pós-spawn = morto.

---

## 4. Hashline — entender e não portar

### 4.1 Mecânica

1. `read` grava snapshot → tag 4-hex `[path#A1B2]` + linhas `N:TEXT`.  
2. Modelo edita com ops (`SWAP` / `DEL` / `INS` / …) ancoradas nesse snapshot.  
3. Apply valida tag + conteúdo live; stale → reject ou recovery fail-closed.  
4. Sucesso → novo tag; próximo edit reancora.

### 4.2 Por que zero ROI no host OmniRift

| Onde | Veredito |
|---|---|
| Host-side | Host não edita código |
| Via Claude/Codex spawnados | Não falam o dialeto hashline |
| “Dar hashline aos workers” | Colide com Serena; dual source of truth; claims quebram |

ROI de hashline é **dentro** do harness omp. Fora = irrelevante.

---

## 5. Anti-padrões (não copiar)

1. Stack completo de coding agent no monorepo OmniRift.  
2. Hashline (ou qualquer segundo edit surface) ao lado de Serena.  
3. Swarm YAML como segundo Orquestrador.  
4. Memória omp no lugar do MemoryProvider.  
5. Vendorar pacotes Bun/nativos no Tauri “porque é MIT”.  
6. metaharness no produto (é lab de benchmark).

---

## 6. Spawn omp como ROLE? (opcional)

| Prós | Contras |
|---|---|
| Mais um coding agent no menu (`omp acp`) | Não desbloqueia Missão/floors/Serena |
| ACP já é caminho conhecido no OmniRift | Manutenção de mais um adapter |
| Usuário que já usa omp fica feliz | Prioridade baixa vs T1–T3 |

**Decisão:** só sob pedido explícito de produto. Não bloqueia T1–T3.

---

## 7. Decisão registrada

| Opção | Decisão |
|---|---|
| Integrar core omp / `@oh-my-pi/*` | **Não** |
| Portar hashline | **Não** |
| Absorver T1 summarize/caps | **Sim** |
| Absorver T2 higiene ACP | **Sim** |
| Absorver T3 handoff (com M2) | **Sim** |
| ROLE `omp` / `omp acp` | Opcional, baixa prioridade |

**Uma frase:** omp é um Claude Code com harness de edit/tool melhorado; OmniRift
é o staging. Roube a disciplina de I/O e ACP; não o agente.

---

## 8. Encaixe no roadmap

```
Missão (capability · DAG · verify · chain)
AIOX M1 first-value ✅ · M2 handoff ✅ (= T3)
        │
        ├─► T1  summarize/caps nas tools MCP do host ✅ (memory_*)
        ├─► T2  higiene ACP (stdout, MCP ownership, caps) ✅
        ├─► T3  handoff tipado (= M2) ✅
        └─► T4  (opcional) ROLE omp ACP — não sem pedido
```

Ordem restante: **T4 opcional**. Não abrir PR de “integração omp”.

---

## 9. Referências de estudo (não portar)

Estudo sobre `can1357/oh-my-pi` (MIT). Áreas úteis para quem implementar T1–T2:

- Tool result truncation / read-summarize — `packages/coding-agent/src/tools/`  
- Hashline (só para *entender* o anti-padrão no host) — `packages/hashline/`  
- ACP mode hygiene — `packages/coding-agent/src/modes/acp/`  
- Swarm signals (opcional conceitual) — `packages/swarm-extension/`  

Implementação nasce em código OmniRift, não como cópia do monorepo omp.
