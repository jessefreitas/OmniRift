# Spec — Orquestração paralela dirigida por spec sobre floors-branch git

- **Data:** 2026-06-14
- **Status:** Aprovado (decisões travadas) — execução fase a fase com checkpoint
- **Estende:** [B — Orquestração](2026-06-12-herdr-orchestration-api-design.md) e
  [C — Floors](2026-06-12-herdr-floors-design.md). A spec C adiou explicitamente
  "git backing" e "pipes cross-floor" pro fora-do-v1; esta spec retoma os dois.
- **Motivação:** o teardown do Maestri (`docs/reverse-engineering/2026-06-14-...`)
  revelou que **floor = branch git** (`branchInUseByFloor`). Os três pedidos do
  usuário (floors-git, spec→agentes paralelos, orquestrador cross-floor) são **uma
  capacidade só**.

## 1. Visão

> O orquestrador (fixado, cross-floor) lê uma spec, decompõe em pedaços
> independentes e, pra cada pedaço, cria um **Floor = branch git + worktree** com
> um agente trabalhando isolado. Os agentes rodam em paralelo **sem conflito de
> arquivo** (cada um na sua branch). O orquestrador monitora todos os floors e faz
> **Land** de cada branch quando a tarefa verifica.

O `git worktree` é o que torna o paralelismo seguro — é o porquê dos floors=branches.

## 2. Decisões (travadas)

| Decisão | Escolha |
|---|---|
| Local dos worktrees | **Irmão do repo**: `<repo_parent>/.maestri-worktrees/<repo_name>/<branch>/` |
| Decomposição de spec | **Híbrida**: parser corta `### Task N`; orquestrador agrupa os dependentes |
| Sequência de build | **Fase a fase + checkpoint** (A → valida → B → valida → C) |
| Presença do orquestrador | Node **pinned** (renderiza em todos os floors) |
| Backend git | **Shell-out** pro `git` (sem dep nova; worktree+merge robustos) |

## 3. Fase A — Floors = worktrees git

**Modelo** — `Floor` ganha campos git opcionais (floors não-git ficam sem):
```ts
interface Floor {
  id; name; cwd; nodes; edges;          // como hoje
  branch?: string;        // branch git do floor
  worktreePath?: string;  // = cwd quando git-backed
  baseBranch?: string;    // branch de onde saiu (pra land)
  repoRoot?: string;      // raiz do repo principal
}
```

**Rust `src-tauri/src/git/mod.rs`** (shell-out, funções puras testáveis):
- `repo_root(cwd)`, `current_branch(cwd)`
- `sanitize_branch(b)` (puro), `worktree_path(root, branch)` (puro)
- `worktree_add(repo, branch, base?)` → cria branch+worktree (ou reusa branch existente)
- `worktree_remove(repo, path, branch?)`
- `land(repo, branch, into, worktree)` → checkout into → merge --no-ff → remove worktree → branch -D
- `parse_status(porcelain_v2)` (puro) + `status(cwd)` → `{branch, ahead, behind, dirty}`

**Comandos Tauri `commands/git.rs`:** `git_repo_info`, `floor_git_create`,
`floor_git_status`, `floor_git_land`, `floor_git_remove`.

**Frontend:** `lib/git-client.ts` (wrappers); `canvas-store.createFloor` aceita
campos git; Sidebar — botão "+ branch" cria floor git-backed, badge de branch +
status (ahead/dirty), ação **Land**.

**Testes:** unit Rust nas funções puras (`sanitize_branch`, `worktree_path`,
`parse_status`); smoke: criar floor-branch → worktree existe no disco → terminal
nasce no worktree → Land faz merge e remove worktree.

## 4. Fase B — Orquestrador cross-floor

- `AgentEntry` ganha `floor_id` → registry **floor-aware**; `mcp_register_agent`
  recebe o floor; `terminal_list` agrupa por floor.
- `CanvasNode.pinned?: boolean` → node renderiza em **todos** os `FloorCanvas`
  (o orquestrador é pinned). PTYs já sobrevivem (render-all-hide) — falta só a
  visibilidade global e o registry saber o floor de cada agente.
- Tool `agent_spawn_on_floor { floor: name|"new", branch?, command, label, role, task }`
  → cria floor (git, via Fase A) e spawna o agente já com a tarefa.

## 5. Fase C — Spec → agentes paralelos

- Tools MCP: `spec_list` (lista `docs/superpowers/specs/*` e `plans/*`),
  `spec_read { path }`, `spec_dispatch { path }`.
- Parser de Tasks (`### Task N` / `## Task`) → lista de chunks (determinístico).
- Fluxo `spec_dispatch`: parser corta Tasks → orquestrador agrupa independentes →
  pra cada grupo: `agent_spawn_on_floor` (1 floor-branch) com o chunk como tarefa →
  monitora estados (detector A) → **Land** quando done+verificado.
- Frontend: painel "Specs" (lista + botão "Dispatch paralelo").

## 6. Fora de escopo (YAGNI)
- Merge automático com resolução de conflito (Land falha → usuário resolve no floor).
- Sync de worktrees órfãos (limpeza manual via `git worktree prune` documentada).
- Pipes cross-floor visuais (a comunicação é via MCP/registry, não aresta).
