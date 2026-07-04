// Kanban do projeto — acompanhamento visual com colunas do FLUXO DO PROJETO.
// Os AGENTES movem os cards via tools MCP kanban_*; o usuário acompanha e ajusta aqui.
// O Arquiteto de Pipeline semeia o backlog ao Montar. Refresh ao vivo via kanban://changed.
// Colunas customizáveis por projeto (⚙ no header); sem custom = default de 6.

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";
import {
  SquareKanban, X, Plus, Trash2, ChevronLeft, ChevronRight, Crosshair,
  Settings2, ArrowUp, ArrowDown, Flag, Play,
} from "lucide-react";

import {
  KANBAN_COLUMNS,
  kanbanList,
  kanbanCardCreate,
  kanbanCardMove,
  kanbanCardDelete,
  kanbanColumnsList,
  kanbanColumnsSave,
  onKanbanChanged,
  sprintList,
  sprintCreate,
  sprintActivate,
  sprintDelete,
  cardSetSprint,
  type KanbanCard,
  type KanbanSprint,
} from "@/lib/kanban-client";
import { useT } from "@/lib/i18n";

type ColDef = { col: string; label: string };

const DEFAULT_COLS: ColDef[] = KANBAN_COLUMNS.map((c) => ({ col: c.id, label: c.label }));

/** Slug [a-z0-9_-]{1,24} único a partir do label — pra colunas novas do editor. */
function slugifyCol(label: string, taken: Set<string>): string {
  let base = label
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24);
  if (!base) base = "col";
  let slug = base;
  let n = 2;
  while (taken.has(slug)) slug = `${base.slice(0, 21)}-${n++}`;
  return slug;
}

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
  // Colunas do fluxo do projeto: custom (labels do usuário, não traduz) ou default.
  const [columns, setColumns] = useState<ColDef[]>(DEFAULT_COLS);
  const [custom, setCustom] = useState(false);
  const [editing, setEditing] = useState(false);
  // Sprints (Fatia 1): lista + filtro atual ("all" = tudo | null = backlog do produto | id).
  const [sprints, setSprints] = useState<KanbanSprint[]>([]);
  const [sprintFilter, setSprintFilter] = useState<"all" | null | number>("all");

  const reload = useCallback(() => {
    kanbanList(project).then(setCards).catch((e) => console.warn("[kanban] list falhou:", e));
    sprintList(project).then(setSprints).catch((e) => console.warn("[kanban] sprints falhou:", e));
    kanbanColumnsList(project)
      .then((cols) => {
        const hasCustom = cols.length >= 2;
        setCustom(hasCustom);
        setColumns(hasCustom ? cols.map((c) => ({ col: c.col, label: c.label })) : DEFAULT_COLS);
      })
      .catch((e) => console.warn("[kanban] columns falhou:", e));
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
    kanbanCardCreate({ project, title, col: columns[0]?.col })
      .then(() => setNewTitle(""))
      .catch((e) => console.warn("[kanban] create falhou:", e));
  }, [newTitle, project, columns]);

  const moveCard = useCallback((card: KanbanCard, dir: -1 | 1) => {
    const order = columns.map((c) => c.col);
    const next = order[order.indexOf(card.col) + dir];
    if (!next) return;
    kanbanCardMove(card.id, next).catch((e) => console.warn("[kanban] move falhou:", e));
  }, [columns]);

  // Cria um sprint com nome auto ("Sprint N") — sem window.prompt (quebrado no WebKitGTK).
  const createSprint = useCallback(() => {
    sprintCreate({ project, name: `Sprint ${sprints.length + 1}` })
      .catch((e) => console.warn("[kanban] sprint create falhou:", e));
  }, [project, sprints.length]);

  // Filtro dos cards pelo sprint selecionado + o sprint ativo (pro botão "mover pro sprint").
  const visibleCards = cards.filter((c) =>
    sprintFilter === "all" ? true : sprintFilter === null ? c.sprintId == null : c.sprintId === sprintFilter,
  );
  const activeSprint = sprints.find((s) => s.status === "active") ?? null;

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
            onClick={() => setEditing((v) => !v)}
            className={`rounded p-1 hover:bg-white/10 ${editing ? "text-brand" : "text-textMuted hover:text-text"}`}
            title={t("kanban.editCols", "Editar colunas do projeto")}
            aria-label={t("kanban.editCols", "Editar colunas do projeto")}
          >
            <Settings2 size={15} />
          </button>
          <button
            onClick={onClose}
            className="rounded p-1 text-textMuted hover:bg-white/10 hover:text-text"
            aria-label={t("common.close", "Fechar")}
          >
            <X size={15} />
          </button>
        </div>

        {/* Barra de Sprints (Fatia 1): filtra os cards por sprint + criar/ativar/excluir. */}
        {!editing && (
          <div className="flex items-center gap-1.5 overflow-x-auto border-b border-border bg-surface1 px-4 py-1.5">
            <Flag size={13} className="shrink-0 text-brand" />
            <button
              onClick={() => setSprintFilter("all")}
              className={"shrink-0 rounded px-2 py-0.5 text-[11px] " + (sprintFilter === "all" ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text")}
            >{t("kanban.allCards", "Todos")}</button>
            <button
              onClick={() => setSprintFilter(null)}
              className={"shrink-0 rounded px-2 py-0.5 text-[11px] " + (sprintFilter === null ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text")}
            >{t("kanban.productBacklog", "Backlog do produto")}</button>
            {sprints.length > 0 && <span className="shrink-0 text-border">·</span>}
            {sprints.map((s) => (
              <div key={s.id} className="group flex shrink-0 items-center">
                <button
                  onClick={() => setSprintFilter(s.id)}
                  className={"rounded px-2 py-0.5 text-[11px] " + (sprintFilter === s.id ? "bg-brand/20 text-brand" : "text-textMuted hover:text-text")}
                  title={s.goal ?? undefined}
                >
                  {s.status === "active" ? "👑 " : ""}{s.name}
                  <span className="ml-1 text-[9px] opacity-60">{cards.filter((c) => c.sprintId === s.id).length}</span>
                </button>
                {s.status !== "active" && (
                  <button onClick={() => void sprintActivate(s.id)} className="rounded p-0.5 text-textMuted opacity-0 hover:text-brand group-hover:opacity-100" title={t("kanban.activateSprint", "Ativar este sprint")}>
                    <Play size={11} />
                  </button>
                )}
                <button onClick={() => void sprintDelete(s.id)} className="rounded p-0.5 text-textMuted opacity-0 hover:text-red-400 group-hover:opacity-100" title={t("kanban.deleteSprint", "Excluir sprint (os cards voltam ao backlog)")}>
                  <Trash2 size={11} />
                </button>
              </div>
            ))}
            <button
              onClick={createSprint}
              className="shrink-0 rounded border border-dashed border-border px-2 py-0.5 text-[11px] text-textMuted hover:border-brand hover:text-brand"
            >+ {t("kanban.newSprint", "Novo sprint")}</button>
          </div>
        )}

        {editing ? (
          <ColumnsEditor
            t={t}
            initial={columns}
            onCancel={() => setEditing(false)}
            onSave={(cols) => {
              kanbanColumnsSave(project, cols)
                .then(() => { setEditing(false); reload(); })
                .catch((e) => console.warn("[kanban] salvar colunas falhou:", e));
            }}
          />
        ) : (
        <div
          className="grid flex-1 gap-2 overflow-auto p-3"
          style={{ gridTemplateColumns: `repeat(${columns.length}, minmax(0,1fr))` }}
        >
          {visibleCards.length === 0 && (
            <p className="py-8 text-center text-xs text-textMuted" style={{ gridColumn: "1 / -1" }}>
              {t(
                "kanban.empty",
                "Nenhum card ainda. Os agentes criam e movem cards via tools kanban_* e o Arquiteto de Pipeline semeia o backlog ao Montar — ou crie o primeiro abaixo.",
              )}
            </p>
          )}
          {columns.map((col, ci) => {
            const colCards = visibleCards.filter((c) => c.col === col.col);
            return (
              <div key={col.col} className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between px-1">
                  <span className="truncate text-[11px] font-semibold text-text">
                    {custom ? col.label : t(`kanban.col.${col.col}`, col.label)}
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
                          disabled={ci === 0}
                          onClick={() => moveCard(card, -1)}
                          className="rounded p-0.5 text-textMuted hover:bg-white/10 hover:text-text disabled:pointer-events-none disabled:opacity-30"
                          title={t("kanban.moveLeft", "Mover pra coluna anterior")}
                        >
                          <ChevronLeft size={14} />
                        </button>
                        <button
                          disabled={ci === columns.length - 1}
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
                        {activeSprint && card.sprintId !== activeSprint.id && (
                          <button
                            onClick={() => void cardSetSprint(card.id, activeSprint.id).catch((e) => console.warn("[kanban] set sprint:", e))}
                            className="rounded p-0.5 text-textMuted hover:bg-white/10 hover:text-brand"
                            title={`${t("kanban.moveToSprint", "Mover pro sprint ativo")}: ${activeSprint.name}`}
                          >
                            <Flag size={14} />
                          </button>
                        )}
                        {card.sprintId != null && (
                          <button
                            onClick={() => void cardSetSprint(card.id, null).catch((e) => console.warn("[kanban] unset sprint:", e))}
                            className="rounded p-0.5 text-brand hover:bg-white/10"
                            title={t("kanban.removeFromSprint", "Tirar do sprint (volta pro backlog)")}
                          >
                            <Flag size={14} className="fill-current" />
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
                {ci === 0 && (
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
        )}
      </div>
    </div>,
    document.body,
  );
}

/** Editor inline das colunas do projeto: renomear label, reordenar ↑↓, adicionar/remover.
 *  O slug (col) é gerado do label e fica IMUTÁVEL — é a chave dos cards no banco. */
function ColumnsEditor({ t, initial, onSave, onCancel }: {
  t: (key: string, fallback?: string) => string;
  initial: ColDef[];
  onSave: (cols: ColDef[]) => void;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<ColDef[]>(() => initial.map((c) => ({ ...c })));
  const [newLabel, setNewLabel] = useState("");
  const canSave = draft.length >= 2 && draft.every((c) => c.label.trim());
  const move = (i: number, dir: -1 | 1) =>
    setDraft((d) => {
      const j = i + dir;
      if (j < 0 || j >= d.length) return d;
      const next = [...d];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  const add = () => {
    const label = newLabel.trim();
    if (!label) return;
    setDraft((d) => [...d, { col: slugifyCol(label, new Set(d.map((c) => c.col))), label }]);
    setNewLabel("");
  };
  const btn =
    "rounded p-0.5 text-textMuted hover:bg-white/10 hover:text-text disabled:pointer-events-none disabled:opacity-30";
  return (
    <div className="flex flex-1 flex-col gap-2 overflow-auto p-3">
      <p className="text-[11px] text-textMuted">
        {t(
          "kanban.colsHint",
          "Colunas do fluxo deste projeto — a ordem aqui é a ordem do board. Cards de colunas removidas ficam ocultos até o slug voltar.",
        )}
      </p>
      {draft.map((c, i) => (
        <div key={c.col} className="flex items-center gap-2 rounded-md border border-border bg-surface2 px-2 py-1.5">
          <span className="w-36 shrink-0 truncate font-mono text-[10px] text-textMuted" title={c.col}>
            {c.col}
          </span>
          <input
            value={c.label}
            onChange={(e) => setDraft((d) => d.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))}
            className="min-w-0 flex-1 rounded border border-border bg-bg px-2 py-1 text-[11px] text-text outline-none focus:border-brand"
          />
          <button disabled={i === 0} onClick={() => move(i, -1)} className={btn} title={t("kanban.colUp", "Mover pra cima")}>
            <ArrowUp size={14} />
          </button>
          <button disabled={i === draft.length - 1} onClick={() => move(i, 1)} className={btn} title={t("kanban.colDown", "Mover pra baixo")}>
            <ArrowDown size={14} />
          </button>
          <button
            disabled={draft.length <= 2}
            onClick={() => setDraft((d) => d.filter((_, j) => j !== i))}
            className="rounded p-0.5 text-textMuted hover:bg-red-500/20 hover:text-red-400 disabled:pointer-events-none disabled:opacity-30"
            title={t("kanban.colRemove", "Remover coluna (mínimo 2)")}
          >
            <Trash2 size={14} />
          </button>
        </div>
      ))}
      <div className="flex items-center gap-1.5">
        <input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") add(); }}
          placeholder={t("kanban.newCol", "nova coluna…")}
          className="w-full rounded border border-border bg-bg px-2 py-1 text-[11px] text-text outline-none focus:border-brand"
        />
        <button
          onClick={add}
          disabled={!newLabel.trim()}
          className="shrink-0 rounded p-1 text-textMuted hover:bg-brand/20 hover:text-brand disabled:pointer-events-none disabled:opacity-30"
          title={t("kanban.addCol", "Adicionar coluna")}
        >
          <Plus size={15} />
        </button>
      </div>
      <div className="mt-auto flex items-center justify-end gap-2 border-t border-border pt-2">
        <button
          onClick={onCancel}
          className="rounded border border-border px-3 py-1 text-[11px] text-textMuted hover:bg-white/10 hover:text-text"
        >
          {t("common.cancel", "Cancelar")}
        </button>
        <button
          onClick={() => canSave && onSave(draft.map((c) => ({ col: c.col, label: c.label.trim() })))}
          disabled={!canSave}
          className="rounded bg-brand px-3 py-1 text-[11px] font-semibold text-white hover:opacity-90 disabled:pointer-events-none disabled:opacity-30"
        >
          {t("kanban.saveCols", "Salvar colunas")}
        </button>
      </div>
    </div>
  );
}
