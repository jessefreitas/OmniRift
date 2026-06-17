import { memo, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Camera, Copy, ExternalLink, Globe, RotateCw, X } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { NodeHelp } from "@/components/NodeHelp";
import { normalizeUrl, browserShot } from "@/lib/portal-client";
import type { PortalNode as PortalNodeData } from "@/types/canvas";

type PortalRfNode = Node<PortalNodeData & Record<string, unknown>, "portal">;

// v1 = iframe in-DOM: posiciona/zooma com o node sem sincronização, e funciona
// pro caso central (preview de dev server localhost, http). O webview nativo do
// Tauri (commit b5b8cff) bateu em limitações do WebKitGTK aqui (posicionamento de
// child-webview + TLS do NetworkProcess) — fica como upgrade se o multiwebview do
// Tauri no Linux amadurecer. Limitação do iframe: sites com X-Frame-Options recusam
// embed (use "abrir no navegador").
function PortalNodeBase({ id, data, selected }: NodeProps<PortalRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [urlInput, setUrlInput] = useState(data.url);
  const [reloadKey, setReloadKey] = useState(0);
  const [shot, setShot] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [shotErr, setShotErr] = useState<string | null>(null);
  const url = normalizeUrl(data.url);
  const { maxBtn, frame } = useNodeMaximize();
  const isExternal = !!url && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(url);

  function go() {
    const u = normalizeUrl(urlInput);
    if (u) { patchNode(id, { url: u }); setShot(null); setShotErr(null); }
  }

  async function snapshot() {
    if (!url) return;
    setShooting(true);
    setShotErr(null);
    try {
      setShot(await browserShot(url));
    } catch (e) {
      setShotErr(String(e));
    } finally {
      setShooting(false);
    }
  }

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Globe size={12} className="text-brand shrink-0" />
        <input
          value={urlInput}
          onChange={(e) => setUrlInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") go(); e.stopPropagation(); }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="localhost:3000 ou uma URL…"
          className="flex-1 min-w-0 bg-bg border border-border rounded px-1.5 py-0.5 text-[11px] text-text placeholder:text-textMuted focus:outline-none focus:border-brand cursor-text"
        />
        <NodeHelp text="Portal: digite uma URL (ex.: localhost:3000) e Enter pra embutir a página. Sites com X-Frame-Options recusam embed — use abrir no navegador (↗) ou Snapshot (📷) pra renderizar HTTPS externo." />
        <button onClick={(e) => { e.stopPropagation(); if (shot) { setShot(null); } else { setReloadKey((k) => k + 1); } }} title={shot ? "Voltar pro iframe" : "Recarregar"} className="hover:text-text shrink-0">
          <RotateCw size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); void snapshot(); }} title="Snapshot (renderiza HTTPS externo via Playwright)" className={shooting ? "text-brand shrink-0" : "hover:text-text shrink-0"}>
          <Camera size={11} className={shooting ? "animate-pulse" : ""} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); if (url) openExternal(url).catch(() => {}); }} title="Abrir no navegador" className="hover:text-text shrink-0">
          <ExternalLink size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); if (url) navigator.clipboard.writeText(url).catch(() => {}); }} title="Copiar URL" className="hover:text-text shrink-0">
          <Copy size={11} />
        </button>
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar portal" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>
      {/* nodrag/nopan/nowheel: o React Flow ignora os ponteiros/scroll → o iframe os recebe. */}
      <div className="nodrag nopan nowheel flex-1 relative bg-white">
        {shot ? (
          <img src={shot} alt="snapshot" className="absolute inset-0 h-full w-full object-contain object-top bg-white" />
        ) : shotErr ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg text-danger text-[11px] p-3 text-center">
            <Camera size={14} /> snapshot falhou
            <span className="text-textMuted opacity-70 break-words">{shotErr}</span>
          </div>
        ) : url ? (
          <iframe
            key={reloadKey}
            src={url}
            title="portal"
            className="absolute inset-0 h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-bg text-textMuted text-xs">
            <Globe size={14} /> digite uma URL no topo
          </div>
        )}
        {url && !shot && isExternal && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 pointer-events-none text-center text-[10px] text-white bg-black/55 rounded px-2 py-1">
            Em branco? Sites externos costumam bloquear embed (X-Frame). Use 📷 Snapshot ou ↗ abrir no navegador.
          </div>
        )}
      </div>
    </>
  );

  return frame(
    card,
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 420, height: data.size?.height ?? 320 }}
    >
      <NodeResizer isVisible={selected} minWidth={260} minHeight={200} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>,
  );
}

// memo: não re-renderiza quando OUTRO node muda (ganho com muitos nodes no canvas).
export const PortalNode = memo(PortalNodeBase);
