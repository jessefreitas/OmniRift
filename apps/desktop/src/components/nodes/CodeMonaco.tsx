// src/components/nodes/CodeMonaco.tsx
//
// O editor Monaco em si — isolado neste módulo pra ser carregado por dynamic
// import (lazy) lá no CodeNode. Assim o Monaco (pesado) cai num CHUNK separado,
// fora do bundle principal: só baixa quando um CodeNode aparece no canvas.

import Editor, { type OnMount } from "@monaco-editor/react";

import { setupMonaco } from "@/lib/monaco-setup";

setupMonaco(); // configura o Monaco offline (bundlado, sem CDN) — idempotente.

interface Props {
  value: string;
  language: string;
  onChange: (v: string) => void;
  onSave: () => void;
  /** Recebe o texto selecionado quando o usuário aciona "Enviar seleção" no menu. */
  onSendSelection?: (text: string) => void;
}

export default function CodeMonaco({ value, language, onChange, onSave, onSendSelection }: Props) {
  const handleMount: OnMount = (editor, monaco) => {
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
  };

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
      }}
    />
  );
}
