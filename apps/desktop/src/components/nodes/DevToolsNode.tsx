import { useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Copy, Play, Wrench, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { DEV_TOOLS, findTool } from "@/lib/dev-tools";
import type { DevToolsNode as DevToolsNodeData } from "@/types/canvas";

type DevRfNode = Node<DevToolsNodeData & Record<string, unknown>, "devtools">;

export function DevToolsNode({ id, data, selected }: NodeProps<DevRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [toolId, setToolId] = useState(data.tool || "b64enc");
  const [input, setInput] = useState(data.input || "");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const tool = findTool(toolId);

  async function run() {
    setError(null);
    try {
      setOutput(await tool.run(input));
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setOutput("");
    }
  }

  function copy() {
    if (!output) return;
    void navigator.clipboard.writeText(output);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 420, height: data.size?.height ?? 380 }}
    >
      <NodeResizer isVisible={selected} minWidth={300} minHeight={260} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Wrench size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">DevTools</span>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      {/* Seletor da ferramenta + Run */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border nodrag">
        <select
          value={toolId}
          onChange={(e) => { setToolId(e.target.value); patchNode(id, { tool: e.target.value }); setOutput(""); setError(null); }}
          onPointerDown={(e) => e.stopPropagation()}
          className="flex-1 min-w-0 px-1 py-1 rounded text-[11px] font-medium bg-bg border border-border text-text focus:outline-none focus:border-brand"
        >
          {DEV_TOOLS.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <button
          onClick={() => void run()}
          title="Rodar"
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover transition-colors"
        >
          <Play size={11} /> Run
        </button>
      </div>

      {/* Input */}
      <textarea
        value={input}
        onChange={(e) => { setInput(e.target.value); patchNode(id, { input: e.target.value }); }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); }
          e.stopPropagation();
        }}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder={tool.hint}
        className="nodrag h-24 shrink-0 px-2 py-1.5 text-[11px] bg-bg border-b border-border text-text resize-none focus:outline-none font-mono placeholder:text-textMuted"
      />

      {/* Output */}
      <div className="flex-1 overflow-auto bg-bg nodrag relative" onPointerDown={(e) => e.stopPropagation()}>
        {output && (
          <button
            onClick={copy}
            title="Copiar"
            className="absolute top-1 right-1 z-10 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] bg-surface2 text-textMuted hover:text-brand border border-border"
          >
            <Copy size={10} /> {copied ? "copiado" : "copiar"}
          </button>
        )}
        {error ? (
          <p className="px-2 py-2 text-[11px] text-danger whitespace-pre-wrap break-words font-mono">{error}</p>
        ) : output ? (
          <pre className="px-2 py-1.5 text-[11px] text-text whitespace-pre-wrap break-all font-mono">{output}</pre>
        ) : (
          <p className="px-2 py-2 text-[10px] text-textMuted opacity-50">
            Saída aparece aqui. Ctrl+Enter ou Run pra converter.
          </p>
        )}
      </div>
    </div>
  );
}
