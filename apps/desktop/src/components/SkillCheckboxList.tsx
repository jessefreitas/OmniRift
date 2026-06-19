// src/components/SkillCheckboxList.tsx
//
// Componente: lista de checkboxes de skills do catálogo.
// Usado pelo SkillLaunchPicker (override de skills por-instância no spawn).
// (RoleEditModal tem sua própria lista inline, dirigida por skills_list/import.)

import type { SkillDef } from "@/lib/agent-skills";

interface Props {
  catalog: SkillDef[];
  selected: string[];
  onChange: (ids: string[]) => void;
}

export function SkillCheckboxList({ catalog, selected, onChange }: Props) {
  if (catalog.length === 0) {
    return (
      <p className="text-[11px] text-textMuted italic py-1">
        Nenhuma skill encontrada.
      </p>
    );
  }

  function toggle(id: string) {
    if (selected.includes(id)) {
      onChange(selected.filter((x) => x !== id));
    } else {
      onChange([...selected, id]);
    }
  }

  return (
    <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
      {catalog.map((skill) => (
        <label
          key={skill.id}
          className="flex items-start gap-2 px-1.5 py-1 rounded cursor-pointer hover:bg-surface2 transition-colors"
        >
          <input
            type="checkbox"
            checked={selected.includes(skill.id)}
            onChange={() => toggle(skill.id)}
            className="mt-0.5 accent-[var(--color-brand)] shrink-0"
          />
          <span className="min-w-0">
            <span className="text-xs text-text block leading-tight">{skill.name}</span>
            {skill.description && (
              <span className="text-[10px] text-textMuted block leading-tight mt-0.5">
                {skill.description}
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
