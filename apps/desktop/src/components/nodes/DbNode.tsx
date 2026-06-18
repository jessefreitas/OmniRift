import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { open } from "@tauri-apps/plugin-dialog";
import { Database, FolderOpen, Maximize2, Minimize2, Play, RefreshCw, Table2, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { NodeHelp } from "@/components/NodeHelp";
import { dbQuery, type QueryResult } from "@/lib/db-query-client";
import { cn } from "@/lib/cn";
import type { DbNode as DbNodeData } from "@/types/canvas";

type DbRfNode = Node<DbNodeData & Record<string, unknown>, "db">;

/** Nome curto do arquivo pra exibir no header sem o caminho inteiro. */
function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function DbNode({ id, data, selected }: NodeProps<DbRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [dbPath, setDbPath] = useState(data.dbPath);
  const [sql, setSql] = useState(data.sql || "");
  const [result, setResult] = useState<QueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tables, setTables] = useState<string[]>([]);
  const [activeTable, setActiveTable] = useState<string | null>(null);
  const [maximized, setMaximized] = useState(false);

  async function loadTables(p = dbPath) {
    if (!p.trim()) { setTables([]); return; }
    try {
      const r = await dbQuery(
        p.trim(),
        "SELECT name FROM sqlite_master WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
      );
      setTables(r.rows.map((row) => row[0]));
    } catch {
      setTables([]);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void loadTables(); }, [dbPath]);

  async function pickFile() {
    const sel = await open({
      directory: false,
      multiple: false,
      title: t("db.pickTitle", "Selecionar banco SQLite"),
      filters: [{ name: "SQLite", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
    });
    if (typeof sel === "string") { setDbPath(sel); patchNode(id, { dbPath: sel }); }
  }

  async function runSql(q = sql, p = dbPath) {
    const pp = p.trim();
    const qq = q.trim();
    if (!pp || !qq) return;
    patchNode(id, { dbPath: pp, sql: q });
    setLoading(true);
    setError(null);
    try {
      setResult(await dbQuery(pp, qq));
    } catch (e) {
      setError(String(e));
      setResult(null);
    } finally {
      setLoading(false);
    }
  }

  function openTable(t: string) {
    setActiveTable(t);
    const q = `SELECT * FROM "${t}" LIMIT 200`;
    setSql(q);
    void runSql(q);
  }

  const resultPane = error ? (
    <p className="px-2 py-2 text-[11px] text-danger whitespace-pre-wrap break-words font-mono">{error}</p>
  ) : result ? (
    result.affected !== null ? (
      <div className="px-2 py-2 text-[11px] text-text">
        <span className="text-green-400 font-medium">{result.affected}</span> {t("db.rowsAffected", "linha(s) afetada(s)")}
        <span className="text-textMuted opacity-60 ml-2">{result.durationMs}ms</span>
      </div>
    ) : (
      <>
        <div className="flex items-center gap-2 px-2 py-1 border-b border-border text-[10px] sticky top-0 bg-surface1 z-10">
          <span className="text-text font-medium">{result.rowCount} {t("db.rows", "linha(s)")}</span>
          <span className="text-textMuted opacity-60">{result.columns.length} {t("db.columns", "coluna(s)")}</span>
          <span className="text-textMuted opacity-60">{result.durationMs}ms</span>
        </div>
        <table className="text-[11px] border-collapse w-full">
          <thead className="sticky top-[22px] bg-surface2">
            <tr>
              {result.columns.map((c, i) => (
                <th key={i} className="text-left px-2 py-1 border-b border-r border-border text-brand font-medium whitespace-nowrap">{c}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.rows.map((row, ri) => (
              <tr key={ri} className="even:bg-surface1/40">
                {row.map((cell, ci) => (
                  <td key={ci} className="px-2 py-1 border-b border-r border-border text-text align-top font-mono max-w-[280px] truncate" title={cell}>
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
      {t("db.emptyHint", "Clique numa tabela à esquerda, ou escreva uma query e rode (Ctrl+Enter).")}
    </p>
  );

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <Database size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">{dbPath ? baseName(dbPath) : "SQLite"}</span>
        <button onClick={(e) => { e.stopPropagation(); void loadTables(); }} title={t("db.reloadTables", "Recarregar tabelas")} className="hover:text-brand shrink-0"><RefreshCw size={11} /></button>
        <NodeHelp text={t("db.help", "Banco SQLite: Abra um arquivo .db, clique numa tabela na lateral pra ver as linhas, ou escreva SQL e rode com Ctrl+Enter (▶). ⟳ recarrega as tabelas.")} />
        <button onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }} title={maximized ? t("common.restore", "Restaurar") : t("common.maximize", "Maximizar")} className="hover:text-brand shrink-0">{maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}</button>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("common.close", "Fechar")} className="hover:text-danger shrink-0"><X size={12} /></button>
      </header>

      {/* Seleção do arquivo */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-border nodrag">
        <button onClick={() => void pickFile()} onPointerDown={(e) => e.stopPropagation()} title={t("db.openFile", "Abrir arquivo .sqlite")} className="shrink-0 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-surface2 text-text hover:bg-bg border border-border transition-colors">
          <FolderOpen size={11} /> {t("common.open", "Abrir")}
        </button>
        <input value={dbPath} onChange={(e) => setDbPath(e.target.value)} onBlur={() => patchNode(id, { dbPath })} onPointerDown={(e) => e.stopPropagation()} placeholder={t("db.pathPlaceholder", "/caminho/para/app.db")} className="flex-1 min-w-0 px-1.5 py-1 rounded text-[11px] bg-bg border border-border text-text placeholder:text-textMuted focus:outline-none focus:border-brand font-mono" />
      </div>

      {/* Corpo: sidebar de tabelas + (editor SQL + resultado) */}
      <div className="flex-1 flex min-h-0">
        <div className="w-40 shrink-0 border-r border-border bg-surface1 overflow-auto nodrag" onPointerDown={(e) => e.stopPropagation()}>
          <div className="px-2 py-1 text-[9px] uppercase tracking-wider text-textMuted border-b border-border sticky top-0 bg-surface1">{t("db.tables", "Tabelas")} ({tables.length})</div>
          {tables.length === 0 ? (
            <p className="px-2 py-2 text-[10px] text-textMuted opacity-50">{dbPath ? t("db.noTables", "sem tabelas") : t("db.openADb", "abra um .db")}</p>
          ) : (
            tables.map((t) => (
              <button key={t} onClick={() => openTable(t)} title={t} className={cn("w-full text-left flex items-center gap-1.5 px-2 py-1 text-[11px] hover:bg-surface2 truncate", activeTable === t ? "text-brand bg-surface2" : "text-text")}>
                <Table2 size={10} className="shrink-0 opacity-60" /> <span className="truncate">{t}</span>
              </button>
            ))
          )}
        </div>

        <div className="flex-1 flex flex-col min-w-0">
          <div className="relative shrink-0 border-b border-border">
            <textarea
              value={sql}
              onChange={(e) => setSql(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void runSql(); } e.stopPropagation(); }}
              onPointerDown={(e) => e.stopPropagation()}
              placeholder={t("db.sqlPlaceholder", "SELECT * FROM ...  (Ctrl+Enter pra rodar)")}
              className={cn("nodrag w-full px-2 py-1.5 text-[11px] bg-bg text-text resize-none focus:outline-none font-mono placeholder:text-textMuted", maximized ? "h-28" : "h-16")}
            />
            <button onClick={() => void runSql()} disabled={loading || !dbPath.trim() || !sql.trim()} title={t("db.runTitle", "Rodar (Ctrl+Enter)")} className="absolute bottom-1.5 right-1.5 flex items-center gap-1 px-2 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 disabled:cursor-not-allowed transition-colors">
              <Play size={11} /> {loading ? "…" : t("db.run", "Run")}
            </button>
          </div>
          <div className="flex-1 overflow-auto bg-bg nodrag" onPointerDown={(e) => e.stopPropagation()}>{resultPane}</div>
        </div>
      </div>
    </>
  );

  if (maximized) {
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => setMaximized(false)}>
        <div className="w-[85vw] h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          {card}
        </div>
      </div>,
      document.body,
    );
  }

  return (
    <div className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden" style={{ width: data.size?.width ?? 560, height: data.size?.height ?? 420 }}>
      <NodeResizer isVisible={selected} minWidth={420} minHeight={300} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>
  );
}
