// src/components/NodeComment.tsx
//
// Rodapé de comentário/anotação reutilizável por nós do canvas (JSON, Preview de
// código, etc.). Colapsável; persiste via onChange (campo `comment` do nó).

import { useState } from "react";
import { ChevronDown, ChevronRight, MessageSquare } from "lucide-react";

import { cn } from "@/lib/cn";

export function NodeComment({ value, onChange }: { value?: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(!!value);
  const has = !!value?.trim();

  return (
    <div className="shrink-0 border-t border-border nodrag">
      <button
        onClick={(e) => { e.stopPropagation(); setOpen((o) => !o); }}
        onPointerDown={(e) => e.stopPropagation()}
        className={cn(
          "w-full flex items-center gap-1.5 px-2 py-1 text-[10px]",
          has ? "text-brand" : "text-textMuted hover:text-text",
        )}
      >
        <MessageSquare size={11} className="shrink-0" />
        Comentário
        {has && !open && <span className="opacity-60 truncate font-normal">— {value}</span>}
        <span className="flex-1" />
        {open ? <ChevronDown size={10} /> : <ChevronRight size={10} />}
      </button>
      {open && (
        <textarea
          value={value ?? ""}
          onChange={(e) => onChange(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="anotação sobre este nó…"
          rows={3}
          className="nowheel w-full px-2 py-1.5 text-[11px] bg-bg text-text resize-none focus:outline-none border-t border-border placeholder:text-textMuted"
        />
      )}
    </div>
  );
}
