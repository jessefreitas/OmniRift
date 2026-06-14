import { useCallback, useEffect, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import {
  ChevronDown,
  ChevronRight,
  Eye,
  EyeOff,
  File as FileIcon,
  Folder,
  FolderOpen,
  RefreshCw,
  X,
} from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { listDir, type DirEntry } from "@/lib/fs-client";
import type { FileTreeNode as FileTreeNodeData } from "@/types/canvas";

type FileTreeRfNode = Node<FileTreeNodeData & Record<string, unknown>, "filetree">;

const isVisible = (showHidden: boolean) => (e: DirEntry) => showHidden || !e.name.startsWith(".");

/** Item recursivo: pasta expande sob demanda (lazy) e cacheia os filhos. */
function TreeItem({ entry, depth, showHidden }: { entry: DirEntry; depth: number; showHidden: boolean }) {
  const [open, setOpen] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  const toggle = useCallback(async () => {
    if (!entry.isDir) return;
    if (children === null) {
      try { setChildren(await listDir(entry.path)); } catch { setChildren([]); }
    }
    setOpen((o) => !o);
  }, [entry, children]);

  return (
    <div>
      <div
        onClick={toggle}
        draggable
        onDragStart={(e) => {
          // Arrasta o caminho do arquivo/pasta — solta num terminal pra inserir.
          e.dataTransfer.setData("application/x-maestri-path", entry.path);
          e.dataTransfer.setData("text/plain", entry.path);
          e.dataTransfer.effectAllowed = "copy";
          e.stopPropagation();
        }}
        style={{ paddingLeft: 4 + depth * 12 }}
        className="flex items-center gap-1 py-0.5 pr-2 text-[11px] text-textMuted hover:bg-surface2 hover:text-text cursor-grab active:cursor-grabbing rounded select-none"
      >
        {entry.isDir ? (
          open ? <ChevronDown size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />
        ) : (
          <span className="w-2.5 shrink-0" />
        )}
        {entry.isDir ? (
          open ? <FolderOpen size={11} className="text-brand shrink-0" /> : <Folder size={11} className="text-brand shrink-0" />
        ) : (
          <FileIcon size={11} className="opacity-60 shrink-0" />
        )}
        <span className="truncate">{entry.name}</span>
      </div>
      {open &&
        children?.filter(isVisible(showHidden)).map((c) => (
          <TreeItem key={c.path} entry={c} depth={depth + 1} showHidden={showHidden} />
        ))}
    </div>
  );
}

export function FileTreeNode({ id, data, selected }: NodeProps<FileTreeRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [roots, setRoots] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const load = useCallback(() => {
    if (!data.rootPath) { setError("sem pasta — abra um projeto"); return; }
    listDir(data.rootPath).then((r) => { setRoots(r); setError(null); }).catch((e) => setError(String(e)));
  }, [data.rootPath]);

  useEffect(() => { load(); }, [load]);

  const rootName = data.rootPath ? (data.rootPath.split("/").filter(Boolean).pop() ?? data.rootPath) : "—";

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 280, height: data.size?.height ?? 360 }}
    >
      <NodeResizer isVisible={selected} minWidth={180} minHeight={160} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Folder size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1" title={data.rootPath}>{rootName}</span>
        <button onClick={(e) => { e.stopPropagation(); setShowHidden((h) => !h); }} title={showHidden ? "Esconder ocultos" : "Mostrar ocultos"} className="hover:text-text shrink-0">
          {showHidden ? <Eye size={11} /> : <EyeOff size={11} />}
        </button>
        <button onClick={(e) => { e.stopPropagation(); load(); }} title="Recarregar" className="hover:text-text shrink-0">
          <RefreshCw size={11} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>
      <div className="flex-1 overflow-auto py-1" onPointerDown={(e) => e.stopPropagation()}>
        {error ? (
          <p className="px-2 text-[10px] text-danger">{error}</p>
        ) : roots === null ? (
          <p className="px-2 text-[10px] text-textMuted opacity-60">carregando…</p>
        ) : (
          roots.filter(isVisible(showHidden)).map((e) => (
            <TreeItem key={e.path} entry={e} depth={0} showHidden={showHidden} />
          ))
        )}
      </div>
    </div>
  );
}
