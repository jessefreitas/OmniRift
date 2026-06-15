import { useMemo, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Braces, ChevronRight, Code2, ListTree, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
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

export function JsonNode({ id, data, selected }: NodeProps<JsonRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [text, setText] = useState(data.text || "");
  const [view, setView] = useState<"text" | "tree">("text");

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

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 460, height: data.size?.height ?? 420 }}
    >
      <NodeResizer isVisible={selected} minWidth={320} minHeight={280} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Braces size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">JSON</span>
        {parsed && (
          <span className={cn("text-[10px] shrink-0", parsed.ok ? "text-green-400" : "text-danger")}>
            {parsed.ok ? "válido" : "inválido"}
          </span>
        )}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
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
            <Code2 size={11} /> Texto
          </button>
          <button
            onClick={() => setView("tree")}
            onPointerDown={(e) => e.stopPropagation()}
            disabled={!parsed?.ok}
            className={cn("flex items-center gap-1 px-2 py-1 text-[11px] disabled:opacity-40", view === "tree" ? "bg-brand text-bg" : "bg-bg text-textMuted hover:text-text")}
          >
            <ListTree size={11} /> Árvore
          </button>
        </div>
        <div className="flex-1" />
        <button
          onClick={format}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!parsed?.ok}
          className="px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border disabled:opacity-40"
        >
          Format
        </button>
        <button
          onClick={minify}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!parsed?.ok}
          className="px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border disabled:opacity-40"
        >
          Minify
        </button>
      </div>

      {/* Corpo: editor ou árvore */}
      {view === "text" ? (
        <textarea
          value={text}
          onChange={(e) => { setText(e.target.value); patchNode(id, { text: e.target.value }); }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder='{ "cole": "seu json aqui" }'
          className="nodrag flex-1 px-2 py-1.5 text-[11px] bg-bg text-text resize-none focus:outline-none font-mono placeholder:text-textMuted"
        />
      ) : (
        <div className="flex-1 overflow-auto bg-bg nodrag px-1.5 py-1.5 text-[11px] font-mono" onPointerDown={(e) => e.stopPropagation()}>
          {parsed?.ok ? (
            <TreeNode k={null} value={parsed.value} depth={0} />
          ) : (
            <p className="text-textMuted opacity-50">JSON inválido — corrija no modo Texto.</p>
          )}
        </div>
      )}

      {/* Rodapé de erro */}
      {parsed && !parsed.ok && view === "text" && (
        <p className="shrink-0 px-2 py-1 text-[10px] text-danger border-t border-border bg-bg break-words">{parsed.error}</p>
      )}
    </div>
  );
}
