---
status: active
title: Ciclo de vida de specs + orquestração multi-agente
date: 2026-06-16
---

# Ciclo de vida de specs + orquestração multi-agente — Design

**Goal:** Tornar specs/planos gerenciáveis (status, arquivamento, fontes do usuário) e dar ao Orquestrador a capacidade de abrir CLIs com **teto**, **aprovação do usuário** e **coordenação** entre agentes — sem que specs se atravessem nem quebrem código de outros agentes.

**Por que agora:** a seção Specs lista todo `.md` de `docs/superpowers/{specs,plans}` sem status → entulha e dá pra re-despachar plano morto. O Orquestrador já abre CLIs (`terminal_spawn_on_floor`) mas sem teto nem aprovação. Falta o tecido de coordenação.

---

## Princípios

- **Isolamento por floor = branch git = worktree.** 1 spec → 1 floor. Agentes de floors diferentes não veem os arquivos um do outro. Conflito aparece no **merge/land + code-review**, nunca silenciosamente.
- **Status automático > burocracia.** O estado da spec cai de maduro (checkboxes), não de marcação manual.
- **Humano no controle do fan-out.** O Orquestrador propõe e **pergunta** antes de spawnar; teto rígido como backstop.
- **Coordenação via blackboard.** Agentes postam claims/decisões na memória compartilhada e leem antes de tocar em arquivo comum.

---

## Bloco A — Ciclo de vida das specs

### Modelo de status
Status derivado nesta ordem de prioridade:
1. **Frontmatter** `status: active|done|obsolete` e/ou `superseded_by: <arquivo>` (override manual).
2. **Checkboxes**: se o plano tem tasks `- [ ]`/`- [x]` e **100% estão `[x]` → `done`** (automático).
3. **Pasta**: arquivos sob `docs/superpowers/archive/` → `archived`.
4. Senão → `active`.

### Backend (`commands/spec.rs`)
- `SpecFile` ganha: `status: String`, `done_tasks: u32`, `superseded_by: Option<String>`.
- `spec_list_files` computa o status (lê frontmatter + conta checkboxes marcadas vs total).
- Novo comando `spec_archive(path)` → move o arquivo pra `docs/superpowers/archive/` (cria a pasta). `spec_unarchive(path)` reverte.

### UI (`Sidebar` seção Specs)
- Agrupa em **Ativos / Concluídos / Arquivados**. Concluídos e Arquivados **recolhidos por padrão** (toggle "mostrar").
- Item concluído/obsoleto: título esmaecido + chip de status; o 🚀 (dispatch) **desabilitado** (não re-despacha lixo).
- Ação por item: **Arquivar** / **Reativar**; abrir (já existe, abre no Preview editável).

---

## Bloco B — Specs mapeáveis pelo usuário

- **Raízes de spec configuráveis** (persistidas por projeto em localStorage, ex.: `omnirift-spec-roots`): além do default `docs/superpowers/{specs,plans}`, o usuário adiciona pastas (`docs/rfcs/`) ou arquivos `.md` soltos.
- `spec_list_files` aceita `extraRoots: Vec<String>` e varre todos; deduplica por path.
- **"Nova spec/plano"**: cria um `.md` a partir de um **template** (cabeçalho superpowers + `## Task N` + checkboxes) no projeto; abre no Preview (editável) pra você escrever.
- **"Importar"**: dialog pra escolher um `.md` e registrá-lo como raiz/arquivo de spec.

---

## Bloco C — Enviar specs/planos ao Orquestrador

- **Já existe** (`dispatchSpec` → 🚀): injeta no Orquestrador a ordem de `spec_read` → agrupar Tasks independentes → 1 agente por branch.
- Mudanças: rótulo explícito **"Enviar ao Orquestrador"**; funciona igual pra specs mapeadas pelo usuário (Bloco B); desabilitado se não há Orquestrador designado ou a spec está concluída/obsoleta.

---

## Bloco D — Orquestrador abre CLIs (teto + aprovação + ondas)

O Orquestrador já tem `terminal_spawn` e `terminal_spawn_on_floor`. Adicionar:

### Teto rígido (backstop no código)
- Config `maxConcurrentAgents` (default **5**, faixa 1–8) — persistida e exposta numa setting.
- `terminal_spawn` / `terminal_spawn_on_floor` (em `mcp/tools.rs`) **contam os agentes ativos** (via o `AgentRegistry`) e **recusam** acima do teto, devolvendo erro legível (`"limite de N agentes atingido — rode em ondas"`). Mesmo que o contrato seja ignorado, não estoura.

### Aprovação do usuário (no `ORCHESTRATOR_CONTRACT`)
Instrução nova: **antes de spawnar**, o Orquestrador deve:
1. Propor o plano: **quantos** agentes, **quais** papéis, em **quais floors/branches**.
2. **Perguntar** e **esperar** a confirmação do usuário ("sim" / "só 2, junta X em Y" / "usa Frontend também").
3. Só então spawnar — respeitando o teto.

Exemplo da fala esperada:
> "Pra cumprir a spec X preciso de **3 agentes**: `Backend` (floor `feat/api`), `DBA` (floor `feat/schema`), `DevOps` (floor `feat/deploy`). Confirma? Quer mudar quantidade/papéis?"

### Ondas
Se a spec precisa de mais que o teto, roda **em ondas** (spawna até o teto → espera concluir → próximos), avisando o usuário a cada onda.

---

## Bloco E — Coordenação entre agentes (blackboard)

Canais existentes: **dispatch MCP** (request/response), **pipes** (stream), **blackboard** (memória compartilhada). O blackboard é a chave pra não se atropelarem:

- **Claims**: antes de editar um arquivo, o agente posta `memory_remember("claim: editando <path> (floor <x>)")`. Antes de tocar num arquivo, **lê os claims** (`memory_recall`) e recua/pede o turno se houver claim ativo de outro.
- **Decisões compartilhadas**: convenções/decisões duráveis viram fatos (`memory_remember`), pra Spec B não reinventar o que a Spec A decidiu.
- Implementação: 90% **contrato** (instruir worker/orquestrador a postar/ler claims) + tools `memory_*` que já existem. Pouco código.

### Detecção de sobreposição (pró-ativa)
- Frontmatter opcional `paths:` (globs que a spec toca). Se duas specs **ativas** declaram paths que se cruzam, a UI/Orquestrador **avisa** antes do dispatch ("Spec A e B mexem em `src/lib/db/**` — serialize ou redesenhe o escopo").

---

## Plano de implementação (fases independentes)

1. **Ciclo de vida** (Bloco A): status no `spec.rs` + `spec_archive` + UI agrupada/filtrada. *Entrega valor sozinha.*
2. **Specs mapeáveis** (Bloco B): raízes configuráveis + Nova/Importar.
3. **Teto + aprovação** (Bloco D): config `maxConcurrentAgents` + checagem no spawn + contrato.
4. **Coordenação** (Bloco E): claims no contrato + aviso de sobreposição.

Cada fase é um PR/floor próprio. Ordem por valor: 1 → 3 → 2 → 4 (o teto/aprovação é o de maior risco de uso indevido hoje).

---

## Riscos / decisões abertas

- **Teto = 5** confirmado (configurável). Reavaliar se a máquina aguenta mais com MCPs pesados (Playwright/Serena por agente).
- **Status por checkbox** pode dar falso-"done" se o plano usa `[x]` fora de tasks — mitigar contando só checkboxes em linhas de task.
- **Claims** são cooperativos (não travam de verdade); confiam no contrato. Lock duro fica pra depois se necessário.
- **`archive/`** não some do git/disco — é arquivar, não deletar (decisão consciente: nada destrutivo).
