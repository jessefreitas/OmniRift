# Camada de Skills plugável nos agentes — Design (Fase 1)

- **Data:** 2026-06-17
- **Branch:** `feat/agent-skill-layer`
- **Codename:** OmniRift (ex-"Maestri" — identificadores de código mantêm `maestri-*`)
- **Status:** Design aprovado em brainstorming, pendente review do usuário.

## Problema

Os agentes CLI orquestrados no canvas (claude, codex, opencode, agy) nascem hoje com
persona (`--append-system-prompt` no claude; 1ª mensagem nos demais) + perfil de MCP
(`agent_mcp_config` → `--mcp-config`). **Falta um terceiro eixo: skills.**

Sem isso, todo procedimento reutilizável (convenções de commit, fluxo de report ao
orquestrador, padrões de teste, etc.) precisa ser empurrado *inline* no system prompt —
que vai em **todo turno de todo agente, pra sempre** — inchando o contexto e queimando
token. O `DEV_CONTRACT` (`agent-contract.ts`) já tem ~50 linhas sempre-ligadas e tende a
crescer.

## Objetivo (north star)

Dar a cada agente uma **camada de skills curada e própria**, de modo que **cada agente
carregue só o que é dele** → contexto mínimo → **economia máxima de tokens**. Nada é
forçado globalmente.

### Como skills economizam token (premissa que guia o design)

Skill **não** economiza sendo injetada como conteúdo. Economiza por dois mecanismos:

1. **Progressive disclosure** — num CLI com loader nativo, uma skill custa só
   `name + description` (1-2 linhas) no contexto até ser *invocada*; o corpo (milhares de
   tokens) carrega sob demanda.
2. **Tirar peso do system prompt** — mover procedimentos sempre-ligados para skills
   sob demanda, em vez de mantê-los em `--append-system-prompt`.

**Corolário (regra de ouro):** despejar a biblioteca inteira (100+ skills) em todo agente
**incha** em vez de economizar (o frontmatter de cada skill disponível fica sempre no
contexto). Por isso o binding é **curado e por-agente**.

## Decisões tomadas (brainstorming)

| Eixo | Decisão |
|------|---------|
| Cobertura de CLI | **Todos os CLIs** via adapter por provider |
| Fonte das skills | **Ambos** — núcleo nativo do Maestri + biblioteca instalada |
| Binding | **Role = default + override por-instância no spawn** — nada forçado global; cada agente pode ajustar antes de subir |
| UX do spawn | **Híbrido** — clique = spawna com default do role (1-clique atual); "Launch with…" abre picker pré-spawn (override só daquele agente) |
| Fronteira MVP (Fase 1) | **claude + codex** nativos; opencode/agy com fallback plugado, validados depois |

## Arquitetura (espelha o eixo de MCP que já existe)

| Peça | Análoga a | Responsabilidade |
|------|-----------|------------------|
| `lib/agent-skills.ts` (catálogo + bundles) | `lib/agent-roles.ts` | Lista skills disponíveis (Maestri-core + biblioteca instalada) e persiste bundles em `localStorage` (`maestri-agent-skills-v1`) |
| `AgentRoleDef.skills: string[]` | `AgentRoleDef.prompt` | Cada role declara **seu próprio** bundle (IDs de skill) |
| Picker de skills no `RoleEditModal` | editor de prompt do role | UI de seleção, reaproveitando o modal existente |
| `agent_skills_config(cli, skillIds)` (Rust, command) | `agent_mcp_config` | Materializa só essas skills no mecanismo nativo do CLI e devolve a wiring de spawn |
| adapter por CLI (dentro do command) | merge do `agent_mcp_config` | claude/codex/agy → dir nativo; CLI sem loader → índice-no-disco |

**Binding = role**, e role = persona + CLI (`role.cli`) → "skills próprias por CLI" cai de
graça, sem introduzir eixo novo de configuração.

## Componentes

### 1. Catálogo de skills (`apps/desktop/src/lib/agent-skills.ts`)

- `SkillDef { id, name, description, source: 'maestri-core' | 'library', path }`.
- **Maestri-core:** set pequeno e próprio (ver §Skills núcleo abaixo), versionado no repo.
- **Biblioteca:** skills instaladas descobertas via command backend que varre
  `~/.claude/skills`, plugins e marketplace — só metadados (name + description + path),
  nunca o corpo.
- Bundles persistem em `localStorage` chave `maestri-agent-skills-v1`. Padrão de
  merge/seed idêntico a `loadRoles()/saveRoles()` (`agent-roles.ts:117`).

### 2. Binding no role (default) + override por-instância

- `AgentRoleDef` ganha `skills?: string[]` (IDs) = **bundle default** do role. Roles builtin
  podem sugerir um set (ex.: `qa` → TDD), mas **opt-in** — nada injetado se vazio.
- `RoleEditModal` ganha uma seção "Skills" com multi-select do catálogo (edita o default).

### 2b. Spawn híbrido (picker pré-spawn)

- **Clique no role** (Sidebar.tsx:1179 → `spawnRole`): spawna **já** com o default do role —
  preserva o 1-clique atual, zero atrito.
- **"Launch with…"** (botão/⋯ ou ação secundária no item do role): abre um **picker
  pré-spawn** mostrando o CLI + as skills do role pré-marcadas + o catálogo. O usuário
  ajusta para **aquele agente só**, clica **Launch** → spawna.
- O override é **por-instância**: NÃO muta o role (não chama `saveRoles`). A lista escolhida
  vai direto pro spawn. (Futuro opcional: botão "salvar como default do role".)
- Skills são **wiring de launch** (como `--mcp-config`/persona): mudar depois = respawn. Por
  isso o picker vive **antes** do spawn; não há edição de skill de agente já vivo na Fase 1.

### 3. Command Rust `agent_skills_config(cli, skill_ids) -> SkillWiring`

Espelha `agent_mcp_config` (`commands/mcp.rs:118`):

- Cria um **dir efêmero por-agente** em `app_data_dir()/agent-skills/<token>/` e
  **symlinka** os `SKILL.md` selecionados (nunca copia o corpo pra dentro do floor —
  floor é worktree git, não pode sujar `git status`).
- Devolve `SkillWiring` discriminado por estratégia do CLI:
  - `Native { dir }` — caminho do dir de skills pro CLI descobrir.
  - `IndexPrompt { text }` — índice curto (`nome — 1 linha — caminho absoluto`) pra
    anexar à 1ª mensagem; o agente faz `cat` do corpo sob demanda.
- Bundle vazio → `None` (no-op, **zero regressão** pro fluxo atual).

### 4. Adapter por CLI

| CLI | Estratégia (MVP) | Mecanismo |
|-----|------------------|-----------|
| `claude` | Native | Dir de skills materializado no contrato de descoberta do Claude Code (**verificar §Risco**) |
| `codex` | Native | Dir de skills no formato/local do Codex |
| `agy` | Native (fase 2) | Adaptar pro mecanismo do Antigravity (`activate_skill`) |
| `opencode` | IndexPrompt (fallback) | Índice-no-disco anexado à 1ª mensagem |

### 5. Wiring no spawn

No caminho de spawn (`Sidebar.tsx`, junto de onde hoje monta `--mcp-config`,
~`Sidebar.tsx:493`): `spawnRole(r, skillIdsOverride?)` resolve os IDs
(`skillIdsOverride ?? r.skills ?? []`) → chama `agent_skills_config(cli, ids)` → compõe o
comando conforme `SkillWiring` (flag/dir pro Native; concatena no texto da 1ª mensagem pro
IndexPrompt). O clique normal passa sem override (usa o default do role); o picker passa a
lista ajustada.

## Fluxo de dados

1. (Opcional) Usuário edita o role → escolhe skills default → salva (`localStorage`).
2. Spawn:
   - **clique** no role → `spawnRole(r)` usa `r.skills` (default);
   - **"Launch with…"** → picker pré-spawn → `spawnRole(r, idsAjustados)` (override
     por-instância, não persiste no role).
3. `spawnRole` invoca `agent_skills_config(cli, ids)`.
4. Backend materializa o dir efêmero por-agente (symlinks) + devolve `SkillWiring`.
5. Spawn compõe o comando do CLI com a wiring.
6. Agente sobe: CLIs nativos veem só o **frontmatter do bundle dele** (não as 100+);
   CLI de fallback vê só o índice e lê os corpos sob demanda via `cat`.

## Garantia de economia de token (verificação do north star)

- **Nativo:** só o frontmatter do bundle próprio no contexto; corpo sob demanda.
- **Fallback:** só o índice (nome + 1 linha + caminho) na 1ª mensagem; corpo via `cat`.
- **Nada forçado globalmente** → contexto mínimo por agente.
- **Bônus (refactor separado e opcional):** mover trechos sempre-ligados do `DEV_CONTRACT`
  pra uma skill sob demanda — economia extra em todo turno de todo agente.

## Risco que o plano DEVE verificar antes de codar

Contrato exato de descoberta de skill de cada CLI: claude/codex/agy aceitam um **dir extra
de skills por invocação**, ou só leem caminho global (`~/.claude/skills`) + cwd
(`.claude/skills`)?

- Se aceitarem dir extra por invocação → "por-agente enxuto" é direto.
- Se só lerem global/cwd → "por-agente" degrada pra "troca por sessão" (materializar antes
  do spawn, limpar depois) ou usa cwd por-agente. O plano **confirma com teste real** e
  desenha em cima do que existir.

**Restrição firme:** o dir materializado vive em `app_data_dir()`, **nunca** dentro do
floor (worktree git) — não pode aparecer em `git status`.

## Tratamento de erro

- Skill referenciada mas ausente no disco → ignora aquele ID + loga warning; não derruba o
  spawn (degradação graciosa, igual `find_serena()` retornando `None`).
- `app_data_dir()` indisponível → retorna `None` (agente sobe sem skills, como hoje).
- CLI desconhecido → `None` (sem wiring).

## Testes (cultura 43/43, zero regressão)

**Rust (`commands/mcp.rs` style):**
- `agent_skills_config(claude, [ids])` → `SkillWiring::Native` com dir contendo os
  symlinks corretos.
- `agent_skills_config(codex, [ids])` → `Native` no formato do codex.
- `agent_skills_config(opencode, [ids])` → `IndexPrompt` com formato `nome — desc — path`.
- `agent_skills_config(_, [])` → `None` (**no-op / zero regressão**).
- ID ausente no disco → ignorado, sem panic.

**Frontend:**
- Picker de skills (RoleEditModal) persiste em `role.skills` (localStorage round-trip).
- `spawnRole(r)` sem override usa `r.skills`; `spawnRole(r, ids)` usa `ids` e **não** chama
  `saveRoles` (override por-instância não muta o role).
- Spawn compõe args/1ª-mensagem corretamente por estratégia de wiring.

## Fora de escopo (YAGNI / fases futuras)

- Adapter nativo de `agy` e validação real de `opencode` (Fase 2).
- Refactor do `DEV_CONTRACT` → skill (independente, opcional).
- Editor de skills dentro do OmniRift (autoria; hoje só consome o que existe no disco).
- Binding por floor/dispatch (decidido: binding é por role).

## Plano de fases

- **Fase 1 (este design):** catálogo + binding por role (default) + picker pré-spawn
  (override por-instância) + `agent_skills_config` + adapter claude/codex nativo + fallback
  IndexPrompt plugado + testes.
- **Fase 2:** adapter `agy` nativo + validação `opencode` + (talvez) refactor do contrato.
