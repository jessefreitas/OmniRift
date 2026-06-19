// src/components/SkillLaunchPicker.tsx
//
// Picker "Launch with…" — override de skills por-instância no spawn.
// NÃO persiste no role (não chama saveRoles/saveRole).
// Renderiza em portal no body.

import { useState, useEffect } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";

import { type AgentRoleDef } from "@/lib/agent-roles";
import { loadCatalog, type SkillDef } from "@/lib/agent-skills";
import { SkillCheckboxList } from "@/components/SkillCheckboxList";

interface Props {
  role: AgentRoleDef;
  /** Called with the adjusted skill IDs when user clicks Launch. */
  onLaunch: (skillIds: string[]) => void;
  onClose: () => void;
}

export function SkillLaunchPicker({ role, onLaunch, onClose }: Props) {
  const [catalog, setCatalog] = useState<SkillDef[]>([]);
  const [selected, setSelected] = useState<string[]>(role.skills ?? []);

  useEffect(() => {
    let cancelled = false;
    loadCatalog().then((cat) => {
      if (!cancelled) setCatalog(cat);
    });
    return () => { cancelled = true; };
  }, []);

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-[400px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <span className="text-sm font-medium text-text flex-1">
            Launch with… · {role.name}
          </span>
          <button onClick={onClose} className="text-textMuted hover:text-text" title="Fechar">
            <X size={16} />
          </button>
        </header>
        <div className="p-4 space-y-3">
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              CLI
            </label>
            <p className="mt-1 text-xs text-text">{role.cli ?? "claude"}</p>
          </div>
          <div>
            <label className="text-[11px] uppercase tracking-wider text-textMuted">
              Skills (override por-instância)
            </label>
            <p className="text-[10px] text-textMuted opacity-70 mb-1.5">
              Não altera o default do role.
            </p>
            <SkillCheckboxList
              catalog={catalog}
              selected={selected}
              onChange={setSelected}
            />
          </div>
        </div>
        <footer className="flex justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:bg-surface2 transition-colors"
          >
            Cancelar
          </button>
          <button
            onClick={() => { onLaunch(selected); onClose(); }}
            className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover transition-colors"
          >
            Launch
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
