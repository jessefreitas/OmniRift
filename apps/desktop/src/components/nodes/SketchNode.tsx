import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Tldraw, getSnapshot, loadSnapshot, type Editor } from "tldraw";
import { Maximize2, Minimize2, Pencil, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { TLDRAW_ASSET_URLS } from "@/lib/tldraw-assets";
import type { SketchNode as SketchNodeData } from "@/types/canvas";

import "tldraw/tldraw.css";

type SketchRfNode = Node<SketchNodeData & Record<string, unknown>, "sketch">;

export function SketchNode({ id, data, selected }: NodeProps<SketchRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const saveTimer = useRef<number>(0);

  const [isFullscreen, setIsFullscreen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null); // wrapper do tldraw
  const homeRef = useRef<HTMLDivElement | null>(null); // slot no node
  const fsRef = useRef<HTMLDivElement | null>(null); // slot no overlay fullscreen

  // onMount: carrega o snapshot persistido e passa a salvar (debounced) no node.
  // Persistimos no node (não persistenceKey/IndexedDB) porque os ids mudam no
  // restore do workspace — o snapshot precisa viajar junto no WorkspaceFile.
  const handleMount = (editor: Editor) => {
    if (data.snapshot) {
      try { loadSnapshot(editor.store, JSON.parse(data.snapshot)); } catch { /* snapshot inválido */ }
    }
    const unlisten = editor.store.listen(
      () => {
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => {
          patchNode(id, { snapshot: JSON.stringify(getSnapshot(editor.store)) });
        }, 600);
      },
      { source: "user", scope: "document" },
    );
    return () => {
      window.clearTimeout(saveTimer.current);
      unlisten();
    };
  };

  // Reloca o tldraw entre o slot do node e o overlay fullscreen (move o DOM, NÃO
  // remonta → mantém o desenho). Em fullscreen ele sai do transform do React Flow,
  // então o ponteiro fica preciso (no node escalado pelo zoom ele desloca).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const target = isFullscreen ? fsRef.current : homeRef.current;
    if (target && el.parentElement !== target) target.appendChild(el);
  }, [isFullscreen]);

  // Antes do unmount, devolve o tldraw pro slot do node (senão o React quebra ao
  // remover uma subtree cujo elemento está relocado no overlay).
  useEffect(
    () => () => {
      const el = containerRef.current;
      if (el && homeRef.current && el.parentElement !== homeRef.current) {
        homeRef.current.appendChild(el);
      }
    },
    [],
  );

  // ESC sai da tela cheia.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  return (
    <>
      <div
        className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
        style={{ width: data.size?.width ?? 480, height: data.size?.height ?? 360 }}
      >
        <NodeResizer isVisible={selected} minWidth={280} minHeight={220} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
        <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
          <Pencil size={12} className="text-brand shrink-0" />
          <span className="text-xs font-medium truncate flex-1">Sketch</span>
          <button
            onClick={(e) => { e.stopPropagation(); setIsFullscreen(true); }}
            title="Tela cheia (desenhar grande, ponteiro preciso)"
            className="hover:text-text shrink-0"
          >
            <Maximize2 size={12} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
            <X size={12} />
          </button>
        </header>
        <div ref={homeRef} className="flex-1 relative">
          {/* Wrapper relocável do tldraw. nodrag/nopan/nowheel: o React Flow ignora
              os ponteiros aqui → o tldraw os recebe. */}
          <div ref={containerRef} className="nodrag nopan nowheel absolute inset-0">
            <Tldraw assetUrls={TLDRAW_ASSET_URLS} onMount={handleMount} />
          </div>
        </div>
      </div>

      {isFullscreen &&
        createPortal(
          <div className="fixed inset-0 z-[9999] bg-surface1 flex flex-col">
            <header className="flex items-center gap-2 px-4 py-2 bg-surface2 border-b border-border text-textMuted shrink-0">
              <Pencil size={14} className="text-brand" />
              <span className="text-xs font-medium flex-1">Sketch — tela cheia</span>
              <span className="text-[10px] opacity-50">ESC pra sair</span>
              <button
                onClick={() => setIsFullscreen(false)}
                title="Sair da tela cheia"
                className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
              >
                <Minimize2 size={14} />
              </button>
            </header>
            <div ref={fsRef} className="flex-1 relative" />
          </div>,
          document.body,
        )}
    </>
  );
}
