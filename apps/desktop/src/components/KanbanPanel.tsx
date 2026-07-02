// Kanban do projeto — acompanhamento visual (backlog / em andamento / review / concluído).
// Os AGENTES movem os cards via tools MCP kanban_*; o usuário acompanha e ajusta aqui.
// O Arquiteto de Pipeline semeia o backlog ao Montar. Refresh ao vivo via kanban://changed.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { SquareKanban, X, Plus, Trash2, ChevronLeft, ChevronRight, Crosshair } from "lucide-react";

import {
  KANBAN_COLUMNS,
  kanbanList,
  kanbanCardCreate,
  kanbanCardMove,
  kanbanCardDelete,
  onKanbanChanged,
  type KanbanCard,
} from "@/lib/kanban-client";
import { useT } from "@/lib/i18n";

const ORDER = KANBAN_COLUMNS.map((c) => c.id);

export function KanbanPanel({
  project,
  onClose,
  onFocusNode,
}: {
  project: string;
  onClose: () => void;
  onFocusNode?: (nodeId: string) => void;
}) {
  const t = useT();
  const [cards, setCards] = useState<KanbanCard[]>([]);
  const [newTitle, setNewTitle] = useState("");

  const reload = useCallback(() => {
    kanbanList(project).then(setCards).catch((e) => console.warn("[kanban] list falhou:", e));
  }, [project]);

  useEffect(() => {
    reload();
    let unlisten: (() => void) | undefined;
    onKanbanChanged(reload).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [reload]);

  const addCard = useCallback(() => {
    const title = newTitle.trim();
    if (!title) return;
    kanbanCardCreate({ project, title })
      .then(() => setNewTitle(""))
      .catch((e) => console.warn("[kanban] create falhou:", e));
  }, [newTitle, project]);

  const moveCard = useCallback((card: KanbanCard, dir: -1 | 1) => {
    const next = ORDER[ORDER.indexOf(card.col) + dir];
    if (!next) return;
    kanbanCardMove(card.id, next).catch((e) => console.warn("[kanban] move falhou:", e));
  }, []);

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="flex max-h-[86vh] w-[1240px] max-w-[96vw] flex-col overflow-hidden rounded-lg border border-border bg-surface1 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-3 border-b border-border bg-surface2 px-4 py-3">
          <SquareKanban size={16} className="shrink-0 text-brand" />
          <h2 className="text-sm font-semibold text-text">{t("kanban.title", "Kanban do projeto")}</h2>
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-textMuted" title={project}>
            {project}
          </span>
          <button
            onClick={onClose}
            className="rounded p-1 text-textMuted hover:bg-white/10 hover:text-text"
            aria-label={t("common.close", "Fechar")}
          >
            <X size={15} />
          </button>
        </div>

        <div className="grid flex-1 grid-cols-6 gap-2 overflow-auto p-3">
          {cards.length === 0 && (
            <p className="col-span-6 py-8 text-center text-xs text-textMuted">
              {t(
                "kanban.empty",
                "Nenhum card ainda. Os agentes criam e movem cards via tools kanban_* e o Arquiteto de Pipeline semeia o backlog ao Montar — ou crie o primeiro abaixo.",
              )}
            </p>
          )}
          {KANBAN_COLUMNS.map((col) => {
            const colCards = cards.filter((c) => c.col === col.id);
            return (
              <div key={col.id} className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between px-1">
                  <span className="truncate text-[11px] font-semibold text-text">
                    {t(`kanban.col.${col.id}`, col.label)}
                  </span>
                  <span className="text-[10px] text-textMuted">{colCards.length}</span>
                </div>
                <div className="flex flex-col gap-1.5">
                  {colCards.map((card) => (
                    <div key={card.id} className="rounded-md border border-border bg-surface2 p-2">
                      <div className="mb-1 flex items-start justify-between gap-2">
                        <h3 className="text-[12px] font-medium leading-tight text-text">{card.title}</h3>
                        {card.agent && (
                          <span className="shrink-0 rounded bg-brand/10 px-1 text-[9px] font-semibold uppercase text-brand">
                            {card.agent}
                          </span>
                        )}
                      </div>
                      {card.body && (
                        <p className="mb-1.5 line-clamp-3 whitespace-pre-wrap text-[10px] text-textMuted">{card.body}</p>
                      )}
                      <div className="flex items-center justify-end gap-0.5">
                        <button
                          disabled={card.col === ORDER[0]}
                          onClick={() => moveCard(card, -1)}
                          className="rounded p-0.5 text-textMuted hover:bg-white/10 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                          title={t("kanban.moveLeft", "Mover pra coluna anterior")}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <button
                          disabled={card.col === ORDER[ORDER.length - 1]}
                          onClick={() => moveCard(card, 1)}
                          className="rounded p-0.5 text-textMuted hover:bg-white/10 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                          title={t("kanban.moveRight", "Mover pra próxima coluna")}
                        >
                          <ChevronRight size={14} />
                        </button>
                        {card.nodeId && onFocusNode && (
                          <button
                            onClick={() => onFocusNode(card.nodeId!)}
                            className="rounded p-0.5 text-textMuted hover:bg-white/10 hover:text-brand"
                            title={t("kanban.focusNode", "Focar o nó no canvas")}
                          >
                            <Crosshair size={14} />
                          </button>
                        )}
                        <button
                          onClick={() => void kanbanCardDelete(card.id).catch((e) => console.warn("[kanban] delete falhou:", e))}
                          className="rounded p-0.5 text-textMuted hover:bg-red-500/20 hover:text-red-400"
                          title={t("kanban.delete", "Excluir card")}
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                {col.id === "backlog" && (
                  <div className="mt-1 flex items-center gap-1.5">
                    <input
                      value={newTitle}
                      onChange={(e) => setNewTitle(e.target.value)}
                      onKeyDown={(e) => { if (e.key === "Enter") addCard(); }}
                      placeholder={t("kanban.newCard", "novo card…")}
                      className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] text-text outline-none focus:border-brand"
                    />
                    <button
                      onClick={addCard}
                      disabled={!newTitle.trim()}
                      className="shrink-0 rounded p-1 text-textMuted hover:bg-brand/20 hover:text-brand disabled:pointer-events-none disabled:opacity-30"
                      title={t("kanban.add", "Adicionar card")}
                    >
                      <Plus size={15} />
                    </button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>,
    document.body,
  );
}
