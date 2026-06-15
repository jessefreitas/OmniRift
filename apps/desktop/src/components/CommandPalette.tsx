// src/components/CommandPalette.tsx
//
// Paleta de comandos (Ctrl/Cmd+K): busca difusa de ações — criar qualquer node,
// trocar de floor, criar floor. Listener em capture phase (antes do xterm). Fecha
// no Esc/clique fora. Complementa o Quick Jump (Alt+1..9) que já existe.

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Command } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";

interface Cmd {
  id: string;
  label: string;
  category: string;
  run: () => void;
  disabled?: boolean;
}

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Ctrl/Cmd+K alterna; Esc fecha. Capture: antes do xterm engolir.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === "k" || e.key === "K")) {
        e.preventDefault();
        e.stopPropagation();
        setQuery("");
        setSel(0);
        setOpen((o) => !o);
      } else if (e.key === "Escape") {
        setOpen(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, []);

  useEffect(() => {
    if (open) setTimeout(() => inputRef.current?.focus(), 0);
  }, [open]);

  const commands = useMemo<Cmd[]>(() => {
    const s = useCanvasStore.getState();
    const act = (fn: () => void): (() => void) => () => { fn(); setOpen(false); };
    const create: Cmd[] = [
      { id: "t", label: "Novo Terminal (shell)", category: "Criar", run: act(() => s.addTerminal({ command: "bash", role: "shell", label: "shell" })) },
      { id: "note", label: "Nova Nota", category: "Criar", run: act(() => s.addNote()) },
      { id: "group", label: "Novo Grupo (frame)", category: "Criar", run: act(() => s.addGroup()) },
      { id: "ft", label: "Árvore de arquivos", category: "Criar", disabled: !s.currentCwd, run: act(() => { if (s.currentCwd) s.addFileTree({ rootPath: s.currentCwd }); }) },
      { id: "sk", label: "Sketch (tldraw)", category: "Criar", run: act(() => s.addSketch()) },
      { id: "portal", label: "Portal (browser)", category: "Criar", run: act(() => s.addPortal()) },
      { id: "api", label: "API (cliente HTTP)", category: "Criar", run: act(() => s.addApiNode()) },
      { id: "db", label: "DB (SQLite)", category: "Criar", run: act(() => s.addDbNode()) },
      { id: "dev", label: "DevTools (base64/JWT/hash…)", category: "Criar", run: act(() => s.addDevToolsNode()) },
      { id: "json", label: "JSON (formatar + árvore)", category: "Criar", run: act(() => s.addJsonNode()) },
      { id: "explain", label: "explainshell", category: "Criar", run: act(() => s.addExplainNode()) },
    ];
    const projFloors = s.floors.filter((f) => f.projectId === s.activeProjectId);
    const floorCmds: Cmd[] = [
      { id: "newfloor", label: "Novo floor", category: "Floor", run: act(() => s.createFloor(undefined, { focus: true })) },
      ...projFloors.map((f, i) => ({
        id: `floor-${f.id}`,
        label: `Ir para: ${f.name}${i < 9 ? `  ·  Alt+${i + 1}` : ""}`,
        category: "Floor",
        run: act(() => s.switchFloor(f.id)),
      })),
      ...s.projects.map((p) => ({
        id: `project-${p.id}`,
        label: `Ir para projeto: ${p.name}`,
        category: "Projeto",
        run: act(() => s.setActiveProject(p.id)),
      })),
    ];
    const openTool = (tool: string) =>
      act(() => window.dispatchEvent(new CustomEvent("maestri:open-tool", { detail: tool })));
    const openCmds: Cmd[] = [
      { id: "open-routines", label: "Abrir: Routines", category: "Abrir", run: openTool("routines") },
      { id: "open-snapshots", label: "Abrir: Snapshots do canvas", category: "Abrir", run: openTool("snapshots") },
      { id: "open-hooks", label: "Abrir: Hooks do floor", category: "Abrir", run: openTool("hooks") },
      { id: "open-memory", label: "Abrir: Memória dos agentes", category: "Abrir", run: openTool("memory") },
      { id: "open-history", label: "Abrir: Histórico de sessões", category: "Abrir", run: openTool("history") },
      { id: "open-connections", label: "Abrir: Conexões de memória", category: "Abrir", run: openTool("connections") },
      { id: "open-llm", label: "Abrir: Config do LLM (review)", category: "Abrir", run: openTool("llm") },
      { id: "open-policy", label: "Abrir: Política de review", category: "Abrir", run: openTool("policy") },
    ];
    return [...create, ...floorCmds, ...openCmds];
  }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.category.toLowerCase().includes(q));
  }, [commands, query]);

  // Mantém a seleção dentro dos limites quando o filtro muda.
  useEffect(() => { setSel((s) => Math.min(s, Math.max(0, filtered.length - 1))); }, [filtered.length]);

  if (!open) return null;

  function runAt(i: number) {
    const c = filtered[i];
    if (c && !c.disabled) c.run();
  }

  function onKey(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") { e.preventDefault(); setSel((s) => Math.min(s + 1, filtered.length - 1)); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setSel((s) => Math.max(s - 1, 0)); }
    else if (e.key === "Enter") { e.preventDefault(); runAt(sel); }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-start justify-center pt-[18vh] bg-black/40" onClick={() => setOpen(false)}>
      <div
        className="w-[560px] max-w-[92vw] rounded-xl border border-border bg-surface1 shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 py-2.5 border-b border-border">
          <Command size={15} className="text-brand shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSel(0); }}
            onKeyDown={onKey}
            placeholder="Buscar comando… (criar node, ir pra floor)"
            className="flex-1 bg-transparent text-sm text-text placeholder:text-textMuted focus:outline-none"
          />
          <kbd className="text-[10px] text-textMuted opacity-60 border border-border rounded px-1">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-textMuted opacity-60">Nenhum comando.</p>
          ) : (
            filtered.map((c, i) => (
              <button
                key={c.id}
                disabled={c.disabled}
                onMouseEnter={() => setSel(i)}
                onClick={() => runAt(i)}
                className={cn(
                  "w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px]",
                  i === sel ? "bg-surface2 text-text" : "text-textMuted",
                  c.disabled && "opacity-40 cursor-not-allowed",
                )}
              >
                <span className="text-[9px] uppercase tracking-wide text-textMuted opacity-50 w-10 shrink-0">{c.category}</span>
                <span className="flex-1 truncate">{c.label}</span>
              </button>
            ))
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
