// src/components/nodes/PdfNode.tsx
//
// Visualizador de PDF via pdf.js renderizando em <canvas> (NÃO iframe → não
// esbarra nas limitações do WebKitGTK da Fase 5). Lê os bytes do arquivo local
// com @tauri-apps/plugin-fs (readFile → Uint8Array) e passa pro getDocument({data}).
// Carregado sob demanda pelo PdfNodeLazy (pdf.js é pesado → code-split).
//
// Controles: ‹ página N/total ›, zoom −/+. nowheel no container (scroll do canvas
// não rola o React Flow). Estados: carregando / erro (arquivo inválido) / pronto.

import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { ChevronLeft, ChevronRight, FileText, Minus, Plus, X } from "lucide-react";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  GlobalWorkerOptions,
  getDocument,
  type PDFDocumentProxy,
  type RenderTask,
} from "pdfjs-dist";
// Worker do pdf.js empacotado pelo Vite (offline; sem CDN). O `?url` faz o Vite
// emitir o asset e devolver o caminho final → workerSrc.
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { NodeHelp } from "@/components/NodeHelp";
import { useT } from "@/lib/i18n";
import type { PdfNode as PdfNodeData } from "@/types/canvas";

GlobalWorkerOptions.workerSrc = workerUrl;

type PdfRfNode = Node<PdfNodeData & Record<string, unknown>, "pdf">;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

function PdfNodeBase({ id, data, selected }: NodeProps<PdfRfNode>) {
  const t = useT();
  const removeNode = useCanvasStore((s) => s.removeNode);
  const { maxBtn, frame } = useNodeMaximize();

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const docRef = useRef<PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<RenderTask | null>(null);

  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fileName = data.filePath ? (data.filePath.split(/[/\\]/).filter(Boolean).pop() ?? data.filePath) : "—";

  // Carrega o documento quando o caminho muda. Limpa o doc anterior no cleanup.
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setNumPages(0);
    setPage(1);

    (async () => {
      if (!data.filePath) {
        if (!cancelled) { setError(t("pdf.noPath", "sem caminho de arquivo")); setLoading(false); }
        return;
      }
      try {
        const bytes = await readFile(data.filePath); // Uint8Array
        const doc = await getDocument({ data: bytes }).promise;
        if (cancelled) { void doc.destroy(); return; }
        docRef.current = doc;
        setNumPages(doc.numPages);
        setLoading(false);
      } catch (e) {
        if (!cancelled) { setError(String(e)); setLoading(false); }
      }
    })();

    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
      docRef.current?.destroy().catch(() => {});
      docRef.current = null;
    };
  }, [data.filePath, t]);

  // Renderiza a página atual (no canvas) sempre que página/zoom/doc mudam.
  useEffect(() => {
    const doc = docRef.current;
    const canvas = canvasRef.current;
    if (!doc || !canvas || loading || error) return;

    let cancelled = false;
    (async () => {
      try {
        // Cancela um render em voo antes de começar outro (zoom/troca rápida de página).
        renderTaskRef.current?.cancel();
        const pdfPage = await doc.getPage(page);
        if (cancelled) return;
        const viewport = pdfPage.getViewport({ scale });
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        canvas.width = Math.ceil(viewport.width);
        canvas.height = Math.ceil(viewport.height);
        const task = pdfPage.render({ canvasContext: ctx, viewport });
        renderTaskRef.current = task;
        await task.promise;
        if (!cancelled) renderTaskRef.current = null;
      } catch (e) {
        // RenderingCancelledException é esperado em troca rápida — ignora.
        const msg = String(e);
        if (!cancelled && !/cancel/i.test(msg)) setError(msg);
      }
    })();

    return () => { cancelled = true; };
  }, [page, scale, numPages, loading, error]);

  const prev = () => setPage((p) => Math.max(1, p - 1));
  const next = () => setPage((p) => Math.min(numPages || 1, p + 1));
  const zoomOut = () => setScale((s) => Math.max(ZOOM_MIN, +(s - ZOOM_STEP).toFixed(2)));
  const zoomIn = () => setScale((s) => Math.min(ZOOM_MAX, +(s + ZOOM_STEP).toFixed(2)));

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <FileText size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1" title={data.filePath}>{fileName}</span>
        <NodeHelp text={t("pdf.help", "Visualizador PDF: renderizado via pdf.js. Navegue com ‹ ›, ajuste o zoom com − +. Scroll rola o canvas dentro do node.")} />
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("pdf.close", "Fechar")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      {/* Controles de página/zoom */}
      <div className="flex items-center gap-1.5 px-2 py-1 bg-surface2/60 border-b border-border text-textMuted text-[11px]" onPointerDown={(e) => e.stopPropagation()}>
        <button onClick={(e) => { e.stopPropagation(); prev(); }} disabled={page <= 1 || loading || !!error} title={t("pdf.prev", "Página anterior")} className="hover:text-text disabled:opacity-30 shrink-0">
          <ChevronLeft size={13} />
        </button>
        <span className="tabular-nums select-none">{numPages ? `${page}/${numPages}` : "—"}</span>
        <button onClick={(e) => { e.stopPropagation(); next(); }} disabled={page >= numPages || loading || !!error} title={t("pdf.next", "Próxima página")} className="hover:text-text disabled:opacity-30 shrink-0">
          <ChevronRight size={13} />
        </button>
        <span className="flex-1" />
        <button onClick={(e) => { e.stopPropagation(); zoomOut(); }} disabled={scale <= ZOOM_MIN || loading || !!error} title={t("pdf.zoomOut", "Diminuir zoom")} className="hover:text-text disabled:opacity-30 shrink-0">
          <Minus size={13} />
        </button>
        <span className="tabular-nums select-none w-9 text-center">{Math.round(scale * 100)}%</span>
        <button onClick={(e) => { e.stopPropagation(); zoomIn(); }} disabled={scale >= ZOOM_MAX || loading || !!error} title={t("pdf.zoomIn", "Aumentar zoom")} className="hover:text-text disabled:opacity-30 shrink-0">
          <Plus size={13} />
        </button>
      </div>

      {/* nowheel: scroll rola o conteúdo do PDF, não o canvas do React Flow. */}
      <div className="nowheel flex-1 overflow-auto bg-neutral-700 flex items-start justify-center p-2" onPointerDown={(e) => e.stopPropagation()}>
        {error ? (
          <div className="flex flex-col items-center justify-center gap-1 h-full text-danger text-[11px] p-3 text-center">
            <FileText size={14} /> {t("pdf.loadFailed", "não consegui abrir o PDF")}
            <span className="text-textMuted opacity-70 break-words">{error}</span>
          </div>
        ) : loading ? (
          <div className="flex items-center justify-center h-full text-textMuted text-[11px] opacity-70">
            {t("pdf.loading", "carregando pdf…")}
          </div>
        ) : (
          <canvas ref={canvasRef} className="shadow-lg bg-white" />
        )}
      </div>
    </>
  );

  return frame(
    card,
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 560, height: data.size?.height ?? 720 }}
    >
      <NodeResizer isVisible={selected} minWidth={280} minHeight={240} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>,
  );
}

// memo: não re-renderiza quando OUTRO node muda.
export const PdfNode = memo(PdfNodeBase);
