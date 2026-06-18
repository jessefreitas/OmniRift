import { useEffect, useMemo, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { invoke } from "@tauri-apps/api/core";
import { Terminal, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { useT } from "@/lib/i18n";
import { NodeHelp } from "@/components/NodeHelp";
import { cn } from "@/lib/cn";
import { explainShell, type SegKind } from "@/lib/shell-explain";
import type { ExplainNode as ExplainNodeData } from "@/types/canvas";

type ExplainRfNode = Node<ExplainNodeData & Record<string, unknown>, "explain">;

const KIND_STYLE: Record<SegKind, string> = {
  command: "bg-brand/20 text-brand border-brand/40",
  flag: "bg-yellow-400/15 text-yellow-300 border-yellow-400/30",
  operator: "bg-purple-400/15 text-purple-300 border-purple-400/30",
  argument: "bg-surface2 text-text border-border",
  string: "bg-green-400/15 text-green-300 border-green-400/30",
};

const KIND_LABEL: Record<SegKind, string> = {
  command: "comando",
  flag: "flag",
  operator: "operador",
  argument: "argumento",
  string: "string",
};

export function ExplainShellNode({ id, data, selected }: NodeProps<ExplainRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [command, setCommand] = useState(data.command || "");
  /** Descrições do man-db por comando (whatis). */
  const [whatis, setWhatis] = useState<Record<string, string>>({});

  const segments = useMemo(() => explainShell(command), [command]);
  const { maxBtn, frame } = useNodeMaximize();

  // Busca a descrição real (man-db) de cada comando único presente.
  useEffect(() => {
    const cmds = [...new Set(segments.filter((s) => s.kind === "command" && s.command).map((s) => s.command!))];
    cmds.forEach((c) => {
      if (c in whatis) return;
      void invoke<string>("whatis_lookup", { name: c })
        .then((desc) => setWhatis((w) => ({ ...w, [c]: desc })))
        .catch(() => setWhatis((w) => ({ ...w, [c]: "" })));
    });
  }, [segments, whatis]);

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Terminal size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">explainshell</span>
        <NodeHelp text={t("explain.help", "Explica um comando shell: digite acima e cada parte (comando, flag, argumento, operador) é colorida e descrita com o man-db real do sistema.")} />
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("common.close", "Fechar")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      {/* Comando a explicar */}
      <input
        value={command}
        onChange={(e) => { setCommand(e.target.value); patchNode(id, { command: e.target.value }); }}
        onPointerDown={(e) => e.stopPropagation()}
        placeholder={t("explain.placeholder", "tar -xzvf bundle.tar.gz | grep -i erro")}
        className="nodrag shrink-0 px-2 py-2 text-[12px] bg-bg border-b border-border text-text focus:outline-none font-mono placeholder:text-textMuted"
      />

      {/* Comando colorido por segmento */}
      <div className="shrink-0 flex flex-wrap items-center gap-1 px-2 py-2 border-b border-border nodrag" onPointerDown={(e) => e.stopPropagation()}>
        {segments.length === 0 ? (
          <span className="text-[10px] text-textMuted opacity-50">{t("explain.typeAbove", "Digite um comando acima.")}</span>
        ) : (
          segments.map((s, i) => (
            <span key={i} className={cn("px-1.5 py-0.5 rounded border text-[11px] font-mono", KIND_STYLE[s.kind])}>
              {s.text}
            </span>
          ))
        )}
      </div>

      {/* Explicações segmento a segmento */}
      <div className="flex-1 overflow-auto bg-bg nodrag" onPointerDown={(e) => e.stopPropagation()}>
        {segments.map((s, i) => {
          const desc =
            s.kind === "command"
              ? (whatis[s.command ?? ""] || t("explain.commandFallback", "comando / binário executado"))
              : s.explanation;
          return (
            <div key={i} className="flex gap-2 px-2 py-1.5 border-b border-border/50 items-start">
              <span className={cn("shrink-0 px-1.5 py-0.5 rounded border text-[11px] font-mono", KIND_STYLE[s.kind])}>
                {s.text}
              </span>
              <div className="min-w-0 flex-1">
                <span className="text-[9px] uppercase tracking-wide text-textMuted opacity-50">{KIND_LABEL[s.kind]}</span>
                <p className="text-[11px] text-text break-words leading-snug">{desc}</p>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );

  return frame(
    card,
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 460, height: data.size?.height ?? 360 }}
    >
      <NodeResizer isVisible={selected} minWidth={320} minHeight={240} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>,
  );
}
