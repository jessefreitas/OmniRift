import { useRef } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Tldraw, getSnapshot, loadSnapshot, type Editor } from "tldraw";
import { getAssetUrlsByImport } from "@tldraw/assets/imports.vite";
import { Pencil, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import type { SketchNode as SketchNodeData } from "@/types/canvas";

import "tldraw/tldraw.css";

type SketchRfNode = Node<SketchNodeData & Record<string, unknown>, "sketch">;

// Assets (ícones/fontes da UI) bundlados LOCAL via Vite — sem isso o tldraw busca
// na rede (cdn) e a toolbar fica sem ícones aqui (TLS do WebKitGTK quebrado).
const ASSET_URLS = getAssetUrlsByImport();

export function SketchNode({ id, data, selected }: NodeProps<SketchRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const saveTimer = useRef<number>(0);

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

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 480, height: data.size?.height ?? 360 }}
    >
      <NodeResizer isVisible={selected} minWidth={280} minHeight={220} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Pencil size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">Sketch</span>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>
      {/* nodrag/nopan/nowheel: o React Flow ignora os ponteiros aqui → tldraw os recebe. */}
      <div className="nodrag nopan nowheel flex-1 relative">
        <Tldraw assetUrls={ASSET_URLS} onMount={handleMount} />
      </div>
    </div>
  );
}
