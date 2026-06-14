// src/components/CanvasToolbar.tsx
//
// Barra flutuante no topo do canvas pra criar nodes (Fase 4). Cada botão chama
// um criador do store; o node nasce numa posição default e o usuário arrasta.

import type { LucideIcon } from "lucide-react";
import { FolderTree, Frame, Globe, Pencil, StickyNote, TerminalSquare } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { Tooltip } from "@/components/Tooltip";

function ToolBtn({
  label,
  icon: Icon,
  onClick,
  disabled,
}: {
  label: string;
  icon: LucideIcon;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <Tooltip label={label} side="bottom">
      <button
        onClick={onClick}
        disabled={disabled}
        className="p-1.5 rounded-lg text-textMuted hover:text-brand hover:bg-surface1 transition-colors disabled:opacity-30 disabled:cursor-not-allowed disabled:hover:text-textMuted disabled:hover:bg-transparent"
      >
        <Icon size={16} />
      </button>
    </Tooltip>
  );
}

export function CanvasToolbar() {
  const addTerminal = useCanvasStore((s) => s.addTerminal);
  const addNote = useCanvasStore((s) => s.addNote);
  const addGroup = useCanvasStore((s) => s.addGroup);
  const addFileTree = useCanvasStore((s) => s.addFileTree);
  const addSketch = useCanvasStore((s) => s.addSketch);
  const addPortal = useCanvasStore((s) => s.addPortal);
  const currentCwd = useCanvasStore((s) => s.currentCwd);

  return (
    <div className="absolute top-3 left-1/2 -translate-x-1/2 z-30 flex items-center gap-0.5 px-1.5 py-1 rounded-xl bg-surface2/90 backdrop-blur border border-border shadow-lg">
      <ToolBtn
        label="Terminal (shell)"
        icon={TerminalSquare}
        onClick={() => addTerminal({ command: "bash", role: "shell", label: "shell" })}
      />
      <ToolBtn label="Nota" icon={StickyNote} onClick={() => addNote()} />
      <ToolBtn label="Grupo (frame)" icon={Frame} onClick={() => addGroup()} />
      <ToolBtn
        label={currentCwd ? "Árvore de arquivos do projeto" : "Abra um projeto primeiro"}
        icon={FolderTree}
        disabled={!currentCwd}
        onClick={() => currentCwd && addFileTree({ rootPath: currentCwd })}
      />
      <ToolBtn label="Sketch (tldraw)" icon={Pencil} onClick={() => addSketch()} />
      <ToolBtn label="Portal (browser)" icon={Globe} onClick={() => addPortal()} />
    </div>
  );
}
