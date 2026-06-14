import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { NodeResizer, useViewport, type Node, type NodeProps } from "@xyflow/react";
import { Copy, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { useCanvasStore } from "@/store/canvas-store";
import {
  normalizeUrl,
  portalClose,
  portalCreate,
  portalNavigate,
  portalSetBounds,
  portalSetVisible,
} from "@/lib/portal-client";
import type { PortalNode as PortalNodeData } from "@/types/canvas";

type PortalRfNode = Node<PortalNodeData & Record<string, unknown>, "portal">;

export function PortalNode({ id, data, selected }: NodeProps<PortalRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const viewport = useViewport();
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const createdRef = useRef(false);
  const visibleRef = useRef(false);
  const [urlInput, setUrlInput] = useState(data.url);
  const [error, setError] = useState<string | null>(null);

  // Casa o webview nativo com o rect (CSS px) do corpo do node. Esconde quando o
  // node está oculto (floor inativo via display:none → offsetParent null) ou minúsculo.
  const syncBounds = useCallback(() => {
    const el = bodyRef.current;
    if (!el || !createdRef.current) return;
    const r = el.getBoundingClientRect();
    const show = el.offsetParent !== null && r.width >= 2 && r.height >= 2;
    if (show !== visibleRef.current) {
      visibleRef.current = show;
      portalSetVisible(id, show).catch(() => {});
    }
    if (show) portalSetBounds(id, r.left, r.top, r.width, r.height).catch(() => {});
  }, [id]);

  // Cria o webview quando há URL; navega quando a URL muda.
  useEffect(() => {
    const url = normalizeUrl(data.url);
    if (!url) return;
    if (createdRef.current) {
      portalNavigate(id, url).catch(() => {});
      return;
    }
    const r = bodyRef.current?.getBoundingClientRect();
    portalCreate(id, url, r?.left ?? 0, r?.top ?? 0, r?.width ?? 420, r?.height ?? 300)
      .then(() => { createdRef.current = true; visibleRef.current = true; syncBounds(); })
      .catch((e) => setError(String(e)));
  }, [data.url, id, syncBounds]);

  // Re-sincroniza no pan/zoom (viewport) e no drag/resize (position/size).
  useLayoutEffect(() => {
    const raf = requestAnimationFrame(syncBounds);
    return () => cancelAnimationFrame(raf);
  }, [viewport.x, viewport.y, viewport.zoom, data.position?.x, data.position?.y, data.size?.width, data.size?.height, syncBounds]);

  // Troca de floor (display:none↔block) e scroll para dentro/fora da vista.
  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const io = new IntersectionObserver(() => syncBounds());
    io.observe(el);
    const onResize = () => syncBounds();
    window.addEventListener("resize", onResize);
    return () => { io.disconnect(); window.removeEventListener("resize", onResize); };
  }, [syncBounds]);

  // Fecha o webview no unmount.
  useEffect(() => () => { portalClose(id).catch(() => {}); }, [id]);

  function go() {
    const url = normalizeUrl(urlInput);
    if (url) patchNode(id, { url });
  }

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 420, height: data.size?.height ?? 320 }}
    >
      <NodeResizer isVisible={selected} minWidth={260} minHeight={200} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <header className="node-drag-handle flex items-center gap-1 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Globe size={12} className="text-brand shrink-0" />
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); e.stopPropagation(); }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="digite uma URL…"
          className="flex-1 min-w-0 bg-bg border border-border rounded px-1.5 py-0.5 text-[11px] text-text placeholder:text-textMuted focus:outline-none focus:border-brand cursor-text"
        />
        <button onClick={(e) => { e.stopPropagation(); if (data.url) portalNavigate(id, normalizeUrl(data.url)).catch(() => {}); }} title="Recarregar" className="hover:text-text shrink-0">
          <RotateCw size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); if (data.url) openExternal(normalizeUrl(data.url)).catch(() => {}); }} title="Abrir no navegador" className="hover:text-text shrink-0">
          <ExternalLink size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); if (data.url) navigator.clipboard.writeText(data.url).catch(() => {}); }} title="Copiar URL" className="hover:text-text shrink-0">
          <Copy size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar portal" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>
      {/* Corpo: o webview nativo flutua exatamente sobre esta área. O conteúdo aqui
          só aparece quando o webview está escondido (floor inativo) ou sem URL. */}
      <div ref={bodyRef} className="flex-1 relative bg-bg">
        {error ? (
          <div className="absolute inset-0 flex items-center justify-center text-danger text-xs px-4 text-center">{error}</div>
        ) : !data.url ? (
          <div className="absolute inset-0 flex items-center justify-center text-textMuted text-xs gap-1.5">
            <Globe size={14} /> digite uma URL no topo
          </div>
        ) : null}
      </div>
    </div>
  );
}
