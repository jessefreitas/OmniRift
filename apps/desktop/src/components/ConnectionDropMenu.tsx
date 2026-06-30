// src/components/ConnectionDropMenu.tsx
//
// Menu que aparece ao puxar uma linha e SOLTAR NO VAZIO (FloorCanvas onConnectEnd).
// Lista os AGENTES (catálogo de CLIs) e os ROLES (personas) — ao escolher, o Sidebar
// cria o nó na posição do drop e já conecta a origem→novo. Portalizado em document.body
// (escapa do transform do canvas), posicionado no cursor com clamp pra caber na tela.

import { useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { Bot, Search } from "lucide-react";
import { useT } from "@/lib/i18n";

export interface DropMenuItem {
  /** id único dentro do grupo (presetId ou roleId). */
  id: string;
  label: string;
  hint?: string;
  group: "agent" | "role";
  icon?: ComponentType<{ size?: number; className?: string }>;
}

const W = 260;
const MAXH = 360;

export function ConnectionDropMenu({
  x,
  y,
  items,
  mode = "team",
  onPick,
  onClose,
}: {
  x: number;
  y: number;
  items: DropMenuItem[];
  /** "subagent" = plugar subagente privado (só roles); "team" = conectar par/equipe. */
  mode?: "team" | "subagent";
  onPick: (item: DropMenuItem) => void;
  onClose: () => void;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement>(null);
  const [q, setQ] = useState("");

  // ESC fecha; clique fora fecha.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as globalThis.Node)) onClose();
    };
    window.addEventListener("keydown", onKey);
    // mousedown no próximo tick pra não pegar o clique que abriu o menu
    const id = window.setTimeout(() => window.addEventListener("mousedown", onDown), 0);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("mousedown", onDown);
      window.clearTimeout(id);
    };
  }, [onClose]);

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    if (!needle) return items;
    return items.filter((it) => it.label.toLowerCase().includes(needle) || it.hint?.toLowerCase().includes(needle));
  }, [items, q]);

  const agents = filtered.filter((it) => it.group === "agent");
  const roles = filtered.filter((it) => it.group === "role");

  // Clamp pra caber na viewport.
  const left = Math.min(x, window.innerWidth - W - 8);
  const top = Math.min(y, window.innerHeight - MAXH - 8);

  const Section = ({ title, list }: { title: string; list: DropMenuItem[] }) =>
    list.length === 0 ? null : (
      <div>
        <div className="px-2 pt-1.5 pb-0.5 text-[9px] font-semibold uppercase tracking-wide text-textMuted/70">{title}</div>
        {list.map((it) => {
          const Icon = it.icon ?? Bot;
          return (
            <button
              key={`${it.group}:${it.id}`}
              onClick={() => onPick(it)}
              title={it.hint}
              className="group flex w-full items-start gap-2 px-2 py-1.5 text-left hover:bg-surface2 transition-colors"
            >
              <Icon size={14} className="mt-0.5 shrink-0 text-textMuted group-hover:text-brand" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-text">{it.label}</span>
                {it.hint && <span className="block truncate text-[10px] text-textMuted">{it.hint}</span>}
              </span>
            </button>
          );
        })}
      </div>
    );

  return createPortal(
    <div
      ref={ref}
      className="fixed z-[70] flex flex-col rounded-lg border border-border bg-bg shadow-2xl"
      style={{ left, top, width: W, maxHeight: MAXH }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {mode === "subagent" && (
        <div className="border-b border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-[10px] leading-snug text-amber-300/90">
          {t("connectMenu.subagentBanner", "Plugar SUBAGENTE — privado deste agente (.claude/agents), não entra no time MCP.")}
        </div>
      )}
      <div className="flex items-center gap-1.5 border-b border-border px-2 py-1.5">
        <Search size={12} className="shrink-0 text-textMuted" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={
            mode === "subagent"
              ? t("connectMenu.searchRole", "Escolha a função do subagente…")
              : t("connectMenu.search", "Conectar a um agente ou role…")
          }
          className="w-full bg-transparent text-xs text-text outline-none placeholder:text-textMuted"
        />
      </div>
      <div className="overflow-y-auto py-1">
        <Section title={t("connectMenu.agents", "Agentes")} list={agents} />
        <Section title={t("connectMenu.roles", "Roles")} list={roles} />
        {filtered.length === 0 && (
          <div className="px-2 py-3 text-center text-[11px] text-textMuted">{t("connectMenu.empty", "Nada encontrado.")}</div>
        )}
      </div>
    </div>,
    document.body,
  );
}
