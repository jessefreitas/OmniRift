import { useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Globe, Send, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { useT } from "@/lib/i18n";
import { NodeHelp } from "@/components/NodeHelp";
import { httpRequest, type HttpResponse } from "@/lib/api-client";
import { cn } from "@/lib/cn";
import type { ApiNode as ApiNodeData } from "@/types/canvas";

type ApiRfNode = Node<ApiNodeData & Record<string, unknown>, "api">;

const METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"];

function statusColor(s: number): string {
  if (s >= 500) return "text-danger";
  if (s >= 400) return "text-yellow-400";
  if (s >= 300) return "text-blue-400";
  if (s >= 200) return "text-green-400";
  return "text-textMuted";
}

/** Tenta formatar JSON; senão devolve o texto cru. */
function pretty(body: string): string {
  try {
    return JSON.stringify(JSON.parse(body), null, 2);
  } catch {
    return body;
  }
}

export function ApiNode({ id, data, selected }: NodeProps<ApiRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [method, setMethod] = useState(data.method || "GET");
  const [url, setUrl] = useState(data.url);
  const [body, setBody] = useState(data.body ?? "");
  const [resp, setResp] = useState<HttpResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { maxBtn, frame } = useNodeMaximize();

  const hasBody = method !== "GET" && method !== "DELETE";

  async function send() {
    const u = url.trim();
    if (!u) return;
    patchNode(id, { method, url: u, body });
    setLoading(true);
    setError(null);
    try {
      const headers: Record<string, string> =
        hasBody && body.trim() ? { "content-type": "application/json" } : {};
      setResp(await httpRequest(method, /^[a-z]+:\/\//i.test(u) ? u : `https://${u}`, headers, hasBody ? body : undefined));
    } catch (e) {
      setError(String(e));
      setResp(null);
    } finally {
      setLoading(false);
    }
  }

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Globe size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">API</span>
        <NodeHelp text={t("api.help", "Cliente HTTP: escolha o método, digite a URL e tecle Enter (ou Send). Em POST/PUT/PATCH preencha o corpo JSON. A resposta e o status aparecem abaixo.")} />
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("common.close", "Fechar")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      {/* Linha do request: método + URL + enviar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border nodrag">
        <select
          value={method}
          onChange={(e) => setMethod(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          className="px-1 py-1 rounded text-[11px] font-medium bg-bg border border-border text-text focus:outline-none"
        >
          {METHODS.map((m) => (
            <option key={m} value={m}>{m}</option>
          ))}
        </select>
        <input
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void send(); e.stopPropagation(); }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={t("api.urlPlaceholder", "api.exemplo.com/v1/users ou localhost:3000/...")}
          className="flex-1 min-w-0 px-1.5 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
        />
        <button
          onClick={() => void send()}
          disabled={loading || !url.trim()}
          title={t("api.send", "Enviar")}
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Send size={11} /> {loading ? "…" : t("api.sendLabel", "Send")}
        </button>
      </div>

      {/* Body (pra métodos que enviam corpo) */}
      {hasBody && (
        <textarea
          value={body}
          onChange={(e) => setBody(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={t("api.bodyPlaceholder", '{ "json": "do corpo" }')}
          className="nodrag h-20 shrink-0 px-2 py-1.5 text-[11px] bg-bg border-b border-border text-text resize-none focus:outline-none font-mono placeholder:text-textMuted"
        />
      )}

      {/* Resposta */}
      <div className="flex-1 overflow-auto bg-bg nodrag" onPointerDown={(e) => e.stopPropagation()}>
        {error ? (
          <p className="px-2 py-2 text-[11px] text-danger">{error}</p>
        ) : resp ? (
          <>
            <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-[10px] sticky top-0 bg-surface1">
              <span className={cn("font-bold", statusColor(resp.status))}>
                {resp.status} {resp.statusText}
              </span>
              <span className="text-textMuted opacity-60">{resp.durationMs}ms</span>
              <span className="text-textMuted opacity-60">{resp.body.length} bytes</span>
            </div>
            <pre className="px-2 py-1.5 text-[11px] text-text whitespace-pre-wrap break-words font-mono">
              {pretty(resp.body)}
            </pre>
          </>
        ) : (
          <p className="px-2 py-2 text-[10px] text-textMuted opacity-50">
            {t("api.emptyHint", "A resposta aparece aqui. Enter ou Send pra disparar.")}
          </p>
        )}
      </div>
    </>
  );

  return frame(
    card,
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 440, height: data.size?.height ?? 380 }}
    >
      <NodeResizer isVisible={selected} minWidth={300} minHeight={240} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>,
  );
}
