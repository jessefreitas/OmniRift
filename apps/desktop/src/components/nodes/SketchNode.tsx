import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Tldraw, getSnapshot, loadSnapshot, type Editor } from "tldraw";
import { Download, Maximize2, Minimize2, Pencil, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { TLDRAW_ASSET_URLS } from "@/lib/tldraw-assets";
import type { SketchNode as SketchNodeData } from "@/types/canvas";

import "tldraw/tldraw.css";

type SketchRfNode = Node<SketchNodeData & Record<string, unknown>, "sketch">;

export function SketchNode({ id, data, selected }: NodeProps<SketchRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const saveTimer = useRef<number>(0);
  // Snapshot mais recente (atualizado a CADA edição). É daqui que o tldraw carrega
  // ao montar — assim alternar node↔fullscreen (que remonta o tldraw) não perde nada.
  const latestRef = useRef<string | undefined>(data.snapshot);
  const editorRef = useRef<Editor | null>(null);

  const [isFullscreen, setIsFullscreen] = useState(false);

  const handleMount = (editor: Editor) => {
    editorRef.current = editor;
    if (latestRef.current) {
      try { loadSnapshot(editor.store, JSON.parse(latestRef.current)); } catch { /* snapshot inválido */ }
    }
    const unlisten = editor.store.listen(
      () => {
        const snap = JSON.stringify(getSnapshot(editor.store));
        latestRef.current = snap; // imediato (pra sobreviver à troca de fullscreen)
        window.clearTimeout(saveTimer.current);
        saveTimer.current = window.setTimeout(() => patchNode(id, { snapshot: snap }), 600); // persiste debounced
      },
      { source: "user", scope: "document" },
    );
    return () => {
      window.clearTimeout(saveTimer.current);
      unlisten();
    };
  };

  // Exporta o desenho como PNG (download). Vazio = nada a exportar.
  async function exportPng() {
    const editor = editorRef.current;
    if (!editor) return;
    const ids = [...editor.getCurrentPageShapeIds()];
    if (ids.length === 0) return;
    try {
      const { blob } = await editor.toImage(ids, { format: "png", background: true });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `sketch-${id}.png`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      console.error("[sketch] export PNG falhou:", e);
    }
  }

  // ESC sai da tela cheia.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setIsFullscreen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  // nodrag/nopan/nowheel: o React Flow ignora os ponteiros aqui → tldraw os recebe.
  // Renderizado no node OU no overlay (nunca movido) — o latestRef preserva o desenho.
  const tldraw = (
    <div className="nodrag nopan nowheel absolute inset-0">
      <Tldraw assetUrls={TLDRAW_ASSET_URLS} onMount={handleMount} />
    </div>
  );

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
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); void exportPng(); }}
            title="Exportar PNG"
            className="hover:text-text shrink-0"
          >
            <Download size={12} />
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); setIsFullscreen(true); }}
            title="Tela cheia (desenhar grande, ponteiro preciso)"
            className="hover:text-text shrink-0"
          >
            <Maximize2 size={12} />
          </button>
          <button
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); removeNode(id); }}
            title="Fechar"
            className="hover:text-danger shrink-0"
          >
            <X size={12} />
          </button>
        </header>
        <div className="flex-1 relative bg-bg">
          {isFullscreen ? (
            <div className="absolute inset-0 flex items-center justify-center gap-1.5 text-textMuted text-xs">
              <Maximize2 size={13} /> desenhando em tela cheia…
            </div>
          ) : (
            tldraw
          )}
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
                onClick={() => void exportPng()}
                title="Exportar PNG"
                className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
              >
                <Download size={14} />
              </button>
              <button
                onClick={() => setIsFullscreen(false)}
                title="Sair da tela cheia"
                className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
              >
                <Minimize2 size={14} />
              </button>
            </header>
            <div className="flex-1 relative bg-bg">{tldraw}</div>
          </div>,
          document.body,
        )}
    </>
  );
}
