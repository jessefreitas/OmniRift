# Spec — Floors / Workspaces (herdr → maestri, Sub-projeto C)

- **Data:** 2026-06-12
- **Status:** Aprovado (escopo: "Floors v1 com render-all-hide") — aguardando revisão do spec
- **Depende de:** A e B (orquestração). Reaproveita o padrão de evento+listener do `terminal_spawn`.
- **Roadmap:** materializa a **Fase 6 (Floors)** do CLAUDE.md do projeto.

---

## 0. Decisão de escopo (já tomada)

C = **Floors**: múltiplos canvases nomeados em sessão, com troca entre eles e persistência. Mapeamento herdr → maestri:

| herdr | maestri | |
|---|---|---|
| **Workspace** (contexto por repo) | **Floor** (canvas nomeado) | ✅ alvo de C |
| **Tab** (subcontexto) | — | ⛔ não porta (canvas espacial não tem abas) |
| **Pane** | Node | ✅ já existe |

Estratégia de PTY ao trocar de floor: **render-all-hide-inactive** — cada floor é um `ReactFlow` próprio; os inativos ficam em `display:none` (mantêm os `TerminalNode`/xterm montados → PTYs vivos), sem detach/reattach. Otimização de memória e reattach real ficam fora do v1.

## 1. Problema

Hoje o maestri tem **um** workspace só: `canvas-store` mantém um único `nodes`/`edges` + `workspaceName`/`currentCwd`, e `Sidebar` salva/abre **um** `WorkspaceFile` em disco. Não dá pra ter vários canvases (ex.: "infra", "frontend", "pesquisa") vivos ao mesmo tempo e alternar entre eles — que é exatamente o organizador do herdr (Workspace).

## 2. Objetivo e sucesso

- [ ] Múltiplos floors em sessão, cada um com seus `nodes`/`edges`/`cwd`.
- [ ] Switcher na Sidebar: criar, renomear, trocar, excluir floor.
- [ ] Trocar de floor **mantém os PTYs do floor anterior vivos** (volta e o terminal continua de onde estava).
- [ ] Persistência multi-floor (`WorkspaceFile` v2), com **migração** automática de v1.
- [ ] Tools MCP `workspace_create/focus/rename/close/list` para o Orquestrador operar floors.

## 3. Modelo de dados

```ts
// types/workspace.ts
export interface Floor {
  id: string;
  name: string;
  cwd: string | null;
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

export interface WorkspaceFileV2 {
  version: 2;
  name: string;            // nome do projeto/arquivo
  floors: Floor[];
  activeFloorId: string;
}
// WorkspaceFile (v1) permanece para leitura/migração.
```

## 4. Store (`canvas-store.ts`)

Substitui o `nodes`/`edges`/`currentCwd`/`workspaceName` planos por um modelo de floors:

```ts
floors: Floor[];
activeFloorId: string;
workspaceName: string;     // nome do projeto (continua)
```

- **Acessores ativos** (selectors): `activeFloor()` → `floors.find(activeFloorId)`. Componentes legados que liam `s.nodes` passam a usar `useActiveFloor()` (selector que devolve `activeFloor().nodes`).
- **Ops de nó/aresta agem no floor ativo** (mantêm assinatura): `addTerminal`, `removeNode`, `renameNode`, `updateNodePosition`, `updateNodeSize`, `patchNode`, `addEdge`, `removeEdge` — internamente `floors.map(f => f.id === activeFloorId ? { ...f, nodes/edges: ... } : f)`. (Só o floor ativo é interativo, então ops mirando o ativo é suficiente.)
- **`addTerminal` com `id?`** (de B) continua; o nó vai pro floor ativo. **Importante:** o `terminal_spawn` (B) deve criar o terminal no floor ativo — comportamento já correto, pois `addTerminal` mira o ativo.
- **Gerência de floors (nova):**
  - `createFloor(name?) -> Floor` (gera id, floor vazio, **não** troca foco por padrão; aceita flag).
  - `switchFloor(id)`.
  - `renameFloor(id, name)`.
  - `deleteFloor(id)` — bloqueia excluir o último floor; se excluir o ativo, foca outro.
  - `setActiveFloorCwd(cwd)` (substitui `setCurrentCwd`, agindo no ativo).
- **Selector p/ agentes globais:** `allTerminalNodes()` = `floors.flatMap(f => f.nodes.filter(terminal))` — a Sidebar (MCP Agents) lista terminais de **todos** os floors.
- **Persistência:** `getWorkspaceSnapshot()` → `WorkspaceFileV2`. `restoreWorkspace(ws)` aceita v1 (embrulha o único `nodes/edges` num floor "Principal") **e** v2.

## 5. Canvas multi-floor

- **`FloorCanvas.tsx` (novo):** recebe a lógica atual de `Canvas.tsx` (o `ReactFlow` + handlers), parametrizada por `floorId`. Lê `getFloor(floorId).nodes/edges`; as ops chamam as do store (que miram o ativo). Só o floor ativo recebe interação.
- **`Canvas.tsx` (refactor → container):** renderiza um `FloorCanvas` por floor:
  ```tsx
  {floors.map((f) => (
    <div key={f.id} style={{ position: "absolute", inset: 0, display: f.id === activeFloorId ? "block" : "none" }}>
      <FloorCanvas floorId={f.id} />
    </div>
  ))}
  ```
  `display:none` mantém os `TerminalNode`/xterm montados (PTYs vivos), sem renderizar visualmente.
- Edges/pipes seguem por floor (uma pipe conecta dois nós do mesmo floor; cross-floor fica fora do v1).

## 6. Sidebar — floor switcher

Nova seção "Floors" (acima de "Workspace"): lista os floors (nome + nº de nós), botão de **+ novo**, clique pra **trocar** (highlight no ativo), duplo-clique/ícone pra **renomear**, ícone pra **excluir** (desabilitado no último). O seletor de pasta ("Projeto") passa a agir no `cwd` do floor ativo. Save/Abrir continuam, mas agora serializam **todos** os floors (v2).

## 7. MCP — tools `workspace_*` (orquestração de floors)

Floors vivem no store do frontend. Padrão: **evento fire-and-forget** (como `terminal_spawn`) + um **espelho** leve no backend para o `list`.

- Backend ganha um `FloorMirror` (`Arc<Mutex<Value>>`) em `McpState`. Um comando Tauri `floor_mirror_set(json)` é chamado pelo frontend a cada mudança de floors → atualiza o espelho.
- Tools:
  - `workspace_list` → lê o `FloorMirror` (lista `id`/`name`/nº nós + qual ativo).
  - `workspace_create { name }` → emite `canvas://floor-create { name }`; o front cria e atualiza o espelho.
  - `workspace_focus { id | name }` → emite `canvas://floor-focus { target }`.
  - `workspace_rename { id, name }` → emite `canvas://floor-rename`.
  - `workspace_close { id }` → emite `canvas://floor-close`.
- `orchestration-client.ts` ganha listeners pra esses 4 eventos → chamam as ops do store + `floor_mirror_set`.

## 8. Arquivos

**Criar:** `apps/desktop/src/components/FloorCanvas.tsx`.
**Modificar:**
- `apps/desktop/src/types/workspace.ts` — `Floor`, `WorkspaceFileV2`.
- `apps/desktop/src/store/canvas-store.ts` — modelo de floors + ops + selectors + persistência.
- `apps/desktop/src/components/Canvas.tsx` — vira container multi-floor.
- `apps/desktop/src/components/Sidebar.tsx` — switcher de floors; `allTerminalNodes()`; cwd por floor.
- `apps/desktop/src/lib/workspace-client.ts` — tipos v2 (save/load já são genéricos).
- `apps/desktop/src/lib/orchestration-client.ts` — listeners de `canvas://floor-*` + `floor_mirror_set`.
- `apps/desktop/src/lib/mcp-client.ts` — `floorMirrorSet(json)`.
- `apps/desktop/src-tauri/src/commands/mcp.rs` — comando `floor_mirror_set`.
- `apps/desktop/src-tauri/src/mcp/server.rs` — `McpState.floor_mirror`; `mcp_router` recebe o mirror (ou cria internamente + expõe via state Tauri compartilhado).
- `apps/desktop/src-tauri/src/mcp/tools.rs` — `workspace_*` em `terminal_tool_defs`/`terminal_dispatch` (ou um `workspace_dispatch` irmão).
- `apps/desktop/src-tauri/src/lib.rs` — registrar `floor_mirror_set`; compartilhar o `FloorMirror` entre Tauri state e MCP.

## 9. Testes

- **Store (lógica pura):** extrair as transições de floor puras onde possível — `migrateWorkspace(v1|v2) -> WorkspaceFileV2` (migração v1→v2 e passthrough v2); `deleteFloor` não remove o último. Testar via vitest? **Não há runner** (ver A) → as funções puras de migração podem ir num módulo testável por `tsc`/inspeção; sem runner, validação por smoke + typecheck.
- **Rust:** `workspace_*` matcher de `id|name` (pura) testável com `cargo test`.
- **Smoke:** criar 2 floors, abrir terminais em cada, trocar → o do floor anterior continua vivo (output preservado); salvar/abrir preserva os floors; `workspace_create`/`focus` pelo Orquestrador refletem no canvas.

## 10. Fora de escopo (YAGNI para C)

- Camada **Tab** do herdr (não porta).
- **Detach/reattach real** / virtualização de memória (render-all-hide basta no v1).
- **Pipes cross-floor**.
- Migração de nós entre floors (drag de um floor pro outro).
- Routines (a outra metade da Fase 6).

## 11. Riscos

- **Maior refactor dos três** (toca store + Canvas + Sidebar). Sequenciar: store → FloorCanvas/Canvas → Sidebar → persistência → MCP. Cada etapa com app funcional.
- **Memória:** N floors × xterms montados. Aceitável no v1; documentar como limitação.
- **`floor_mirror` compartilhado** entre Tauri state e MCP server: garantir o mesmo `Arc` (como já é feito com `PtyManager`/`AgentRegistry` no `lib.rs`).
- Componentes legados que leem `s.nodes` direto (Canvas, Sidebar) **vão quebrar** até migrarem pro selector de floor ativo — fazer a migração do store + consumidores na MESMA etapa (atômico, como foi o `"busy"`→`AgentState` no A).
