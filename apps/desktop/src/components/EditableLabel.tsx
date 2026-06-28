// src/components/EditableLabel.tsx
//
// Rótulo editável inline: double-click vira <input> (Enter/blur confirma, Esc
// cancela). Substitui window.prompt() — que NÃO funciona no WebKitGTK/Linux —
// para renomear abas de projeto e paralelos (floors).

import { useEffect, useRef, useState } from "react";
import { SafeInput } from "@/components/SafeInput";
import type { KeyboardEvent, MouseEvent } from "react";
import { cn } from "@/lib/cn";

interface EditableLabelProps {
  value: string;
  onCommit: (next: string) => void;
  /** classes do <span> no modo leitura */
  className?: string;
  /** classes do <input> no modo edição */
  inputClassName?: string;
  title?: string;
  maxLength?: number;
}

export function EditableLabel({
  value,
  onCommit,
  className,
  inputClassName,
  title,
  maxLength,
}: EditableLabelProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);
  // Evita commit duplicado: Enter chama commit() e o blur que vem do unmount
  // dispararia de novo. Resetado ao (re)entrar em edição.
  const doneRef = useRef(false);

  useEffect(() => {
    if (editing && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [editing]);

  function enterEdit(e: MouseEvent<HTMLSpanElement>) {
    e.stopPropagation();
    setDraft(value);
    doneRef.current = false;
    setEditing(true);
  }

  function commit() {
    if (doneRef.current) return;
    doneRef.current = true;
    const n = draft.trim();
    if (n !== "" && n !== value) onCommit(n);
    setEditing(false);
  }

  function cancel() {
    doneRef.current = true;
    setEditing(false);
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter") {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      cancel();
    }
  }

  // Impede que cliques no input borbulhem pro container (switchFloor/setActiveProject).
  function stop(e: MouseEvent<HTMLInputElement>) {
    e.stopPropagation();
  }

  if (editing) {
    return (
      <SafeInput
        ref={inputRef}
        type="text"
        value={draft}
        maxLength={maxLength}
        className={cn("bg-bg text-text border border-border rounded px-1 outline-none", inputClassName)}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={onKeyDown}
        onClick={stop}
        onDoubleClick={stop}
        onMouseDown={stop}
      />
    );
  }

  return (
    <span className={className} title={title} onDoubleClick={enterEdit}>
      {value}
    </span>
  );
}
