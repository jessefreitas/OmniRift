// src/components/nodes/CodeNode.tsx
//
// CodeNode (Fase 9, editor-first): abre um arquivo num editor Monaco dentro do
// canvas. Lê/salva/observa via comandos Rust (code-client). O Monaco é lazy
// (chunk separado). Métricas de complexidade entram na sub-fase 9c.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { FileCode2, Maximize2, Minimize2, Save, Send, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { NodeHelp } from "@/components/NodeHelp";
import { NodeComment } from "@/components/NodeComment";
import { codeOpen, codeSave, codeUnwatch, codeWatch, onCodeChanged } from "@/lib/code-client";
import { ptyWrite } from "@/lib/pty-client";
import type { CodeNode as CodeNodeData } from "@/types/canvas";

const CodeMonaco = lazy(() => import("@/components/nodes/CodeMonaco"));

type CodeRfNode = Node<CodeNodeData & Record<string, unknown>, "code">;

export function CodeNode({ id, data, selected }: NodeProps<CodeRfNode>) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const patchNode = useCanvasStore((s) => s.patchNode);
  const floors = useCanvasStore((s) => s.floors);
  const filePath = data.filePath;
  const fileName = filePath.split("/").pop() || filePath;

  // Agentes abertos no canvas (qualquer floor) — alvos pra "enviar arquivo".
  const agentTerminals = floors.flatMap((f) =>
    f.nodes.flatMap((n) =>
      n.kind === "terminal"
        ? [{ sid: n.session_id, label: n.label || n.role, role: n.role, floor: f.name }]
        : [],
    ),
  );

  /** Manda o caminho do arquivo pro input do agente (Claude usa @, anexa o arquivo). */
  function sendToAgent(sid: string, role: string) {
    const ref = role === "claude-code" ? `@${filePath} ` : `${filePath} `;
    void ptyWrite(sid, ref);
    setShowSend(false);
  }

  const [source, setSource] = useState("");
  const [language, setLanguage] = useState("plaintext");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [showSend, setShowSend] = useState(false);

  // Refs pra o Ctrl+S do Monaco (capturado 1x no mount) enxergar o estado atual.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const save = useCallback(async () => {
    try {
      await codeSave(filePath, sourceRef.current);
      setDirty(false);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }, [filePath]);
  const saveRef = useRef(save);
  saveRef.current = save;
  const onSave = useCallback(() => {
    setSaving(true);
    void saveRef.current();
  }, []);

  // Abre o arquivo; recarrega quando muda no disco SE não houver edição pendente.
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const o = await codeOpen(filePath);
        if (!alive) return;
        setSource(o.content);
        setLanguage(o.language);
        setDirty(false);
        setError(null);
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoading(false);
      }
    };
    void load();

    let unwatch: (() => void) | null = null;
    codeWatch(filePath).catch(() => {});
    void onCodeChanged((changed) => {
      if (changed === filePath && !dirtyRef.current) void load();
    }).then((un) => {
      if (alive) unwatch = un;
      else un();
    });

    return () => {
      alive = false;
      unwatch?.();
      codeUnwatch(filePath).catch(() => {});
    };
  }, [filePath]);

  const onEdit = (v: string) => {
    setSource(v);
    setDirty(true);
  };

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <FileCode2 size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1" title={filePath}>
          {fileName}
          {dirty && <span className="text-yellow-400" title="não salvo"> ●</span>}
        </span>
        <NodeHelp text="Editor de código (Monaco). Edite e salve com 💾 ou Ctrl/Cmd+S. Recarrega sozinho se o arquivo mudar no disco (sem edição pendente). O ✈ envia o caminho deste arquivo pro input de um agente aberto (Claude usa @, anexa o arquivo). Métricas chegam na próxima fase." />
        <div className="relative shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setShowSend((s) => !s); }}
            onPointerDown={(e) => e.stopPropagation()}
            title="Enviar este arquivo para um agente"
            className="hover:text-brand"
          >
            <Send size={12} />
          </button>
          {showSend && (
            <>
              <div className="fixed inset-0 z-[60]" onPointerDown={(e) => { e.stopPropagation(); setShowSend(false); }} />
              <div
                className="absolute right-0 top-5 z-[61] w-56 rounded-md border border-border bg-surface1 shadow-xl py-1"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-textMuted">Enviar p/ agente</div>
                {agentTerminals.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-textMuted opacity-60">Nenhum agente aberto — abra um em "Novo agente".</div>
                ) : (
                  agentTerminals.map((t) => (
                    <button
                      key={t.sid}
                      onClick={(e) => { e.stopPropagation(); sendToAgent(t.sid, t.role); }}
                      className="w-full text-left px-2 py-1.5 text-[11px] text-text hover:bg-surface2 flex items-center gap-2"
                    >
                      <Send size={11} className="text-textMuted shrink-0" />
                      <span className="truncate flex-1">{t.label}</span>
                      <span className="text-[9px] text-textMuted shrink-0">{t.floor}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>
        <button
          onClick={(e) => { e.stopPropagation(); onSave(); }}
          disabled={!dirty || saving}
          title="Salvar (Ctrl/Cmd+S)"
          className="hover:text-brand shrink-0 disabled:opacity-30"
        >
          <Save size={12} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }} title={maximized ? "Restaurar" : "Maximizar"} className="hover:text-brand shrink-0">
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title="Fechar" className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      <div className="flex-1 min-h-0 bg-[#1e1e1e] nodrag nowheel" onPointerDown={(e) => e.stopPropagation()}>
        {error ? (
          <p className="px-3 py-2 text-[11px] text-danger font-mono whitespace-pre-wrap">{error}</p>
        ) : loading ? (
          <p className="px-3 py-2 text-[11px] text-textMuted">abrindo {fileName}…</p>
        ) : (
          <Suspense fallback={<p className="px-3 py-2 text-[11px] text-textMuted">carregando editor…</p>}>
            <CodeMonaco value={source} language={language} onChange={onEdit} onSave={onSave} />
          </Suspense>
        )}
      </div>

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
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 800, height: data.size?.height ?? 560 }}
    >
      <NodeResizer isVisible={selected} minWidth={420} minHeight={300} color="rgb(96 165 250)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>
  );
}
