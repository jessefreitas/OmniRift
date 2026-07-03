import { memo, useMemo, useState } from "react";
import { SafeTextarea } from "@/components/SafeInput";
import { createPortal } from "react-dom";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Braces, ChevronRight, Code2, ListTree, Maximize2, Minimize2, Network, Upload, X } from "lucide-react";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { NodeHelp } from "@/components/NodeHelp";
import { NodeComment } from "@/components/NodeComment";
import { MindMap } from "@/components/MindMap";
import { cn } from "@/lib/cn";
import type { JsonNode as JsonNodeData } from "@/types/canvas";

type JsonRfNode = Node<JsonNodeData & Record<string, unknown>, "json">;

/** Linha de uma folha (string/number/bool/null) colorida por tipo. */
function leafColor(v: unknown): string {
  if (v === null) return "text-textMuted opacity-60";
  switch (typeof v) {
    case "string": return "text-green-400";
    case "number": return "text-blue-400";
    case "boolean": return "text-purple-400";
    default: return "text-text";
  }
}
function leafText(v: unknown): string {
  if (v === null) return "null";
  if (typeof v === "string") return `"${v}"`;
  return String(v);
}

function TreeNode({ k, value, depth }: { k: string | null; value: unknown; depth: number }) {
  const [open, setOpen] = useState(depth < 2);
  const isArr = Array.isArray(value);
  const isObj = value !== null && typeof value === "object";

  if (!isObj) {
    return (
      <div className="flex gap-1.5 leading-tight" style={{ paddingLeft: depth * 12 + 14 }}>
        {k !== null && <span className="text-brand shrink-0">{k}:</span>}
        <span className={cn("break-all", leafColor(value))}>{leafText(value)}</span>
      </div>
    );
  }

  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const bracket = isArr ? `[${entries.length}]` : `{${entries.length}}`;

  return (
    <div>
      <div
        className="flex items-center gap-1 leading-tight cursor-pointer hover:bg-surface1/50 rounded"
        style={{ paddingLeft: depth * 12 }}
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={11} className={cn("shrink-0 transition-transform text-textMuted", open && "rotate-90")} />
        {k !== null && <span className="text-brand">{k}:</span>}
        <span className="text-textMuted opacity-70">{bracket}</span>
      </div>
      {open &&
        entries.map(([ck, cv], i) => (
          <TreeNode key={i} k={isArr ? null : ck} value={cv} depth={depth + 1} />
        ))}
    </div>
  );
}

function isPrimitive(v: unknown): boolean {
  return v === null || typeof v !== "object";
}

/** Nó do grafo (JSON Crack-style): card à esquerda, filhos objeto/array ramificam à direita. */
function GraphNode({ k, value }: { k: string | null; value: unknown }) {
  if (isPrimitive(value)) {
    return (
      <div className="rounded border border-border bg-surface1 px-2 py-1 text-[11px] font-mono whitespace-nowrap shrink-0">
        {k !== null && <span className="text-brand">{k}: </span>}
        <span className={leafColor(value)}>{leafText(value)}</span>
      </div>
    );
  }
  const isArr = Array.isArray(value);
  const entries: [string, unknown][] = isArr
    ? (value as unknown[]).map((v, i) => [String(i), v])
    : Object.entries(value as Record<string, unknown>);
  const prims = entries.filter(([, v]) => isPrimitive(v));
  const objs = entries.filter(([, v]) => !isPrimitive(v));
  return (
    <div className="flex items-start gap-0">
      <div className="rounded-md border border-border bg-surface1 shadow-sm overflow-hidden shrink-0">
        <div className="px-2 py-0.5 bg-surface2 text-[10px] text-textMuted border-b border-border font-mono">
          {k ?? "root"} <span className="opacity-50">{isArr ? `[${entries.length}]` : `{${entries.length}}`}</span>
        </div>
        {prims.length > 0 && (
          <div className="px-2 py-1 space-y-0.5">
            {prims.map(([ck, cv], i) => (
              <div key={i} className="text-[11px] font-mono whitespace-nowrap">
                <span className="text-brand">{ck}: </span>
                <span className={leafColor(cv)}>{leafText(cv)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
      {objs.length > 0 && (
        <div className="flex items-start">
          {/* ligação: linha do pai → spine vertical → stub por filho (árvore/mapa mental) */}
          <div className="w-5 h-px bg-brand/50 shrink-0 mt-[14px]" />
          <div className="flex flex-col gap-3 py-1 border-l-2 border-brand/30">
            {objs.map(([ck, cv], i) => (
              <div key={i} className="flex items-center">
                <div className="w-5 h-px bg-brand/40 shrink-0" />
                <GraphNode k={isArr ? `[${ck}]` : ck} value={cv} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function JsonNodeImpl({ id, data, selected }: NodeProps<JsonRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [text, setText] = useState(data.text || "");
  const [view, setView] = useState<"text" | "tree" | "graph">("text");
  const [maximized, setMaximized] = useState(false);
  // handles de resize aparecem ao selecionar OU passar o mouse (descobribilidade)
  const [hovered, setHovered] = useState(false);

  const parsed = useMemo<{ ok: true; value: unknown } | { ok: false; error: string } | null>(() => {
    if (!text.trim()) return null;
    try {
      return { ok: true, value: JSON.parse(text) };
    } catch (e) {
      return { ok: false, error: String(e instanceof Error ? e.message : e) };
    }
  }, [text]);

  function format() {
    if (parsed?.ok) {
      const f = JSON.stringify(parsed.value, null, 2);
      setText(f);
      patchNode(id, { text: f });
    }
  }
  function minify() {
    if (parsed?.ok) {
      const m = JSON.stringify(parsed.value);
      setText(m);
      patchNode(id, { text: m });
    }
  }
  async function uploadJson() {
    try {
      const sel = await open({ multiple: false, filters: [{ name: "JSON", extensions: ["json"] }] });
      if (typeof sel !== "string") return;
      const content = await invoke<string>("read_file", { path: sel });
      setText(content);
      patchNode(id, { text: content });
      setView("graph"); // abre direto como mapa mental
    } catch (e) {
      console.warn("[json] upload falhou:", e);
    }
  }
  // Arrastar pra navegar o grafo (pan), além do scroll/wheel.
  function startPan(e: React.MouseEvent<HTMLDivElement>) {
    if (view !== "graph" || e.button !== 0) return;
    const el = e.currentTarget;
    const sx = e.clientX, sy = e.clientY, sl = el.scrollLeft, st = el.scrollTop;
    el.style.cursor = "grabbing";
    const move = (ev: MouseEvent) => {
      el.scrollLeft = sl - (ev.clientX - sx);
      el.scrollTop = st - (ev.clientY - sy);
    };
    const up = () => {
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", up);
      el.style.cursor = "";
    };
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", up);
  }

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Braces size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">JSON</span>
        {parsed && (
          <span className={cn("text-[10px] shrink-0", parsed.ok ? "text-green-400" : "text-danger")}>
            {parsed.ok ? t("json.valid", "válido") : t("json.invalid", "inválido")}
          </span>
        )}
        <NodeHelp text={t("json.help", "JSON/código: cole o conteúdo ou Suba (↑) um arquivo. Alterne Texto / Árvore / Grafo. Maximize (⤡) abre o mapa mental navegável — vale pra JSON, XML e HTML. Comente no rodapé.")} />
        <button onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }} title={maximized ? t("common.restore", "Restaurar") : t("common.maximize", "Maximizar")} className="hover:text-brand shrink-0">
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("common.close", "Fechar")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      {/* Toolbar: view toggle + format/minify */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border nodrag">
        <div className="flex rounded overflow-hidden border border-border">
          <button
            onClick={() => setView("text")}
            onPointerDown={(e) => e.stopPropagation()}
            className={cn("flex items-center gap-1 px-2 py-1 text-[11px]", view === "text" ? "bg-brand text-bg" : "bg-bg text-textMuted hover:text-text")}
          >
            <Code2 size={11} /> {t("json.text", "Texto")}
          </button>
          <button
            onClick={() => setView("tree")}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!parsed?.ok}
            className={cn("flex items-center gap-1 px-2 py-1 text-[11px] disabled:opacity-40", view === "tree" ? "bg-brand text-bg" : "bg-bg text-textMuted hover:text-text")}
          >
            <ListTree size={11} /> {t("json.tree", "Árvore")}
          </button>
          <button
            onClick={() => setView("graph")}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!text.trim()}
            title={t("json.graphTitle", "Mapa mental (JSON/XML/HTML) — maximize pra navegar")}
            className={cn("flex items-center gap-1 px-2 py-1 text-[11px] disabled:opacity-40", view === "graph" ? "bg-brand text-bg" : "bg-bg text-textMuted hover:text-text")}
          >
            <Network size={11} /> {t("json.graph", "Grafo")}
          </button>
        </div>
        <div className="flex-1" />
        <button
          onClick={uploadJson}
          onPointerDown={(e) => e.stopPropagation()}
          title={t("json.uploadTitle", "Subir um arquivo .json")}
          className="flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border"
        >
          <Upload size={11} /> {t("json.upload", "Subir")}
        </button>
        <button
          onClick={format}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!parsed?.ok}
          className="px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border disabled:opacity-40"
        >
          {t("json.format", "Format")}
        </button>
        <button
          onClick={minify}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!parsed?.ok}
          className="px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border disabled:opacity-40"
        >
          {t("json.minify", "Minify")}
        </button>
      </div>

      {/* Corpo: editor ou árvore */}
      {view === "text" ? (
        <SafeTextarea
          value={text}
          onChange={(e) => { setText(e.target.value); patchNode(id, { text: e.target.value }); }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder={t("json.placeholder", '{ "cole": "seu json aqui" }')}
          className="nodrag flex-1 px-2 py-1.5 text-[11px] bg-bg text-text resize-none focus:outline-none font-mono placeholder:text-textMuted"
        />
      ) : maximized && view === "graph" ? (
        <div className="flex-1 min-h-0 relative bg-bg">
          <MindMap text={text} />
        </div>
      ) : (
        <div
          className={cn("flex-1 overflow-auto bg-bg nodrag nowheel px-1.5 py-1.5 text-[11px] font-mono", view === "graph" && "cursor-grab active:cursor-grabbing")}
          onPointerDown={(e) => e.stopPropagation()}
          onMouseDown={startPan}
        >
          {view === "graph" ? (
            parsed?.ok ? (
              <div className="inline-block min-w-full py-2"><GraphNode k={null} value={parsed.value} /></div>
            ) : (
              <div className="flex items-center justify-center h-full text-center text-textMuted opacity-60 text-[11px] px-6">
                {t("json.maximizeHint", "Maximize (⤡) pra ver o mapa mental — funciona com JSON, XML e HTML.")}
              </div>
            )
          ) : !parsed?.ok ? (
            <p className="text-textMuted opacity-50">{t("json.invalidFix", "JSON inválido — corrija no modo Texto.")}</p>
          ) : (
            <TreeNode k={null} value={parsed.value} depth={0} />
          )}
        </div>
      )}

      {/* Rodapé de erro */}
      {parsed && !parsed.ok && view === "text" && (
        <p className="shrink-0 px-2 py-1 text-[10px] text-danger border-t border-border bg-bg break-words">{parsed.error}</p>
      )}
      <NodeComment value={data.comment} onChange={(v) => patchNode(id, { comment: v })} />
    </>
  );

  if (maximized) {
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => setMaximized(false)}>
        <div className="w-[92vw] h-[90vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {card}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 460, height: data.size?.height ?? 420 }}
    >
      <NodeResizer isVisible={selected || hovered} minWidth={320} minHeight={280} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>
  );
}

export const JsonNode = memo(JsonNodeImpl);
