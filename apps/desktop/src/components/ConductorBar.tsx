// components/ConductorBar.tsx
//
// Barra de input do Modo Conductor — flutua DENTRO do canvas (overlay bottom).
// Input multiline, seletor de engine, indicador de agentes, e chat embutido.
// Enter = despachar, Shift+Enter = multiline, Esc = fechar.

import { useEffect, useRef, useState, useCallback } from "react";
import { ChevronUp, X, Send, Radio, AlertCircle } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import {
  dispatchConductor,
  loadConductorConfig,
  saveConductorConfig,
  type ConductorEngine,
  type OrchestratorEntry,
} from "@/lib/orchestration/conductor";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

const ENGINE_LABELS: Record<ConductorEngine, string> = {
  claude: "Claude Code",
  codex: "Codex",
  hermes: "Hermes",
  llm: "Leve (LLM)",
  shell: "Shell (zero LLM)",
};

interface ChatMsg {
  role: "user" | "agent" | "system" | "error";
  text: string;
  ts: number;
}

export function ConductorBar() {
  const conductorMode = useCanvasStore((s) => s.conductorMode);
  const setConductorMode = useCanvasStore((s) => s.setConductorMode);
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);

  const [input, setInput] = useState("");
  const [engine, setEngine] = useState<ConductorEngine>("claude");
  const [busy, setBusy] = useState(false);
  const [showEngineMenu, setShowEngineMenu] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const cfg = loadConductorConfig();
    setEngine(cfg.engine);
  }, []);

  useEffect(() => {
    saveConductorConfig({ engine, model: null });
  }, [engine]);

  useEffect(() => {
    if (conductorMode) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [conductorMode]);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, 120)}px`;
  }, [input]);

  // Atalho: Ctrl+Shift+C liga/desliga; Esc fecha
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

  // Listener pra entries do orchestration_log (respostas dos agentes)
  useEffect(() => {
    if (!conductorMode) return;
    let unlisten: UnlistenFn | undefined;
    listen<OrchestratorEntry>("orchestrator://log", (e) => {
      const entry = e.payload;
      setChat((prev) => [...prev, {
        role: entry.source === "user" ? "user" : entry.status === "error" ? "error" : "agent",
        text: `${entry.source} → ${entry.target}: ${entry.payload}`,
        ts: entry.timestamp,
      }]);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [conductorMode]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chat]);

  const handleSubmit = useCallback(async () => {
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    setError(null);
    setInput("");
    setChat((prev) => [...prev, { role: "user", text, ts: Date.now() }]);
    try {
      await dispatchConductor(text, { engine, model: null });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setChat((prev) => [...prev, { role: "error", text: `Erro: ${msg}`, ts: Date.now() }]);
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

  const activeFloor = parallels.find((p) => p.id === activeParallelId);
  const agentCount = activeFloor?.nodes.filter((n) => n.kind === "terminal" || n.kind === "agent").length ?? 0;

  if (!conductorMode) return null;

  return (
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-[560px] max-w-[90%] flex flex-col rounded-xl bg-bg/95 backdrop-blur-md shadow-2xl border border-brand/40 overflow-hidden" style={{ maxHeight: "320px", boxShadow: "0 0 24px -4px rgba(59,139,212,0.25), 0 8px 32px -8px rgba(0,0,0,0.5)" }}>
      {/* Borda colorida superior (gradient brand) */}
      <div className="h-[2px] w-full bg-gradient-to-r from-brand/0 via-brand to-brand/0" />

      {/* Chat — ultimas mensagens (compacto) */}
      {chat.length > 0 && (
        <div ref={chatRef} className="flex-1 overflow-y-auto px-3 py-1.5 space-y-0.5 min-h-0">
          {chat.map((msg, i) => (
            <div key={i} className={`text-[11px] font-mono leading-tight ${
              msg.role === "user" ? "text-brand" :
              msg.role === "error" ? "text-red-400" :
              msg.role === "system" ? "text-textMuted" : "text-text"
            }`}>
              <span className="text-textMuted text-[9px] mr-1 tabular-nums">
                {new Date(msg.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </span>
              {msg.text.length > 200 ? msg.text.slice(0, 200) + "…" : msg.text}
            </div>
          ))}
        </div>
      )}

      {/* Erro inline */}
      {error && (
        <div className="px-3 py-0.5 text-[10px] text-red-400 flex items-center gap-1 bg-red-500/5">
          <AlertCircle size={11} /> {error}
        </div>
      )}

      {/* Linha de controles (compacta) */}
      <div className="flex items-center gap-1.5 px-2.5 py-1 border-t border-border/30 shrink-0">
        <Radio size={11} className="text-brand shrink-0" />
        <span className="text-[10px] font-medium text-brand shrink-0">Conductor</span>

        <div className="relative shrink-0">
          <button
            onClick={() => setShowEngineMenu((v) => !v)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-bgSecondary border border-brand/20 text-text hover:border-brand/50 transition-colors"
          >
            {ENGINE_LABELS[engine]} ▾
          </button>
          {showEngineMenu && (
            <div className="absolute bottom-full left-0 mb-1 bg-bgSecondary border border-brand/30 rounded-lg shadow-xl z-50 min-w-[150px] overflow-hidden">
              {(Object.keys(ENGINE_LABELS) as ConductorEngine[]).map((eng) => (
                <button
                  key={eng}
                  onClick={() => { setEngine(eng); setShowEngineMenu(false); }}
                  className={`w-full text-left px-2.5 py-1 text-[10px] hover:bg-brand/10 transition-colors ${
                    eng === engine ? "text-brand font-medium bg-brand/5" : "text-text"
                  }`}
                >
                  {ENGINE_LABELS[eng]}
                </button>
              ))}
            </div>
          )}
        </div>

        <span className="text-[9px] text-textMuted ml-auto">
          {agentCount} agt
        </span>

        <button
          onClick={() => setConductorMode(false)}
          className="text-textMuted hover:text-red-400 p-0.5 transition-colors"
          title="Fechar (Esc)"
        >
          <X size={12} />
        </button>
      </div>

      {/* Input (compacto) */}
      <div className="flex items-end gap-1.5 px-2.5 py-1.5 shrink-0">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="@agente tarefa… (Enter despacha, Shift+Enter = linha nova)"
          rows={1}
          className="flex-1 bg-bgSecondary border border-brand/20 rounded-lg px-2.5 py-1.5 text-xs text-text placeholder:text-textMuted focus:outline-none focus:border-brand/60 resize-none font-mono transition-colors"
          style={{ minHeight: "28px", maxHeight: "80px" }}
          disabled={busy}
        />
        <button
          onClick={() => void handleSubmit()}
          disabled={!input.trim() || busy}
          className="shrink-0 p-1.5 rounded-lg bg-brand text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
          title="Despachar (Enter)"
        >
          {busy ? <ChevronUp size={13} className="animate-pulse" /> : <Send size={13} />}
        </button>
      </div>
    </div>
  );
}
