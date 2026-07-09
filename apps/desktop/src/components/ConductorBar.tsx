// components/ConductorBar.tsx
//
// Barra de input do Modo Conductor — fixa embaixo do canvas quando conductorMode = true.
// Input multiline, seletor de engine, e indicador de agentes disponíveis.
// Enter = despachar, Shift+Enter = multiline, Esc = fechar.

import { useEffect, useRef, useState, useCallback } from "react";
import { createPortal } from "react-dom";
import { ChevronUp, X, Send, Radio } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import {
  dispatchConductor,
  loadConductorConfig,
  saveConductorConfig,
  type ConductorEngine,
} from "@/lib/orchestration/conductor";

const ENGINE_LABELS: Record<ConductorEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
  llm: "Leve (LLM)",
  shell: "Shell (zero LLM)",
};

export function ConductorBar() {
  const t = useT();
  const conductorMode = useCanvasStore((s) => s.conductorMode);
  const setConductorMode = useCanvasStore((s) => s.setConductorMode);
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);
  const nodes = useCanvasStore((s) => s.nodes);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);

  const [input, setInput] = useState("");
  const [engine, setEngine] = useState<ConductorEngine>("claude");
  const [busy, setBusy] = useState(false);
  const [showEngineMenu, setShowEngineMenu] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Carrega config salva
  useEffect(() => {
    const cfg = loadConductorConfig();
    setEngine(cfg.engine);
  }, []);

  // Salva config quando muda
  useEffect(() => {
    saveConductorConfig({ engine, model: null });
  }, [engine]);

  // Foco no mount
  useEffect(() => {
    if (conductorMode) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [conductorMode]);

  // Auto-resize do textarea
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }, [input]);

  // Atalho: Ctrl+Shift+C liga/desliga o modo Conductor; Esc fecha quando ON
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
        e.preventDefault();
        setConductorMode(!conductorMode);
      } else if (e.key === "Escape" && conductorMode) {
        setConductorMode(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [conductorMode, setConductorMode]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    setInput("");
    try {
      await dispatchConductor(text, { engine, model: null });
    } catch (e) {
      console.error("[conductor] dispatch falhou:", e);
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  }, [input, busy, engine]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  // Conta agentes disponíveis no floor ativo
  const activeNodes = nodes.filter((n) => {
    const floor = useCanvasStore.getState().parallels.find((p) => p.id === activeParallelId);
    return floor?.nodes.some((fn) => fn.id === n.id);
  });
  const agentCount = activeNodes.filter((n) => n.kind === "terminal" || n.kind === "agent").length;

  if (!conductorMode) return null;

  return createPortal(
    <div className="fixed bottom-0 left-0 right-0 z-40 border-t border-border bg-bg/95 backdrop-blur-sm shadow-lg">
      {/* Linha de controles */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50">
        <Radio size={14} className="text-brand" />
        <span className="text-[11px] font-medium text-brand">Conductor</span>

        {/* Seletor de engine */}
        <div className="relative">
          <button
            onClick={() => setShowEngineMenu((v) => !v)}
            className="text-[11px] px-2 py-0.5 rounded bg-bgSecondary border border-border text-text hover:border-brand/50 transition-colors"
          >
            {ENGINE_LABELS[engine]} ▾
          </button>
          {showEngineMenu && (
            <div className="absolute top-full left-0 mt-1 bg-bgSecondary border border-border rounded shadow-lg z-50 min-w-[160px]">
              {(Object.keys(ENGINE_LABELS) as ConductorEngine[]).map((eng) => (
                <button
                  key={eng}
                  onClick={() => { setEngine(eng); setShowEngineMenu(false); }}
                  className={`w-full text-left px-3 py-1.5 text-[11px] hover:bg-brand/10 transition-colors ${
                    eng === engine ? "text-brand font-medium" : "text-text"
                  }`}
                >
                  {ENGINE_LABELS[eng]}
                </button>
              ))}
            </div>
          )}
        </div>

        {/* Indicador de agentes */}
        <span className="text-[10px] text-textMuted ml-auto">
          {agentCount} agente{agentCount !== 1 ? "s" : ""} no floor ·
          {orchestratorSid ? " Conductor conectado" : " Sem Conductor"}
        </span>

        {/* Toggle stream (futuro) */}
        <button
          onClick={() => setConductorMode(false)}
          className="text-textMuted hover:text-text p-0.5"
          title={t("conductor.close", "Fechar modo Conductor (Esc)")}
        >
          <X size={14} />
        </button>
      </div>

      {/* Input */}
      <div className="flex items-end gap-2 px-3 py-2">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={t("conductor.placeholder", "Escreva... use @ pra endereçar agentes. Ex: @backend corrige o bug | @reviewer revisa")}
          rows={1}
          className="flex-1 bg-bgSecondary border border-border rounded px-3 py-2 text-sm text-text placeholder:text-textMuted focus:outline-none focus:border-brand/50 resize-none font-mono"
          style={{ minHeight: "36px", maxHeight: "160px" }}
          disabled={busy}
        />
        <button
          onClick={() => void handleSubmit()}
          disabled={!input.trim() || busy}
          className="shrink-0 p-2 rounded bg-brand text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
          title="Despachar (Enter)"
        >
          {busy ? <ChevronUp size={16} className="animate-pulse" /> : <Send size={16} />}
        </button>
      </div>
    </div>,
    document.body,
  );
}
