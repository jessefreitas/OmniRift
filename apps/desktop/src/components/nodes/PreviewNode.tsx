import { useEffect, useState } from "react";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, FileText, FolderOpen, Pencil, RefreshCw, Save, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useNodeMaximize } from "@/hooks/useNodeMaximize";
import { useT } from "@/lib/i18n";
import { NodeHelp } from "@/components/NodeHelp";
import { NodeComment } from "@/components/NodeComment";
import { NodeResizeGrip } from "@/components/NodeResizeGrip";
import { readFile, writeFile, renderMarkdown, isMarkdown, isHtml } from "@/lib/preview-client";
import type { PreviewNode as PreviewNodeData } from "@/types/canvas";

type PreviewRfNode = Node<PreviewNodeData & Record<string, unknown>, "preview">;

function baseName(p: string): string {
  const parts = p.split(/[/\\]/);
  return parts[parts.length - 1] || p;
}

export function PreviewNode({ id, data, selected }: NodeProps<PreviewRfNode>) {
  const t = useT();
  const patchNode = useCanvasStore((s) => s.patchNode);
  const removeNode = useCanvasStore((s) => s.removeNode);
  const [path, setPath] = useState(data.path);
  const [content, setContent] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const { maxBtn, frame } = useNodeMaximize();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saved, setSaved] = useState(false);

  function startEdit() { setDraft(content); setEditing(true); }
  async function save() {
    if (!path) return;
    try {
      await writeFile(path, draft);
      setContent(draft);
      setEditing(false);
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
    } catch (e) {
      setError(String(e));
    }
  }

  async function load(p = path) {
    if (!p) return;
    setLoading(true);
    setError(null);
    try {
      setContent(await readFile(p));
    } catch (e) {
      setError(String(e));
      setContent("");
    } finally {
      setLoading(false);
    }
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { void load(); }, [path]);

  async function pickFile() {
    const sel = await open({
      directory: false,
      multiple: false,
      title: t("preview.pickTitle", "Abrir arquivo pra preview"),
      filters: [{ name: "MD / HTML", extensions: ["md", "markdown", "mdx", "html", "htm"] }],
    });
    if (typeof sel === "string") {
      setPath(sel);
      patchNode(id, { path: sel });
    }
  }

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <FileText size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1">{path ? baseName(path) : t("preview.title", "Preview")}</span>
        <button onClick={(e) => { e.stopPropagation(); void pickFile(); }} title={t("preview.openFile", "Abrir arquivo")} className="hover:text-brand shrink-0"><FolderOpen size={12} /></button>
        <button onClick={(e) => { e.stopPropagation(); void load(); }} title={t("preview.reload", "Recarregar")} className="hover:text-text shrink-0"><RefreshCw size={11} className={loading ? "animate-spin" : ""} /></button>
        {path && !editing && (
          <button onClick={(e) => { e.stopPropagation(); startEdit(); }} title={t("preview.edit", "Editar")} className="hover:text-brand shrink-0">{saved ? <Check size={12} className="text-emerald-400" /> : <Pencil size={12} />}</button>
        )}
        {editing && (
          <>
            <button onClick={(e) => { e.stopPropagation(); void save(); }} title={t("preview.save", "Salvar (grava no disco)")} className="hover:text-emerald-400 shrink-0"><Save size={12} /></button>
            <button onClick={(e) => { e.stopPropagation(); setEditing(false); }} title={t("preview.cancelEdit", "Cancelar edição")} className="hover:text-danger shrink-0"><X size={12} /></button>
          </>
        )}
        <NodeHelp text={t("preview.help", "Preview de .md/.html: a pasta abre um arquivo; ✎ edita e 💾 grava no disco; ⟳ recarrega. Renderiza Markdown e HTML (sem rodar scripts).")} />
        {maxBtn}
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("common.close", "Fechar")} className="hover:text-danger shrink-0"><X size={12} /></button>
      </header>

      <div className="flex-1 overflow-auto bg-bg nodrag" onPointerDown={(e) => e.stopPropagation()}>
        {editing ? (
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            spellCheck={false}
            className="w-full h-full px-3 py-2 bg-bg text-text text-[12px] font-mono resize-none focus:outline-none border-0 block"
          />
        ) : !path ? (
          <div className="flex flex-col items-center justify-center h-full gap-2 p-4 text-center">
            <p className="text-[11px] text-textMuted opacity-60">{t("preview.emptyPre", "Abra um arquivo")} <code>.md</code> {t("preview.emptyOr", "ou")} <code>.html</code> {t("preview.emptyPost", "pra visualizar.")}</p>
            <button onClick={() => void pickFile()} className="flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover"><FolderOpen size={12} /> {t("common.open", "Abrir")}</button>
          </div>
        ) : error ? (
          <p className="px-3 py-2 text-[11px] text-danger font-mono whitespace-pre-wrap break-words">{error}</p>
        ) : loading ? (
          <p className="px-3 py-2 text-[11px] text-textMuted">{t("common.loading", "Carregando…")}</p>
        ) : isHtml(path) ? (
          // HTML self-contained no iframe (sandbox sem scripts — só renderiza HTML+CSS).
          <iframe srcDoc={content} sandbox="" title={t("preview.iframeTitle", "preview")} className="w-full h-full border-0 bg-white" />
        ) : isMarkdown(path) ? (
          <div className="md-preview px-3 py-2 text-text text-[13px]" dangerouslySetInnerHTML={{ __html: renderMarkdown(content) }} />
        ) : (
          <pre className="px-3 py-2 text-[11px] text-text whitespace-pre-wrap break-words font-mono">{content}</pre>
        )}
      </div>
      <NodeComment value={data.comment} onChange={(v) => patchNode(id, { comment: v })} />
    </>
  );

  return frame(
    card,
    <div
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 520, height: data.size?.height ?? 460 }}
    >
      <NodeResizer isVisible={selected} minWidth={320} minHeight={280} color="rgb(41 162 167)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
      <NodeResizeGrip minWidth={320} minHeight={280} />
    </div>,
  );
}
