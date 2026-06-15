import { useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { open } from "@tauri-apps/plugin-dialog";
import { Database, FolderOpen, Play, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { dbQuery, type QueryResult } from "@/lib/db-query-client";
import type { DbNode as DbNodeData } from "@/types/canvas";

type DbRfNode = Node<DbNodeData & Record<string, unknown>, "db">;

/** Nome curto do arquivo pra exibir no header sem o caminho inteiro. */
function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function DbNode({ id, data, selected }: NodeProps<DbRfNode>) {
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [dbPath, setDbPath] = useState(data.dbPath);
  const [sql, setSql] = useState(data.sql || "");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function pickFile() {
    const selectedFile = await open({
      directory: false,
      multiple: false,
      title: "Selecionar banco SQLite",
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
    });
    if (typeof selectedFile === "string") {
      setDbPath(selectedFile);
      patchNode(id, { dbPath: selectedFile });
    }
  }

  async function run() {
    const p = dbPath.trim();
    const q = sql.trim();
    if (!p || !q) return;
    patchNode(id, { dbPath: p, sql });
    setLoading(true);
    setError(null);
    try {
      setResult(await dbQuery(p, q));
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 480, height: data.size?.height ?? 400 }}
    >
      <NodeResizer isVisible={selected} minWidth={320} minHeight={260} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Database size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">
          {dbPath ? baseName(dbPath) : "SQLite"}
        </span>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      {/* Seleção do arquivo do banco */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border nodrag">
        <button
          onClick={() => void pickFile()}
          onPointerDown={(e) => e.stopPropagation()}
          title="Abrir arquivo .sqlite"
          className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border transition-colors"
        >
          <FolderOpen size={11} /> Abrir
        </button>
        <input
          value={dbPath}
          onChange={(e) => setDbPath(e.target.value)}
          onBlur={() => patchNode(id, { dbPath })}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="/caminho/para/app.db"
          className="flex-1 min-w-0 px-1.5 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono"
        />
      </div>

      {/* Editor de SQL */}
      <div className="relative shrink-0 border-b border-border">
        <textarea
          value={sql}
          onChange={(e) => setSql(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void run(); }
            e.stopPropagation();
          }}
          onPointerDown={(e) => e.stopPropagation()}
          placeholder="SELECT * FROM ...  (Ctrl+Enter pra rodar)"
          className="nodrag w-full h-20 px-2 py-1.5 text-[11px] bg-bg text-text resize-none focus:outline-none font-mono placeholder:text-textMuted"
        />
        <button
          onClick={() => void run()}
          disabled={loading || !dbPath.trim() || !sql.trim()}
          title="Rodar (Ctrl+Enter)"
          className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
        >
          <Play size={11} /> {loading ? "…" : "Run"}
        </button>
      </div>

      {/* Resultado */}
      <div className="flex-1 overflow-auto bg-bg nodrag" onPointerDown={(e) => e.stopPropagation()}>
        {error ? (
          <p className="px-2 py-2 text-[11px] text-danger whitespace-pre-wrap break-words font-mono">{error}</p>
        ) : result ? (
          result.affected !== null ? (
            <div className="px-2 py-2 text-[11px] text-text">
              <span className="text-green-400 font-medium">{result.affected}</span> linha(s) afetada(s)
              <span className="text-textMuted opacity-60 ml-2">{result.durationMs}ms</span>
            </div>
          ) : (
            <>
              <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-[10px] sticky top-0 bg-surface1 z-10">
                <span className="text-text font-medium">{result.rowCount} linha(s)</span>
                <span className="text-textMuted opacity-60">{result.columns.length} coluna(s)</span>
                <span className="text-textMuted opacity-60">{result.durationMs}ms</span>
              </div>
              <table className="text-[11px] border-collapse w-full">
                <thead className="sticky top-[22px] bg-surface2">
                  <tr>
                    {result.columns.map((c, i) => (
                      <th key={i} className="text-left px-2 py-1 border-b border-r border-border text-brand font-medium whitespace-nowrap">
                        {c}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, ri) => (
                    <tr key={ri} className="even:bg-surface1/40">
                      {row.map((cell, ci) => (
                        <td
                          key={ci}
                          className="px-2 py-1 border-b border-r border-border text-text align-top font-mono max-w-[280px] truncate"
                          title={cell}
                        >
                          {cell === "NULL" ? <span className="text-textMuted opacity-50 italic">NULL</span> : cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )
        ) : (
          <p className="px-2 py-2 text-[10px] text-textMuted opacity-50">
            Abra um .sqlite e rode uma query. SELECT/PRAGMA mostram a tabela; INSERT/UPDATE/DELETE mostram linhas afetadas.
          </p>
        )}
      </div>
    </div>
  );
}
