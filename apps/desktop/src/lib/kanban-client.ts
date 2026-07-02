// Client do Kanban do projeto: comandos Tauri (CRUD de cards) + evento de refresh.
// Os AGENTES mexem nos cards via tools MCP kanban_* (mcp/tools.rs); o painel e este
// client são o lado do USUÁRIO. Toda mutação (de qualquer lado) emite kanban://changed.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";

export type KanbanColumn = "backlog" | "doing" | "test" | "review" | "blocked" | "done";

// Fluxo profissional (estilo Jira). "blocked" cobre bugs/impedimentos — o card
// para ali até destravar; colunas customizáveis por projeto são a próxima fatia.
export const KANBAN_COLUMNS: { id: KanbanColumn; label: string }[] = [
  { id: "backlog", label: "Backlog" },
  { id: "doing", label: "Em andamento" },
  { id: "test", label: "Teste" },
  { id: "review", label: "Review" },
  { id: "blocked", label: "Bloqueado" },
  { id: "done", label: "Concluído" },
];

export interface KanbanCard {
  id: number;
  project: string;
  col: KanbanColumn;
  title: string;
  body: string | null;
  agent: string | null;
  nodeId: string | null;
  position: number;
  createdAt: string;
  updatedAt: string;
}

export function kanbanList(project: string): Promise<KanbanCard[]> {
  return invoke("kanban_query", { project });
}

export function kanbanCardCreate(p: {
  project: string;
  title: string;
  col?: KanbanColumn;
  body?: string;
  agent?: string;
  nodeId?: string;
}): Promise<number> {
  return invoke("kanban_card_create", {
    project: p.project,
    col: p.col ?? null,
    title: p.title,
    body: p.body ?? null,
    agent: p.agent ?? null,
    nodeId: p.nodeId ?? null,
  });
}

export function kanbanCardMove(id: number, col: KanbanColumn): Promise<void> {
  return invoke("kanban_card_move", { id, col });
}

export function kanbanCardUpdate(p: { id: number; title?: string; body?: string; agent?: string }): Promise<void> {
  return invoke("kanban_card_update", {
    id: p.id,
    title: p.title ?? null,
    body: p.body ?? null,
    agent: p.agent ?? null,
  });
}

export function kanbanCardDelete(id: number): Promise<void> {
  return invoke("kanban_card_delete", { id });
}

export function onKanbanChanged(cb: () => void): Promise<UnlistenFn> {
  return listen("kanban://changed", () => cb());
}
