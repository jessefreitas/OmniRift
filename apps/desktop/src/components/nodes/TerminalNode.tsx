import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Handle,
  NodeResizer,
  Position,
  type NodeProps,
} from "@xyflow/react";
import { Terminal as TerminalIcon, X, Maximize2, Minimize2, RefreshCw } from "lucide-react";

import { useTerminalSession } from "@/hooks/useTerminalSession";
import { useCanvasStore } from "@/store/canvas-store";
import { TerminalContextMenu } from "@/components/TerminalContextMenu";
import { StatusDot } from "@/components/StatusDot";
import { ptyWrite } from "@/lib/pty-client";
import { cn } from "@/lib/cn";
import type { TerminalNode as TerminalNodeData } from "@/types/canvas";

import "@xterm/xterm/css/xterm.css";

type TerminalRfNode = {
  id: string;
  type: "terminal";
  position: { x: number; y: number };
  data: TerminalNodeData;
};

type TerminalNodeProps = NodeProps<TerminalRfNode>;

export function TerminalNode({ id, data, selected }: TerminalNodeProps) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const renameNode = useCanvasStore((s) => s.renameNode);
  const addToClipboard = useCanvasStore((s) => s.addToClipboard);
  const termStatus = useCanvasStore((s) => s.terminalStatuses[data.session_id] ?? "idle");

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label ?? data.command);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [inViewport, setInViewport] = useState(true);

  const inputRef = useRef<HTMLInputElement>(null);
  const originalParentRef = useRef<HTMLElement | null>(null);
  const nodeWrapRef = useRef<HTMLDivElement>(null);

  const { containerRef, ready, error, fit, getSelection, reconnect } =
    useTerminalSession({
      sessionId: data.session_id,
      config: {
        command: data.command,
        cwd: data.cwd,
      },
    });

  // Fit quando o nó é redimensionado externamente
  useEffect(() => {
    const tid = window.setTimeout(fit, 50);
    return () => window.clearTimeout(tid);
  }, [data.size?.width, data.size?.height, fit]);

  // Foca o input quando entra em modo de edição
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // IntersectionObserver: esconde o canvas xterm quando o nó sai do viewport
  // (visibility:hidden preserva layout e para GPU compositing sem desmontar o xterm)
  useEffect(() => {
    const el = nodeWrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        setInViewport(visible);
        if (visible) setTimeout(fit, 50);
      },
      { rootMargin: "200px" }, // pré-carrega 200px antes de entrar
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [fit]);

  // ESC fecha o fullscreen + context menu via DOM nativo no canvas movido
  useEffect(() => {
    if (!isFullscreen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsFullscreen(false);
    }
    function handleCtxMenu(e: MouseEvent) {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
    window.addEventListener("keydown", handleKey);
    // containerRef foi movido via appendChild para fora do React tree —
    // precisa de listener DOM nativo para capturar contextmenu
    containerRef.current?.addEventListener("contextmenu", handleCtxMenu);
    return () => {
      window.removeEventListener("keydown", handleKey);
      containerRef.current?.removeEventListener("contextmenu", handleCtxMenu);
    };
  }, [isFullscreen, containerRef]);

  function commitRename() {
    const label = draft.trim() || data.command;
    renameNode(id, label);
    setDraft(label);
    setEditing(false);
  }

  // Move o elemento DOM do xterm para o container fullscreen (appendChild).
  // Não chama term.open() de novo — apenas muda o pai no DOM.
  const handleFullscreenContainer = useCallback(
    (el: HTMLDivElement | null) => {
      if (el && containerRef.current) {
        originalParentRef.current = containerRef.current.parentElement as HTMLElement;
        el.appendChild(containerRef.current);
        setTimeout(fit, 50);
      } else if (!el && containerRef.current && originalParentRef.current) {
        originalParentRef.current.appendChild(containerRef.current);
        originalParentRef.current = null;
        setTimeout(fit, 50);
      }
    },
    [containerRef, fit],
  );

  // --- Context menu handlers -------------------------------------------

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  async function handleCopy() {
    const sel = getSelection();
    if (sel) {
      try { await navigator.clipboard.writeText(sel); } catch { /* ignorar */ }
    }
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      if (text) {
        await ptyWrite(data.session_id, text);
      }
    } catch { /* ignorar */ }
  }

  async function handleCopyAndSave() {
    const sel = getSelection();
    if (sel) {
      try { await navigator.clipboard.writeText(sel); } catch { /* ignorar */ }
      addToClipboard(sel);
    }
  }

  // --- Fullscreen portal -----------------------------------------------

  const fullscreenPortal = isFullscreen
    ? createPortal(
        <div
          className="fixed inset-0 z-[9999] bg-surface1 flex flex-col"
          onContextMenu={handleContextMenu}
        >
          {/* Header fullscreen */}
          <header className="flex items-center gap-2 px-4 py-2 bg-surface2 border-b border-border text-textMuted shrink-0">
            <TerminalIcon size={14} className="text-brand shrink-0" />
            <span className="text-xs font-medium truncate flex-1">
              {data.label ?? data.command}
            </span>
            <span className="text-[10px] opacity-50 shrink-0">{data.role}</span>
            <button
              onClick={() => setIsFullscreen(false)}
              className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
              aria-label="Sair da tela cheia"
            >
              <Minimize2 size={14} />
            </button>
          </header>

          {/* Container do xterm em fullscreen */}
          <div className="relative flex-1 bg-bg">
            <div
              ref={handleFullscreenContainer}
              className="terminal absolute inset-0"
              onPointerDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  // --- Render principal -------------------------------------------------

  return (
    <>
      <div
        ref={nodeWrapRef}
        className={cn(
          "flex flex-col rounded-lg border bg-surface1 overflow-hidden shadow-lg",
          "transition-colors",
          selected ? "border-brand" : "border-border",
        )}
        style={{
          width: data.size?.width ?? 520,
          height: data.size?.height ?? 320,
        }}
      >
        <NodeResizer
          isVisible={selected}
          minWidth={320}
          minHeight={200}
          color="rgb(41 162 167)"
          handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        />

        <Handle
          type="target"
          position={Position.Left}
          className="!bg-brand !border-surface1"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-brand !border-surface1"
        />

        <header
          className={cn(
            "node-drag-handle flex items-center gap-2 px-3 py-2",
            "bg-surface2 border-b border-border text-textMuted cursor-grab",
            "active:cursor-grabbing select-none",
          )}
        >
          <TerminalIcon size={14} className="text-brand shrink-0" />
          <StatusDot status={termStatus} />

          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraft(data.label ?? data.command);
                  setEditing(false);
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-bg border border-brand rounded px-1 text-xs text-text focus:outline-none"
            />
          ) : (
            <span
              className="text-xs font-medium truncate flex-1 cursor-text"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              title="Duplo-clique para renomear"
            >
              {data.label ?? data.command}
            </span>
          )}

          <span className="text-[10px] opacity-50 truncate shrink-0">
            {data.role}
          </span>

          {/* Botão reconectar — só aparece quando o processo morreu */}
          {termStatus === "dead" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                reconnect();
              }}
              className="p-1 rounded hover:bg-bg hover:text-green-400 transition-colors"
              aria-label="Reconectar terminal"
              title="Reconectar"
            >
              <RefreshCw size={12} />
            </button>
          )}

          {/* Botão maximizar */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsFullscreen(true);
            }}
            className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
            aria-label="Tela cheia"
          >
            <Maximize2 size={12} />
          </button>

          {/* Botão fechar */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeNode(id);
            }}
            className="p-1 rounded hover:bg-bg hover:text-danger transition-colors"
            aria-label="Fechar terminal"
          >
            <X size={12} />
          </button>
        </header>

        <div
          className="relative flex-1 bg-bg"
          onContextMenu={handleContextMenu}
        >
          <div
            ref={containerRef}
            className="terminal absolute inset-0"
            style={{ visibility: inViewport ? "visible" : "hidden" }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={fit}
          />

          {!ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-textMuted text-xs pointer-events-none">
              iniciando {data.command}...
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-danger text-xs px-4 text-center pointer-events-none">
              falha ao iniciar: {error}
            </div>
          )}
        </div>
      </div>

      {/* Portal fullscreen */}
      {fullscreenPortal}

      {/* Context menu customizado */}
      {contextMenu && (
        <TerminalContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onCopyAndSave={handleCopyAndSave}
          onFullscreen={() => setIsFullscreen(true)}
          onCloseTerminal={() => removeNode(id)}
        />
      )}
    </>
  );
}
