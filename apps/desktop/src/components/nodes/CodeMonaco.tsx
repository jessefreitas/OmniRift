// src/components/nodes/CodeMonaco.tsx
//
// O editor Monaco em si — isolado neste módulo pra ser carregado por dynamic
// import (lazy) lá no CodeNode. Assim o Monaco (pesado) cai num CHUNK separado,
// fora do bundle principal: só baixa quando um CodeNode aparece no canvas.

import { useEffect, useRef } from "react";
import Editor, { type OnMount } from "@monaco-editor/react";
import type { editor as MonacoEditor } from "monaco-editor";

import { setupMonaco } from "@/lib/monaco-setup";
import type { CodeMetrics } from "@/types/code";
import { levelFor, worstLevel, type CodeThresholds, type ThresholdLevel } from "@/lib/code-thresholds";

setupMonaco(); // configura o Monaco offline (bundlado, sem CDN) — idempotente.

/** Imperativo exposto ao CodeNode (jump-to-line a partir do painel). */
export interface CodeMonacoHandle {
  revealLine: (line: number) => void;
}

interface Props {
  value: string;
  language: string;
  onChange: (v: string) => void;
  onSave: () => void;
  /** Recebe o texto selecionado quando o usuário aciona "Enviar seleção" no menu. */
  onSendSelection?: (text: string) => void;
  /** Métricas do arquivo (9c) — alimentam o highlight inline das funções warn/high. */
  metrics?: CodeMetrics | null;
  /** Thresholds (9e) — definem quais linhas viram warn/high. */
  thresholds?: CodeThresholds;
  /** Entrega o handle imperativo (revealLine) ao pai. */
  onReady?: (handle: CodeMonacoHandle) => void;
}

/** Classe da linha/gutter por nível (definidas em index.css). */
const LINE_CLASS: Record<Exclude<ThresholdLevel, "ok">, { line: string; glyph: string }> = {
  warn: { line: "cx-line-warn", glyph: "cx-glyph-warn" },
  high: { line: "cx-line-high", glyph: "cx-glyph-high" },
};

export default function CodeMonaco({
  value,
  language,
  onChange,
  onSave,
  onSendSelection,
  metrics,
  thresholds,
  onReady,
}: Props) {
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  const decorRef = useRef<MonacoEditor.IEditorDecorationsCollection | null>(null);

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    monacoRef.current = monaco;
    decorRef.current = editor.createDecorationsCollection();

    // Ctrl/Cmd+S salva sem sair do editor.
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSave());
    // Item no menu de clique-direito NATIVO do Monaco: envia a seleção pro agente.
    editor.addAction({
      id: "send-selection-to-agent",
      label: "✈ Enviar seleção p/ agente",
      contextMenuGroupId: "navigation",
      contextMenuOrder: 1.5,
      run: (ed) => {
        const sel = ed.getSelection();
        const text = sel ? ed.getModel()?.getValueInRange(sel) ?? "" : "";
        if (text.trim()) onSendSelection?.(text);
      },
    });

    onReady?.({
      revealLine: (line) => {
        const ed = editorRef.current;
        if (!ed || line < 1) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
      },
    });

    applyDecorations();
  };

  // Recalcula as decorações de complexidade quando métricas/thresholds mudam.
  function applyDecorations() {
    const editor = editorRef.current;
    const monaco = monacoRef.current;
    const collection = decorRef.current;
    if (!editor || !monaco || !collection) return;

    const decos: MonacoEditor.IModelDeltaDecoration[] = [];
    if (metrics && thresholds) {
      for (const fn of metrics.functions) {
        const cxLvl = levelFor(thresholds, "cyclomatic", fn.cyclomatic, metrics.language);
        const cogLvl = levelFor(thresholds, "cognitive", fn.cognitive, metrics.language);
        const lvl = worstLevel(cxLvl, cogLvl);
        if (lvl === "ok") continue;
        const klass = LINE_CLASS[lvl];
        const reason = lvl === "high" ? "complexidade alta" : "atenção";
        const line = Math.max(1, fn.startLine);
        decos.push({
          range: new monaco.Range(line, 1, line, 1),
          options: {
            isWholeLine: true,
            className: klass.line,
            glyphMarginClassName: klass.glyph,
            glyphMarginHoverMessage: {
              value: `**${fn.name}** — cx ${fn.cyclomatic} · cog ${fn.cognitive} — ${reason}`,
            },
            overviewRuler: {
              color: lvl === "high" ? "#e5484d" : "#f5a623",
              position: monaco.editor.OverviewRulerLane.Right,
            },
          },
        });
      }
    }
    collection.set(decos);
  }

  // Reaplica quando as métricas ou thresholds mudam (depois do mount).
  useEffect(() => {
    applyDecorations();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [metrics, thresholds]);

  return (
    <Editor
      theme="vs-dark"
      language={language}
      value={value}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        // automaticLayout usa ResizeObserver — relayouta sozinho quando o node
        // sai de display:none (floor inativo → ativo). Cobre o gotcha da correção #6.
        automaticLayout: true,
        fontSize: 12,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        tabSize: 2,
        renderWhitespace: "selection",
        smoothScrolling: true,
        // Gutter de glifos pros marcadores de complexidade (warn/high).
        glyphMargin: true,
      }}
    />
  );
}
