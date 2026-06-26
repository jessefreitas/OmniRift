// src/components/nodes/CodeNode.tsx
//
// CodeNode (Fase 9, editor-first): abre um arquivo num editor Monaco dentro do
// canvas. Lê/salva/observa via comandos Rust (code-client). O Monaco é lazy
// (chunk separado). Métricas de complexidade entram na sub-fase 9c.

import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { NodeResizer, type Node, type NodeProps } from "@xyflow/react";
import { Bug, FileCode2, Maximize2, Minimize2, Save, Send, X } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { NodeHelp } from "@/components/NodeHelp";
import { NodeComment } from "@/components/NodeComment";
import { codeMetrics, codeOpen, codeSave, codeUnwatch, codeWatch, onCodeChanged } from "@/lib/code-client";
import { spawnDebuggerAgent } from "@/lib/agent-debug";
import { ptyWrite } from "@/lib/pty-client";
import { loadThresholds, levelFor, type ThresholdLevel } from "@/lib/code-thresholds";
import { CodeComplexityPanel } from "@/components/nodes/CodeComplexityPanel";
import type { CodeMonacoHandle } from "@/components/nodes/CodeMonaco";
import type { CodeNode as CodeNodeData } from "@/types/canvas";
import type { CodeMetrics, FunctionMetrics } from "@/types/code";

const CodeMonaco = lazy(() => import("@/components/nodes/CodeMonaco"));

type CodeRfNode = Node<CodeNodeData & Record<string, unknown>, "code">;

const CX_BADGE_CLASS: Record<ThresholdLevel, string> = {
  ok: "border-emerald-500/40 bg-emerald-500/10 text-emerald-400",
  warn: "border-yellow-500/40 bg-yellow-500/10 text-yellow-400",
  high: "border-red-500/40 bg-red-500/10 text-red-400",
};

/** Função com a pior (maior) ciclomática do arquivo. */
function worstFunction(m: CodeMetrics): FunctionMetrics | null {
  return m.functions.reduce<FunctionMetrics | null>(
    (worst, f) => (worst == null || f.cyclomatic > worst.cyclomatic ? f : worst),
    null,
  );
}

export function CodeNode({ id, data, selected }: NodeProps<CodeRfNode>) {
  const t = useT();
  const removeNode = useCanvasStore((s) => s.removeNode);
  const patchNode = useCanvasStore((s) => s.patchNode);
  const setFileDirty = useCanvasStore((s) => s.setFileDirty);
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

  /** Manda pro input do agente: a SELEÇÃO (se houver) ou o caminho do arquivo
   *  (Claude usa @, anexa o arquivo). */
  function sendToAgent(sid: string, role: string) {
    const payload =
      pendingSelection != null
        ? pendingSelection
        : role === "claude-code"
          ? `@${filePath} `
          : `${filePath} `;
    void ptyWrite(sid, payload);
    setShowSend(false);
    setPendingSelection(null);
  }

  // Aberto pelo menu nativo do Monaco ("Enviar seleção") — guarda o trecho e abre
  // o seletor de agentes. Estável (refs/setters) p/ a ação capturada no mount do Monaco.
  const onSendSelection = useCallback((text: string) => {
    setPendingSelection(text);
    setShowSend(true);
  }, []);

  const [source, setSource] = useState("");
  const [language, setLanguage] = useState("plaintext");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [maximized, setMaximized] = useState(false);
  // handles de resize aparecem ao selecionar OU passar o mouse (descobribilidade)
  const [hovered, setHovered] = useState(false);
  const [showSend, setShowSend] = useState(false);
  const [pendingSelection, setPendingSelection] = useState<string | null>(null);
  const [debugging, setDebugging] = useState(false);
  // Métricas de complexidade (9c). `null` = ainda não calculado ou linguagem sem grammar.
  const [metrics, setMetrics] = useState<CodeMetrics | null>(null);
  // Painel de complexidade (9e) + thresholds configuráveis (cor por nível).
  const [showComplexity, setShowComplexity] = useState(false);
  const [thresholds, setThresholds] = useState(() => loadThresholds());
  // Handle imperativo do Monaco — pra pular pra linha de uma função no painel.
  const monacoRef = useRef<CodeMonacoHandle | null>(null);

  // Recarrega thresholds quando o painel abre (pega edições feitas em outro lugar).
  useEffect(() => {
    if (showComplexity) setThresholds(loadThresholds());
  }, [showComplexity]);

  const onJumpToLine = useCallback((line: number) => {
    monacoRef.current?.revealLine(line);
    setShowComplexity(false);
  }, []);

  // Spawna o DebuggerAgent (sub-fase 9d) pelo caminho único de `agent-debug.ts`
  // (reusado também pelo Painel de Complexidade 9e). Degrada sozinho se o
  // debug_request falhar — o agente ainda nasce memory/Serena-aware.
  const onDebug = useCallback(async () => {
    if (debugging) return;
    setDebugging(true);
    try {
      await spawnDebuggerAgent(filePath, { selection: pendingSelection ?? undefined });
      setPendingSelection(null);
    } finally {
      setDebugging(false);
    }
  }, [debugging, filePath, pendingSelection]);

  // Recalcula as métricas a partir do arquivo em disco. Linguagem sem grammar
  // (ex.: .md/.json) ou erro → some o badge (não polui a UI nem é fatal).
  const refreshMetrics = useCallback(() => {
    codeMetrics(filePath)
      .then(setMetrics)
      .catch(() => setMetrics(null));
  }, [filePath]);

  // Refs pra o Ctrl+S do Monaco (capturado 1x no mount) enxergar o estado atual.
  const sourceRef = useRef(source);
  sourceRef.current = source;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;

  const refreshMetricsRef = useRef(refreshMetrics);
  refreshMetricsRef.current = refreshMetrics;

  const save = useCallback(async () => {
    try {
      await codeSave(filePath, sourceRef.current);
      setDirty(false);
      refreshMetricsRef.current(); // recalcula o badge com o conteúdo salvo
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
        refreshMetricsRef.current(); // métricas iniciais (e a cada reload do disco)
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

  // Espelha o estado "não salvo" no store (pro aviso ao encerrar o projeto) e
  // limpa ao desmontar.
  useEffect(() => {
    setFileDirty(id, dirty);
    return () => setFileDirty(id, false);
  }, [id, dirty, setFileDirty]);

  // Badge de complexidade (cx N) — pior ciclomática do arquivo + tooltip. Clicável:
  // abre o painel de complexidade (9e). A cor deriva dos thresholds configuráveis.
  const cxBadge = (() => {
    if (!metrics || metrics.functions.length === 0) return null;
    const worst = worstFunction(metrics);
    if (!worst) return null;
    const level = levelFor(thresholds, "cyclomatic", metrics.maxCyclomatic, metrics.language);
    const tip =
      `${t("code.complexity", "complexidade")} — ${t("code.worst", "pior")}: ` +
      `${worst.name} (${t("code.line", "linha")} ${worst.startLine}) ` +
      `· cx ${worst.cyclomatic} · cog ${worst.cognitive} · MI ${Math.round(worst.maintainabilityIndex)} — ` +
      t("code.openComplexityPanel", "clique p/ ver todas as funções");
    return (
      <div className="relative shrink-0">
        <button
          title={tip}
          onClick={(e) => { e.stopPropagation(); setShowComplexity((s) => !s); }}
          onPointerDown={(e) => e.stopPropagation()}
          className={`rounded px-1 py-0.5 text-[9px] font-mono leading-none border transition-colors hover:brightness-125 ${CX_BADGE_CLASS[level]}`}
        >
          cx {metrics.maxCyclomatic}
        </button>
        {showComplexity && (
          <CodeComplexityPanel
            metrics={metrics}
            thresholds={thresholds}
            onJump={onJumpToLine}
            onClose={() => setShowComplexity(false)}
          />
        )}
      </div>
    );
  })();

  const card = (
    <>
      <header className="node-drag-handle flex items-center gap-1.5 px-2 py-1.5 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <FileCode2 size={12} className="text-brand shrink-0" />
        <span className="text-xs font-medium truncate flex-1" title={filePath}>
          {fileName}
          {dirty && <span className="text-yellow-400" title={t("code.unsaved", "não salvo")}> ●</span>}
        </span>
        {cxBadge}
        <NodeHelp text={t("code.help", "Editor de código (Monaco). Edite e salve com 💾 ou Ctrl/Cmd+S. Recarrega sozinho se o arquivo mudar no disco (sem edição pendente). O ✈ envia o caminho deste arquivo pro input de um agente aberto (Claude usa @, anexa o arquivo). Métricas chegam na próxima fase.")} />
        <div className="relative shrink-0">
          <button
            onClick={(e) => { e.stopPropagation(); setPendingSelection(null); setShowSend((s) => !s); }}
            onPointerDown={(e) => e.stopPropagation()}
            title={t("code.sendFileToAgent", "Enviar este arquivo para um agente")}
            className="hover:text-brand"
          >
            <Send size={12} />
          </button>
          {showSend && (
            <>
              <div className="fixed inset-0 z-[60]" onPointerDown={(e) => { e.stopPropagation(); setShowSend(false); setPendingSelection(null); }} />
              <div
                className="absolute right-0 top-5 z-[61] w-56 rounded-md border border-border bg-surface1 shadow-xl py-1"
                onPointerDown={(e) => e.stopPropagation()}
              >
                <div className="px-2 py-1 text-[10px] uppercase tracking-wide text-textMuted">
                  {pendingSelection != null
                    ? `${t("code.sendSelection", "Enviar seleção")} (${pendingSelection.split("\n").length} ${pendingSelection.split("\n").length > 1 ? t("code.lines", "linhas") : t("code.line", "linha")}) ${t("code.toShort", "p/")}`
                    : t("code.sendToAgent", "Enviar p/ agente")}
                </div>
                {agentTerminals.length === 0 ? (
                  <div className="px-2 py-1.5 text-[11px] text-textMuted opacity-60">{t("code.noAgentOpen", "Nenhum agente aberto — abra um em \"Novo agente\".")}</div>
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
          onClick={(e) => { e.stopPropagation(); void onDebug(); }}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={debugging}
          title={t("code.debug", "Debugar com IA (DebuggerAgent: Serena + memória + métricas)")}
          className="hover:text-brand shrink-0 disabled:opacity-30"
        >
          <Bug size={12} />
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onSave(); }}
          disabled={!dirty || saving}
          title={t("code.save", "Salvar (Ctrl/Cmd+S)")}
          className="hover:text-brand shrink-0 disabled:opacity-30"
        >
          <Save size={12} />
        </button>
        <button onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }} title={maximized ? t("common.restore", "Restaurar") : t("common.maximize", "Maximizar")} className="hover:text-brand shrink-0">
          {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
        </button>
        <button onClick={(e) => { e.stopPropagation(); removeNode(id); }} title={t("common.close", "Fechar")} className="hover:text-danger shrink-0">
          <X size={12} />
        </button>
      </header>

      <div className="flex-1 min-h-0 bg-[#1e1e1e] nodrag nowheel" onPointerDown={(e) => e.stopPropagation()}>
        {error ? (
          <p className="px-3 py-2 text-[11px] text-danger font-mono whitespace-pre-wrap">{error}</p>
        ) : loading ? (
          <p className="px-3 py-2 text-[11px] text-textMuted">{t("code.opening", "abrindo")} {fileName}…</p>
        ) : (
          <Suspense fallback={<p className="px-3 py-2 text-[11px] text-textMuted">{t("code.loadingEditor", "carregando editor…")}</p>}>
            <CodeMonaco
              value={source}
              language={language}
              onChange={onEdit}
              onSave={onSave}
              onSendSelection={onSendSelection}
              metrics={metrics}
              thresholds={thresholds}
              onReady={(h) => { monacoRef.current = h; }}
            />
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
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      className="flex flex-col rounded-lg border border-border bg-surface1 shadow-lg overflow-hidden"
      style={{ width: data.size?.width ?? 800, height: data.size?.height ?? 560 }}
    >
      <NodeResizer isVisible={selected || hovered} minWidth={420} minHeight={300} color="rgb(96 165 250)" handleStyle={{ width: 8, height: 8, borderRadius: 2 }} />
      {card}
    </div>
  );
}
