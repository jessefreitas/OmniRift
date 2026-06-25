// src/components/nodes/HtmlNode.tsx
//
// Visualizador de arquivos .html locais (apresentações reveal.js, relatórios, etc.).
// Usa o asset protocol do Tauri (convertFileSrc) → iframe com mesma origem asset,
// então JS/CSS/assets relativos da apresentação carregam. NÃO é cross-origin (foge
// da dor da Fase 5 / X-Frame-Options dos sites externos).

import { memo, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { FileCode, RotateCw, X } from "lucide-react";
import { convertFileSrc } from "@tauri-apps/api/core";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { NodeHelp } from "@/components/NodeHelp";
import { useT } from "@/lib/i18n";
import type { HtmlNode as HtmlNodeData } from "@/types/canvas";

type HtmlRfNode = Node<HtmlNodeData & Record<string, unknown>, "html">;

function HtmlNodeBase({ id, data, selected }: NodeProps<HtmlRfNode>) {
  const t = useT();
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [reloadKey, setReloadKey] = useState(0);
  const { maxBtn, frame } = useNodeMaximize();

  const fileName = data.filePath ? (data.filePath.split(/[/\\]/).filter(Boolean).pop() ?? data.filePath) : "—";
  // convertFileSrc → asset://localhost/<path> (Linux: http://asset.localhost/<path>).
  // Pode lançar se o path for inválido; tratamos como estado de erro no node.
  let assetUrl: string | null = null;
  let convertErr: string | null = null;
  try {
    assetUrl = data.filePath ? convertFileSrc(data.filePath) : null;
  } catch (e) {
    convertErr = String(e);
  }

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <FileCode size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1" title={data.filePath}>{fileName}</span>
        <NodeHelp text={t("html.help", "Visualizador HTML: abre um arquivo .html local (apresentações reveal.js, relatórios) via asset protocol — JS e assets relativos funcionam. Recarregue com ↻.")} />
        <button onClick={(e) => { e.stopPropagation(); setReloadKey((k) => k + 1); }} title={t("html.reload", "Recarregar")} className="hover:text-text shrink-0">
          <RotateCw size={11} />
        </button>
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("html.close", "Fechar")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>
      {/* nodrag/nopan/nowheel: o React Flow ignora ponteiros/scroll → o iframe os recebe. */}
      <div className="nodrag nopan nowheel flex-1 relative bg-white">
        {convertErr || !assetUrl ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg text-danger text-[11px] p-3 text-center">
            <FileCode size={14} /> {t("html.loadFailed", "não consegui abrir o HTML")}
            <span className="text-textMuted opacity-70 break-words">{convertErr ?? t("html.noPath", "sem caminho de arquivo")}</span>
          </div>
        ) : (
          <iframe
            key={reloadKey}
            src={assetUrl}
            title={fileName}
            className="absolute inset-0 h-full w-full border-0 bg-white"
            // reveal.js & afins precisam de JS; same-origin pro asset carregar CSS/imagens relativos.
            sandbox="allow-scripts allow-same-origin"
          />
        )}
      </div>
    </>
  );

  return frame(
    card,
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 720, height: data.size?.height ?? 460 }}
    >
      <NodeResizer isVisible={selected} minWidth={280} minHeight={200} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>,
  );
}

// memo: não re-renderiza quando OUTRO node muda.
export const HtmlNode = memo(HtmlNodeBase);
