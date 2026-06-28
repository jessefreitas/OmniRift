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
import { useT } from "@/lib/i18n";

interface Cmd {
  id: string;
  label: string;
  category: string;
  run: () => void;
  disabled?: boolean;
}

export function CommandPalette() {
  const t = useT();
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
      { id: "t", label: t("palette.newTerminal", "Novo Terminal (shell)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addTerminal({ command: "bash", role: "shell", label: "shell" })) },
      { id: "note", label: t("palette.newNote", "Nova Nota"), category: t("palette.catCreate", "Criar"), run: act(() => s.addNote()) },
      { id: "group", label: t("palette.newGroup", "Novo Grupo (frame)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addGroup()) },
      { id: "ft", label: t("palette.fileTree", "Árvore de arquivos"), category: t("palette.catCreate", "Criar"), disabled: !s.currentCwd, run: act(() => { if (s.currentCwd) s.addFileTree({ rootPath: s.currentCwd }); }) },
      { id: "sk", label: t("palette.sketch", "Sketch (tldraw)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addSketch()) },
      { id: "portal", label: t("palette.portal", "Portal (browser)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addPortal()) },
      { id: "api", label: t("palette.api", "API (cliente HTTP)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addApiNode()) },
      { id: "db", label: t("palette.db", "DB (SQLite)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addDbNode()) },
      { id: "dev", label: t("palette.devtools", "DevTools (base64/JWT/hash…)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addDevToolsNode()) },
      { id: "json", label: t("palette.json", "JSON (formatar + árvore)"), category: t("palette.catCreate", "Criar"), run: act(() => s.addJsonNode()) },
      { id: "explain", label: "explainshell", category: t("palette.catCreate", "Criar"), run: act(() => s.addExplainNode()) },
    ];
    const projParallels = s.parallels.filter((f) => f.projectId === s.activeProjectId);
    const floorCmds: Cmd[] = [
      { id: "newfloor", label: t("palette.newParallel", "Novo paralelo"), category: t("palette.catParallel", "Paralelo"), run: act(() => s.createParallel(undefined, { focus: true })) },
      ...projParallels.map((f, i) => ({
        id: `floor-${f.id}`,
        label: `${t("palette.goTo", "Ir para:")} ${f.name}${i < 9 ? `  ·  Alt+${i + 1}` : ""}`,
        category: t("palette.catParallel", "Paralelo"),
        run: act(() => s.switchParallel(f.id)),
      })),
      ...s.projects.map((p) => ({
        id: `project-${p.id}`,
        label: `${t("palette.goToProject", "Ir para projeto:")} ${p.name}`,
        category: t("palette.catProject", "Projeto"),
        run: act(() => s.setActiveProject(p.id)),
      })),
    ];
    const openTool = (tool: string) =>
      act(() => window.dispatchEvent(new CustomEvent("omnirift:open-tool", { detail: tool })));
    const openCmds: Cmd[] = [
      { id: "open-routines", label: t("palette.openRoutines", "Abrir: Routines"), category: t("palette.catOpen", "Abrir"), run: openTool("routines") },
      { id: "open-snapshots", label: t("palette.openSnapshots", "Abrir: Snapshots do canvas"), category: t("palette.catOpen", "Abrir"), run: openTool("snapshots") },
      { id: "open-hooks", label: t("palette.openHooks", "Abrir: Hooks do paralelo"), category: t("palette.catOpen", "Abrir"), run: openTool("hooks") },
      { id: "open-memory", label: t("palette.openMemory", "Abrir: Memória dos agentes"), category: t("palette.catOpen", "Abrir"), run: openTool("memory") },
      { id: "open-history", label: t("palette.openHistory", "Abrir: Histórico de sessões"), category: t("palette.catOpen", "Abrir"), run: openTool("history") },
      { id: "open-connections", label: t("palette.openConnections", "Abrir: Conexões de memória"), category: t("palette.catOpen", "Abrir"), run: openTool("connections") },
      { id: "open-mobile", label: t("palette.openMobile", "Abrir: Dispositivos móveis"), category: t("palette.catOpen", "Abrir"), run: openTool("mobile") },
      { id: "open-review-ai", label: t("palette.openReviewAi", "Abrir: Code Review IA"), category: t("palette.catOpen", "Abrir"), run: openTool("review-ai") },
      { id: "open-git", label: t("palette.openGit", "Abrir: Repositórios Git"), category: t("palette.catOpen", "Abrir"), run: openTool("git") },
      { id: "open-health", label: t("palette.openHealth", "Abrir: Saúde do Projeto"), category: t("palette.catOpen", "Abrir"), disabled: !s.currentCwd, run: openTool("project-health") },
      { id: "open-turbo", label: t("palette.openTurbo", "Abrir: TURBO mode (loop autônomo)"), category: t("palette.catOpen", "Abrir"), disabled: !s.currentCwd, run: openTool("turbo") },
    ];
    return [...create, ...floorCmds, ...openCmds];
  }, [open, t]);

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
            placeholder={t("palette.searchPh", "Buscar comando… (criar node, ir pra paralelo)")}
            className="flex-1 bg-transparent text-sm text-text placeholder:text-textMuted focus:outline-none"
          />
          <kbd className="text-[10px] text-textMuted opacity-60 border border-border rounded px-1">esc</kbd>
        </div>
        <div className="max-h-[50vh] overflow-auto py-1">
          {filtered.length === 0 ? (
            <p className="px-3 py-3 text-[12px] text-textMuted opacity-60">{t("palette.empty", "Nenhum comando.")}</p>
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
