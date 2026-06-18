// src/components/EditorOpenButton.tsx
//
// Botão "Abrir no editor" com dropdown dos editores detectados. Supera o Maestri:
// detecta muitos editores (não 3) e editores de TERMINAL (nvim/vim/helix/…) abrem
// DENTRO de um terminal do canvas. Reusável: projeto, floor, arquivo.

import { useEffect, useState } from "react";
import { ChevronDown, Code2 } from "lucide-react";

import {
  detectEditors,
  openInEditor,
  loadPreferredEditor,
  savePreferredEditor,
  type EditorInfo,
} from "@/lib/editor-client";
import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

export function EditorOpenButton({ path, line }: { path: string; line?: number }) {
  const t = useT();
  const [editors, setEditors] = useState<EditorInfo[]>([]);
  const [pref, setPref] = useState<string | null>(() => loadPreferredEditor());
  const [open, setOpen] = useState(false);
  const addTerminal = useCanvasStore((s) => s.addTerminal);

  useEffect(() => { void detectEditors().then(setEditors); }, []);

  if (editors.length === 0) return null;
  const chosen = editors.find((e) => e.id === pref) ?? editors[0];

  function run(ed: EditorInfo) {
    setPref(ed.id);
    savePreferredEditor(ed.id);
    setOpen(false);
    if (ed.terminal) {
      // editor de terminal → abre num terminal do canvas (o Maestri não faz isso)
      addTerminal({ command: ed.cmd, args: [path], role: "shell", label: ed.label });
    } else {
      void openInEditor(ed.cmd, path, line);
    }
  }

  return (
    <div className="px-2 mt-1 flex items-center gap-1 text-[10px] relative">
      <button
        onClick={() => chosen && run(chosen)}
        title={`${t("editorOpen.openIn", "Abrir no")} ${chosen?.label}`}
        className="flex items-center gap-1 text-textMuted hover:text-brand transition-colors"
      >
        <Code2 size={11} /> {t("editorOpen.openIn", "Abrir no")} {chosen?.label ?? t("editorOpen.editor", "editor")}
      </button>
      <button onClick={() => setOpen((o) => !o)} title={t("editorOpen.chooseEditor", "Escolher editor")} className="text-textMuted hover:text-brand">
        <ChevronDown size={10} />
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute top-full left-2 mt-1 z-50 bg-surface1 border border-border rounded-md shadow-xl py-1 min-w-[150px] max-h-64 overflow-auto">
            {editors.map((e) => (
              <button
                key={e.id}
                onClick={() => run(e)}
                className={cn(
                  "w-full text-left px-2 py-1 text-[11px] hover:bg-surface2 transition-colors",
                  e.id === chosen?.id ? "text-brand" : "text-text",
                )}
              >
                {e.label}
                {e.terminal && <span className="text-textMuted opacity-60"> · {t("editorOpen.terminal", "terminal")}</span>}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
