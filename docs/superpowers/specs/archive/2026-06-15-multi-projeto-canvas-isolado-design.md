# Spec — Multi-projeto com canvas isolado

- **Data:** 2026-06-15
- **Status:** Design — aguardando revisão
- **Depende de:** `canvas-store.ts` (modelo de floors), persistência (`WorkspaceFileV2` em SQLite),
  `floor_mirror` (espelho pro orquestrador MCP), `currentCwd`.
- **Origem:** decisão de produto (Jesse, 2026-06-15) — "abrir múltiplos projetos dentro do sistema",
  cada um com **canvas isolado** (abordagem "Project como container").

---

## 1. Problema e objetivo

Hoje: **1 projeto** (`currentCwd` global) → **N floors** (branches do mesmo repo) num **único canvas**.
Quero abrir **N projetos** ao mesmo tempo, **cada um com seu próprio canvas/floors** — tipo workspaces
do VS Code. Trocar de projeto troca o canvas inteiro; os PTYs/agentes de cada projeto seguem vivos.

**Sucesso quando:**
- [ ] Posso abrir 2+ projetos (pastas/repos) e alternar com 1 clique.
- [ ] Cada projeto tem **seus** floors, nodes, canvas, cwd — isolados (nada vaza entre projetos).
- [ ] Trocar de projeto **não mata** os PTYs do outro (ficam vivos em background).
- [ ] Persistência guarda todos os projetos; reabrir restaura todos.
- [ ] O orquestrador MCP opera dentro do **projeto ativo** (floors do ativo).

## 2. Modelo de dados

Hoje o store é **floor-cêntrico**:
```
{ floors: Floor[], activeFloorId, currentCwd }
```
Novo — **project como container** dos floors:
```
Project { id, name, cwd, floors: Floor[], activeFloorId }
Store   { projects: Project[], activeProjectId }
```
`currentCwd` deixa de ser global → vira `activeProject.cwd`. Toda operação de floor passa a operar
nos floors do **projeto ativo** (createFloor, switchFloor, addTerminal, add*Node, reparentNode, …).

## 3. Persistência / migração

`WorkspaceFileV2 { floors[] }` → **`WorkspaceFileV3 { projects[] }`**.
- **migrateWorkspace** ganha o passo V2→V3: floors existentes viram **um projeto "Principal"**
  (cwd = currentCwd salvo). Zero perda; reabrir um workspace antigo abre 1 projeto com os floors de hoje.
- `getWorkspaceSnapshot()` serializa `projects[]`; `restoreWorkspace()` restaura todos (remapeando
  ids 2-passadas como já faz com floors/parentId).

## 4. UI — project switcher

**Abas no topo do canvas** (acima da toolbar) OU **seção "Projetos" na sidebar** (acima de Floors).
- Cada aba/linha: nome do projeto + nº de floors + botão fechar. "+" abre folder picker → novo projeto.
- Trocar projeto = `setActiveProject(id)` → o `Canvas` renderiza os floors do ativo (os inativos
  ficam `display:none`, **mantendo os PTYs vivos** — mesmo truque que os floors usam hoje, só que no nível projeto).
- Quick Jump de projeto (ex: `Ctrl+1..9`) + entradas no Command palette ("Ir para projeto: X").

**Decisão (a confirmar):** abas no topo (mais "IDE", visível) — recomendo.

## 5. Escopo do refactor (onde dói)

- **`canvas-store.ts`**: a maior parte. Helpers `mapActiveNodes`/`mapActiveFloor` passam a resolver
  `activeProject → activeFloor`. ~todas as ações de floor/node mudam o ponto de entrada (de
  `s.floors` pra `s.projects[active].floors`). Adicionar `projects`, `activeProjectId`, `addProject`,
  `closeProject`, `setActiveProject`, `renameProject`.
- **Componentes que leem `floors`/`currentCwd`/`activeFloorId`**: `Canvas`, `Sidebar`, `FloorCanvas`,
  `OrchestratorDock`, `orchestration-client`, `useQuickJump` — passam pelo projeto ativo.
- **`floor_mirror` (MCP)**: espelha os floors do **projeto ativo** (o orquestrador já trabalha no ativo).
- **`Canvas.tsx`**: hoje mapeia `floors`; passa a mapear `activeProject.floors` (os outros projetos nem renderizam, só os floors do ativo).

## 6. Isolamento de PTY/canvas

- PTYs são globais no backend (DashMap por session_id) — **não mudam**. A isolação é no frontend:
  cada terminal node vive no floor de um projeto; trocar projeto só esconde o DOM (PTY segue).
- Cada projeto tem seu `activeFloorId` próprio (lembra onde você estava).
- Snapshots/Routines/Hooks/Memória continuam — Snapshots passam a guardar `projects[]`; Routines/Hooks
  rodam no floor ativo do projeto ativo (sem mudança de semântica).

## 7. Fases

- **1**: modelo + store (`projects[]`, ações, migração V2→V3) + persistência. Critério: 1 projeto
  "Principal" funciona idêntico ao de hoje (zero regressão); testes do store passam.
- **2**: project switcher UI (abas) + abrir/fechar/trocar projeto + folder picker.
- **3**: floor_mirror/orquestrador no projeto ativo + Quick Jump de projeto + palette.

## 8. Riscos

- **Refactor central** (o store toca tudo) → fazer em fase 1 com **migração + testes** antes de UI;
  manter o caminho "1 projeto" byte-idêntico (regression guard).
- **Persistência**: migração V2→V3 tem que ser idempotente e não perder workspaces antigos.
- **MCP/orquestrador**: garantir que o espelho reflete só o projeto ativo (senão o orquestrador
  spawna no projeto errado).

## 9. Fora de escopo (v1)

- NÃO mover floors entre projetos (cada floor nasce no seu projeto).
- NÃO um floor "compartilhado" entre projetos.
- NÃO multi-janela (é tudo numa janela, com abas).
