// components/ConstructorBar.tsx
//
// Barra de input do Modo Conductor — flutua DENTRO do canvas (overlay bottom).
// Input multiline, seletor de engine, indicador de agentes, e chat embutido.
// Enter = despachar, Shift+Enter = multiline, Esc = fechar.

import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { ChevronUp, X, Send, Radio, AlertCircle, ArrowUpRight } from "lucide-react";
import { cn } from "@/lib/cn";

import { useCanvasStore } from "@/store/canvas-store";
import {
  dispatchConstructor,
  chatConstructor,
  loadConstructorConfig,
  saveConstructorConfig,
  type ConstructorEngine,
  type OrchestratorEntry,
} from "@/lib/orchestration/conductor";
import { ConstructorPanel } from "@/components/ConstructorPanel";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";

const ENGINE_LABELS: Record<ConstructorEngine, string> = {
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
  /** true enquanto a resposta ainda está chegando em streaming (sessão persistente). */
  streaming?: boolean;
}

/** Primeira palavra do label, só com chars que o MENTION_RE do parser aceita ([\w:-]).
 *  O resolveMention casa por substring case-insensitive, então a 1ª palavra basta. */
function mentionToken(label: string): string {
  const first = label.trim().split(/\s+/)[0] ?? "";
  const clean = first.replace(/[^\w:-]/g, "");
  return clean || label.replace(/[^\w:-]/g, "");
}

export function ConstructorBar() {
  const constructorMode = useCanvasStore((s) => s.constructorMode);
  const setConstructorMode = useCanvasStore((s) => s.setConstructorMode);
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);

  const [input, setInput] = useState("");
  const [engine, setEngine] = useState<ConstructorEngine>(() => loadConstructorConfig().engine);
  // Modo: "chat" = conversa inline (brainstorm); "dispatch" = orquestra a frota.
  const [talkMode, setTalkMode] = useState<"chat" | "dispatch">(() => loadConstructorConfig().talkMode ?? "chat");
  const [busy, setBusy] = useState(false);
  const [showEngineMenu, setShowEngineMenu] = useState(false);
  const [chat, setChat] = useState<ChatMsg[]>([]);
  const [error, setError] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const chatRef = useRef<HTMLDivElement>(null);

  // --- autocomplete de @mention ---
  const terminalStatuses = useCanvasStore((s) => s.terminalStatuses);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionSel, setMentionSel] = useState(0);
  const mentionOpenRef = useRef(false);

  // engine/talkMode lidos do config no init (lazy); aqui só persistem quando mudam.
  useEffect(() => {
    saveConstructorConfig({ engine, model: null, talkMode });
  }, [engine, talkMode]);

  useEffect(() => {
    if (constructorMode) {
      requestAnimationFrame(() => textareaRef.current?.focus());
    }
  }, [constructorMode]);

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
        setConstructorMode(!constructorMode);
      } else if (e.key === "Escape" && constructorMode) {
        // Popup de @mention aberto: Esc fecha só o popup (handler do textarea), não a barra.
        if (mentionOpenRef.current) return;
        setConstructorMode(false);
      }
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [constructorMode, setConstructorMode]);

  // Listener pra entries do orchestration_log (respostas dos agentes)
  useEffect(() => {
    if (!constructorMode) return;
    let unlisten: UnlistenFn | undefined;
    listen<OrchestratorEntry>("orchestrator://log", (e) => {
      const entry = e.payload;
      setChat((prev) => [...prev, {
        role: entry.source === "user" ? "user" : entry.status === "error" ? "error" : "agent",
        text: `${entry.source} → ${entry.target}: ${entry.payload}`,
        // Backend stampa em SEGUNDOS (as_secs); Date espera ms. Normaliza na borda.
        ts: entry.timestamp < 1e12 ? entry.timestamp * 1000 : entry.timestamp,
      }]);
    }).then((fn) => { unlisten = fn; });
    return () => { unlisten?.(); };
  }, [constructorMode]);

  // Streaming da sessão persistente (modo Conversar / Claude): os deltas montam a
  // resposta progressivamente numa entrada "ao vivo" que cresce; o done a fecha.
  useEffect(() => {
    if (!constructorMode) return;
    let unD: UnlistenFn | undefined, unDone: UnlistenFn | undefined, unDead: UnlistenFn | undefined;
    listen<string>("constructor://chat-delta", (e) => {
      const t = e.payload;
      setChat((prev) => {
        // Procura a última entrada de streaming (pode haver entrada de log intercalada)
        const idx = [...prev].reverse().findIndex((m) => m.streaming);
        if (idx >= 0) {
          const realIdx = prev.length - 1 - idx;
          const updated = [...prev];
          updated[realIdx] = { ...updated[realIdx], text: updated[realIdx].text + t };
          return updated;
        }
        return [...prev, { role: "agent", text: t, ts: Date.now(), streaming: true }];
      });
    }).then((fn) => { unD = fn; });
    listen<string>("constructor://chat-done", () => {
      setChat((prev) => {
        const last = prev[prev.length - 1];
        return last?.streaming ? [...prev.slice(0, -1), { ...last, streaming: false }] : prev;
      });
      setBusy(false);
    }).then((fn) => { unDone = fn; });
    listen("constructor://chat-dead", () => {
      setChat((prev) => [...prev, { role: "error", text: "A sessão do copiloto caiu — mande de novo.", ts: Date.now() }]);
      setBusy(false);
    }).then((fn) => { unDead = fn; });
    return () => { unD?.(); unDone?.(); unDead?.(); };
  }, [constructorMode]);

  // Auto-scroll chat
  useEffect(() => {
    if (chatRef.current) {
      chatRef.current.scrollTop = chatRef.current.scrollHeight;
    }
  }, [chat]);

  // `forceDispatch` = o botão "→ enviar ao agente" (despacha mesmo em modo Conversa).
  const handleSubmit = useCallback(async (forceDispatch = false) => {
    const text = input.trim();
    if (!text || busy) return;

    setBusy(true);
    setError(null);
    setInput("");
    setChat((prev) => [...prev, { role: "user", text, ts: Date.now() }]);
    // Timeout guard: libera busy após 90s se chat-done/chat-dead não chegarem
    const busyGuard = setTimeout(() => setBusy(false), 90_000);
    try {
      if (talkMode === "chat" && !forceDispatch) {
        await chatConstructor(text, engine); // conversa inline (Claude local, sem chave), não toca na frota
      } else {
        await dispatchConstructor(text, { engine, model: null });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
      setChat((prev) => [...prev, { role: "error", text: `Erro: ${msg}`, ts: Date.now() }]);
    } finally {
      clearTimeout(busyGuard);
      setBusy(false);
      textareaRef.current?.focus();
    }
  }, [input, busy, engine, talkMode]);

  const activeFloor = parallels.find((p) => p.id === activeParallelId);
  // O copiloto (terminal do orquestrador) NÃO conta como frota — só agentes de
  // trabalho. Assim "0 agt" reflete o canvas vazio mesmo com o Constructor vivo.
  const agentCount = activeFloor?.nodes.filter(
    (n) => (n.kind === "terminal" || n.kind === "agent") &&
      (n as { session_id?: string }).session_id !== orchestratorSid,
  ).length ?? 0;

  // Candidatos do popup de @: agentes do floor ativo + alvos especiais do parser.
  const mentionCandidates = useMemo(() => {
    if (mentionQuery === null) return [];
    const nodes = (activeFloor?.nodes ?? []).filter((n) => n.kind === "terminal" || n.kind === "agent");
    const agents = nodes.map((n) => {
      const sid = (n as { session_id?: string }).session_id ?? n.id;
      const label = (n as { label?: string }).label ?? n.id;
      return { insert: mentionToken(label), label, status: terminalStatuses[sid] ?? "idle" };
    });
    const specials = [
      { insert: "all", label: "todos os agentes do floor", status: "" },
      { insert: "idle", label: "só os agentes livres", status: "" },
    ];
    const q = mentionQuery.toLowerCase();
    return [...agents, ...specials]
      .filter((c) => !q || c.insert.toLowerCase().startsWith(q) || c.label.toLowerCase().includes(q))
      .slice(0, 8);
  }, [mentionQuery, activeFloor, terminalStatuses]);

  const mentionOpen = mentionQuery !== null && mentionCandidates.length > 0;
  useEffect(() => {
    mentionOpenRef.current = mentionOpen;
  }, [mentionOpen]);

  // Detecta "@parcial" imediatamente antes do caret → abre/filtra o popup.
  const detectMention = (value: string, caret: number) => {
    const m = value.slice(0, caret).match(/(^|\s)@([\w:-]*)$/);
    if (m) {
      setMentionQuery(m[2]);
      setMentionSel(0);
    } else {
      setMentionQuery(null);
    }
  };

  const insertMention = (token: string) => {
    const ta = textareaRef.current;
    const caret = ta?.selectionStart ?? input.length;
    const before = input.slice(0, caret).replace(/@[\w:-]*$/, `@${token} `);
    const after = input.slice(caret);
    setInput(before + after);
    setMentionQuery(null);
    requestAnimationFrame(() => {
      ta?.focus();
      ta?.setSelectionRange(before.length, before.length);
    });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionOpen) {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setMentionSel((i) => (i + 1) % mentionCandidates.length);
        return;
      }
      if (e.key === "ArrowUp") {
        e.preventDefault();
        setMentionSel((i) => (i - 1 + mentionCandidates.length) % mentionCandidates.length);
        return;
      }
      if (e.key === "Enter" || e.key === "Tab") {
        e.preventDefault();
        insertMention(mentionCandidates[mentionSel].insert);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        setMentionQuery(null);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSubmit();
    }
  };

  if (!constructorMode) return null;

  return (
    <>
      {/* Janela flutuante de resposta do Constructor (arrastável) — a conversa vive aqui,
          fora da barra. A barra é só input + seletor de cérebro. */}
      {chat.length > 0 && <ConstructorPanel messages={chat} onClose={() => setChat([])} />}

    {/* SEM overflow-hidden: o menu de engines abre pra CIMA (bottom-full) e seria clipado. */}
    <div className="absolute bottom-4 left-1/2 -translate-x-1/2 z-30 w-[560px] max-w-[90%] flex flex-col rounded-xl bg-bg/95 backdrop-blur-md shadow-2xl border border-brand/40" style={{ maxHeight: "320px", boxShadow: "0 0 24px -4px rgba(59,139,212,0.25), 0 8px 32px -8px rgba(0,0,0,0.5)" }}>
      {/* Borda colorida superior (gradient brand) */}
      <div className="h-[2px] w-full rounded-t-xl bg-gradient-to-r from-brand/0 via-brand to-brand/0" />

      {/* Erro inline */}
      {error && (
        <div className="px-3 py-0.5 text-[10px] text-red-400 flex items-center gap-1 bg-red-500/5">
          <AlertCircle size={11} /> {error}
        </div>
      )}

      {/* Linha de controles (compacta) */}
      <div className="flex items-center gap-1.5 px-2.5 py-1 border-t border-border/30 shrink-0">
        <Radio size={11} className="text-brand shrink-0" />
        <span className="text-[10px] font-medium text-brand shrink-0">Constructor</span>

        {/* Toggle Conversar/Despachar — Conversar não toca na frota; Despachar orquestra. */}
        <button
          onClick={() => setTalkMode((m) => (m === "chat" ? "dispatch" : "chat"))}
          title={talkMode === "chat" ? "Modo Conversar (só troca ideia). Clique pra Despachar." : "Modo Despachar (orquestra a frota). Clique pra Conversar."}
          className={cn(
            "text-[10px] px-1.5 py-0.5 rounded border shrink-0 transition-colors",
            talkMode === "chat"
              ? "bg-brand/10 border-brand/40 text-brand"
              : "bg-surface2 border-border text-textMuted hover:border-brand/40",
          )}
        >
          {talkMode === "chat" ? "💬 Conversar" : "⚡ Despachar"}
        </button>

        <div className="relative shrink-0">
          <button
            onClick={() => setShowEngineMenu((v) => !v)}
            className="text-[10px] px-1.5 py-0.5 rounded bg-surface2 border border-brand/20 text-text hover:border-brand/50 transition-colors"
          >
            {ENGINE_LABELS[engine]} ▾
          </button>
          {showEngineMenu && (
            <div className="absolute bottom-full left-0 mb-1 bg-surface2 border border-brand/30 rounded-lg shadow-xl z-50 min-w-[150px] overflow-hidden">
              {(Object.keys(ENGINE_LABELS) as ConstructorEngine[]).map((eng) => (
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
          onClick={() => { void invoke("constructor_chat_close").catch(() => {}); setConstructorMode(false); }}
          className="text-textMuted hover:text-red-400 p-0.5 transition-colors"
          title="Fechar (Esc)"
        >
          <X size={12} />
        </button>
      </div>

      {/* Input (compacto) */}
      <div className="relative flex items-end gap-1.5 px-2.5 py-1.5 shrink-0">
        {/* Popup de @mention — lista os agentes do floor ativo */}
        {mentionOpen && (
          <div className="absolute bottom-full left-2.5 right-2.5 mb-1 bg-surface2 border border-brand/30 rounded-lg shadow-xl z-50 overflow-hidden">
            {mentionCandidates.map((c, i) => (
              <button
                key={`${c.insert}-${i}`}
                onMouseDown={(e) => { e.preventDefault(); insertMention(c.insert); }}
                onMouseEnter={() => setMentionSel(i)}
                className={`w-full text-left px-2.5 py-1 text-[10px] flex items-center gap-1.5 transition-colors ${
                  i === mentionSel ? "bg-brand/10 text-brand" : "text-text"
                }`}
              >
                <span className="font-mono shrink-0">@{c.insert}</span>
                <span className="text-textMuted truncate">{c.label}</span>
                {c.status && <span className="ml-auto text-[9px] text-textMuted shrink-0">{c.status}</span>}
              </button>
            ))}
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            detectMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={handleKeyDown}
          placeholder={talkMode === "chat" ? "Converse… ou @agente · Enter envia" : "Tarefa pra frota… ou @agente · Enter despacha"}
          rows={1}
          className="flex-1 bg-surface2 border border-brand/20 rounded-lg px-2.5 py-1.5 text-xs text-text placeholder:text-textMuted focus:outline-none focus:border-brand/60 resize-none font-mono transition-colors"
          style={{ minHeight: "28px", maxHeight: "80px" }}
          disabled={busy}
        />
        {/* No modo Conversar: manda a ideia atual pro agente (força despacho). */}
        {talkMode === "chat" && (
          <button
            onClick={() => void handleSubmit(true)}
            disabled={!input.trim() || busy}
            className="shrink-0 flex items-center gap-1 px-2 py-1.5 rounded-lg border border-brand/40 text-brand text-[10px] disabled:opacity-30 disabled:cursor-not-allowed hover:bg-brand/10 transition-colors"
            title="Enviar a ideia atual pro agente (despacha)"
          >
            <ArrowUpRight size={12} /> agente
          </button>
        )}
        <button
          onClick={() => void handleSubmit()}
          disabled={!input.trim() || busy}
          className="shrink-0 p-1.5 rounded-lg bg-brand text-white disabled:opacity-30 disabled:cursor-not-allowed hover:bg-brand/90 transition-colors"
          title={talkMode === "chat" ? "Conversar (Enter)" : "Despachar (Enter)"}
        >
          {busy ? <ChevronUp size={13} className="animate-pulse" /> : <Send size={13} />}
        </button>
      </div>
    </div>
    </>
  );
}
