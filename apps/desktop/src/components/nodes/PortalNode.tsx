import { memo, useEffect, useRef, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Camera, Copy, ExternalLink, Globe, MousePointerClick, RotateCw, Send, X } from "lucide-react";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { NodeHelp } from "@/components/NodeHelp";
import { useT } from "@/lib/i18n";
import { normalizeUrl, browserShot } from "@/lib/portal-client";
import { attachGrabMode, payloadToMarkdown, type GrabHandle, type GrabPayload } from "@/lib/portal-grab";
import type { PortalNode as PortalNodeData } from "@/types/canvas";

type PortalRfNode = Node<PortalNodeData & Record<string, unknown>, "portal">;

// v1 = iframe in-DOM: posiciona/zooma com o node sem sincronização, e funciona
// pro caso central (preview de dev server localhost, http). O webview nativo do
// Tauri (commit b5b8cff) bateu em limitações do WebKitGTK aqui (posicionamento de
// child-webview + TLS do NetworkProcess) — fica como upgrade se o multiwebview do
// Tauri no Linux amadurecer. Limitação do iframe: sites com X-Frame-Options recusam
// embed (use "abrir no navegador").
function PortalNodeBase({ id, data, selected }: NodeProps<PortalRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [urlInput, setUrlInput] = useState(data.url);
  const [reloadKey, setReloadKey] = useState(0);
  const [shot, setShot] = useState<string | null>(null);
  const [shooting, setShooting] = useState(false);
  const [shotErr, setShotErr] = useState<string | null>(null);
  // Design Mode "grab": captura de elemento same-origin/localhost (ref teardown §3.5).
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const grabHandleRef = useRef<GrabHandle | null>(null);
  const [grabbing, setGrabbing] = useState(false);
  const [grabbed, setGrabbed] = useState<GrabPayload | null>(null);
  const [grabErr, setGrabErr] = useState<string | null>(null);
  const [grabSent, setGrabSent] = useState<"copied" | "agent" | null>(null);
  const url = normalizeUrl(data.url);
  const { maxBtn, frame } = useNodeMaximize();
  const isExternal = !!url && !/localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]/.test(url);

  function go() {
    const u = normalizeUrl(urlInput);
    if (u) { patchNode(id, { url: u }); setShot(null); setShotErr(null); stopGrab(); }
  }

  // Liga/desliga o modo de captura. Só funciona em conteúdo same-origin/localhost
  // (cross-origin barra contentDocument → avisamos o user). Ver portal-grab.ts.
  function startGrab() {
    setGrabErr(null);
    setGrabbed(null);
    setGrabSent(null);
    const iframe = iframeRef.current;
    if (!iframe) return;
    const handle = attachGrabMode(iframe, (p) => {
      setGrabbed(p);
      stopGrab();
    });
    if (!handle) {
      // Cross-origin / doc inacessível: limitação fundamental do iframe.
      setGrabErr(t("portal.grabCrossOrigin", "Captura só funciona em conteúdo localhost/same-origin. Sites externos bloqueiam o acesso ao DOM."));
      return;
    }
    grabHandleRef.current = handle;
    setGrabbing(true);
  }

  function stopGrab() {
    grabHandleRef.current?.detach();
    grabHandleRef.current = null;
    setGrabbing(false);
  }

  function toggleGrab() {
    if (grabbing) stopGrab();
    else startGrab();
  }

  // Limpa listeners do iframe ao desmontar / trocar de URL.
  useEffect(() => () => stopGrab(), []);
  useEffect(() => { stopGrab(); setGrabbed(null); setGrabErr(null); }, [url, reloadKey]);

  async function copyGrab() {
    if (!grabbed) return;
    try {
      await navigator.clipboard.writeText(payloadToMarkdown(grabbed));
      setGrabSent("copied");
      setTimeout(() => setGrabSent(null), 1500);
    } catch { /* clipboard off */ }
  }

  function sendGrabToAgent() {
    if (!grabbed) return;
    const markdown = payloadToMarkdown(grabbed);
    // Mesmo padrão do AiReportView → listener na Sidebar spawna/injeta no agente.
    window.dispatchEvent(new CustomEvent("omnirift:portal-grab", { detail: { markdown, url: grabbed.url } }));
    // Também copia pro clipboard como fallback (caso o wiring de spawn não pegue).
    navigator.clipboard.writeText(markdown).catch(() => {});
    setGrabSent("agent");
    setTimeout(() => setGrabSent(null), 1500);
    setGrabbed(null);
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
          placeholder={t("portal.placeholder", "localhost:3000 ou uma URL…")}
          className="flex-1 min-w-0 bg-bg border border-border rounded px-1.5 py-0.5 text-[11px] text-text placeholder:text-textMuted focus:outline-none focus:border-brand cursor-text"
        />
        <NodeHelp text={t("portal.help", "Portal: digite uma URL (ex.: localhost:3000) e Enter pra embutir a página. Sites com X-Frame-Options recusam embed — use abrir no navegador (↗) ou Snapshot (📷) pra renderizar HTTPS externo.")} />
        <button onClick={(e) => { e.stopPropagation(); if (shot) { setShot(null); } else { setReloadKey((k) => k + 1); } }} title={shot ? t("portal.backToIframe", "Voltar pro iframe") : t("portal.reload", "Recarregar")} className="hover:text-text shrink-0">
          <RotateCw size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); void snapshot(); }} title={t("portal.snapshot", "Snapshot (renderiza HTTPS externo via Playwright)")} className={shooting ? "text-brand shrink-0" : "hover:text-text shrink-0"}>
          <Camera size={11} className={shooting ? "animate-pulse" : ""} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); toggleGrab(); }} title={t("portal.grab", "Capturar elemento (localhost/same-origin) e mandar pro agente")} className={grabbing ? "text-brand shrink-0" : "hover:text-text shrink-0"}>
          <MousePointerClick size={11} className={grabbing ? "animate-pulse" : ""} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); if (url) openExternal(url).catch(() => {}); }} title={t("portal.openInBrowser", "Abrir no navegador")} className="hover:text-text shrink-0">
          <ExternalLink size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); if (url) navigator.clipboard.writeText(url).catch(() => {}); }} title={t("portal.copyUrl", "Copiar URL")} className="hover:text-text shrink-0">
          <Copy size={11} />
        </button>
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("portal.close", "Fechar portal")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>
      {/* nodrag/nopan/nowheel: o React Flow ignora os ponteiros/scroll → o iframe os recebe. */}
      <div className="nodrag nopan nowheel flex-1 relative bg-white">
        {shot ? (
          <img src={shot} alt="snapshot" className="absolute inset-0 h-full w-full object-contain object-top bg-white" />
        ) : shotErr ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-1 bg-bg text-danger text-[11px] p-3 text-center">
            <Camera size={14} /> {t("portal.snapshotFailed", "snapshot falhou")}
            <span className="text-textMuted opacity-70 break-words">{shotErr}</span>
          </div>
        ) : url ? (
          <iframe
            ref={iframeRef}
            key={reloadKey}
            src={url}
            title="portal"
            className="absolute inset-0 h-full w-full border-0"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox"
          />
        ) : (
          <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-bg text-textMuted text-xs">
            <Globe size={14} /> {t("portal.typeUrl", "digite uma URL no topo")}
          </div>
        )}
        {url && !shot && isExternal && !grabbing && !grabbed && !grabErr && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 pointer-events-none text-center text-[10px] text-white bg-black/55 rounded px-2 py-1">
            {t("portal.blankWarning", "Em branco? Sites externos costumam bloquear embed (X-Frame). Use 📷 Snapshot ou ↗ abrir no navegador.")}
          </div>
        )}
        {/* Modo de captura ativo: dica de "clique num elemento". */}
        {grabbing && (
          <div className="absolute top-1.5 left-1.5 right-1.5 pointer-events-none text-center text-[10px] text-white bg-brand/80 rounded px-2 py-1">
            {t("portal.grabActive", "Passe o mouse e clique num elemento para capturar (Esc/botão para cancelar)")}
          </div>
        )}
        {/* Erro de captura (cross-origin). */}
        {grabErr && !grabbing && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 text-center text-[10px] text-white bg-danger/80 rounded px-2 py-1">
            {grabErr}
          </div>
        )}
        {/* Elemento capturado: barra de ação (enviar pro agente / copiar markdown). */}
        {grabbed && (
          <div className="absolute bottom-1.5 left-1.5 right-1.5 flex items-center gap-1.5 bg-surface2/95 border border-border rounded px-2 py-1.5 text-[10px] text-text">
            <span className="flex-1 min-w-0 truncate font-mono text-textMuted" title={grabbed.selector}>
              {t("portal.grabbed", "Capturado")}: <span className="text-text">&lt;{grabbed.tag}&gt;</span> {grabbed.selector}
            </span>
            <button onClick={(e) => { e.stopPropagation(); sendGrabToAgent(); }} title={t("portal.grabSend", "Enviar pro agente")} className="flex items-center gap-1 px-1.5 py-0.5 rounded bg-brand text-white hover:opacity-90 shrink-0">
              <Send size={10} /> {grabSent === "agent" ? t("portal.grabSent", "Enviado!") : t("portal.grabSend", "Enviar pro agente")}
            </button>
            <button onClick={(e) => { e.stopPropagation(); void copyGrab(); }} title={t("portal.grabCopy", "Copiar markdown")} className="flex items-center gap-1 px-1.5 py-0.5 rounded border border-border hover:text-text shrink-0">
              <Copy size={10} /> {grabSent === "copied" ? t("portal.grabCopied", "Copiado!") : t("portal.grabCopy", "Copiar")}
            </button>
            <button onClick={(e) => { e.stopPropagation(); setGrabbed(null); }} title={t("portal.grabDismiss", "Descartar")} className="hover:text-danger shrink-0">
              <X size={11} />
            </button>
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
