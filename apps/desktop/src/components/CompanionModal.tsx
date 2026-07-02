// src/components/CompanionModal.tsx
//
// Painel do OmniPartner com dois modos (Fase 9, fatia A0):
//  - Analisar — one-shot: lê o canvas (agentes + estado + memória) via LLM BYOK
//    e devolve resumo + próximos passos (comportamento original, intocado).
//  - Aprender — tutor Socrático: chat + 1 exercício verificável no cwd do projeto
//    (dica graduada via `llm_via_cli`, check via `run_check` — o mesmo do 🎯 Goal).
//  Fazer/Par ficam desabilitados (fase 2, sobre a camada ACP).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { CheckCircle2, GraduationCap, Lightbulb, RefreshCw, Send, Sparkles, X } from "lucide-react";

import { runCheck } from "@/lib/acp-client";
import { analyzeCanvas } from "@/lib/companion";
import { useT } from "@/lib/i18n";
import { askHint, askTutor, explainCheckFailure, type LearnMessage } from "@/lib/learn";
import { HELLO_SUM_EXERCISE, MAX_HINT_LEVEL } from "@/lib/learn-exercises";
import { useCanvasStore } from "@/store/canvas-store";

interface Props {
  onClose: () => void;
}

type Mode = "analyze" | "learn";

export function CompanionModal({ onClose }: Props) {
  const t = useT();
  // zustand v5: seletor devolve primitiva (string | null) — nunca objeto novo.
  const cwd = useCanvasStore((s) => s.currentCwd);
  const [mode, setMode] = useState<Mode>("analyze");

  // ── modo Analisar (original) ────────────────────────────────────────────────
  const [out, setOut] = useState<string>("");
  const [loading, setLoading] = useState(false);

  async function run() {
    setLoading(true);
    try {
      setOut(await analyzeCanvas());
    } catch (e) {
      setOut(`${t("companion.error", "Erro")}: ${String(e)}`);
    } finally {
      setLoading(false);
    }
  }

  // ── modo Aprender (A0) ──────────────────────────────────────────────────────
  const ex = HELLO_SUM_EXERCISE;
  const [msgs, setMsgs] = useState<LearnMessage[]>([]);
  const [input, setInput] = useState("");
  const [hintLevel, setHintLevel] = useState(1);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [msgs.length]);

  const push = (m: LearnMessage) => setMsgs((prev) => [...prev, m]);
  const pushError = (e: unknown) =>
    push({ role: "system", text: `${t("companion.error", "Erro")}: ${String(e)}` });

  async function handleSend() {
    const q = input.trim();
    if (!q || busy) return;
    setInput("");
    push({ role: "user", text: q });
    setBusy(true);
    try {
      push({ role: "tutor", text: await askTutor(ex, hintLevel, q, cwd) });
    } catch (e) {
      pushError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleHint() {
    if (busy) return;
    push({ role: "user", text: `${t("learn.hintAsked", "Pedi uma dica")} (${hintLevel}/${MAX_HINT_LEVEL})` });
    setBusy(true);
    try {
      push({ role: "tutor", text: await askHint(ex, hintLevel, cwd) });
      setHintLevel((l) => Math.min(MAX_HINT_LEVEL, l + 1));
    } catch (e) {
      pushError(e);
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify() {
    if (busy) return;
    if (!cwd) {
      push({ role: "system", text: t("learn.noCwd", "Abra um projeto (paralelo com pasta) antes — o exercício é verificado no cwd dele.") });
      return;
    }
    setBusy(true);
    setChecking(true);
    try {
      const r = await runCheck(cwd, ex.condition);
      if (r.exit === 0) {
        setDone(true);
        push({ role: "system", text: t("learn.passed", "✅ Passou! Exercício concluído — próximo passo: trilhas completas chegam nas próximas fatias.") });
      } else {
        const brief = (r.output || "").trim().slice(0, 400);
        push({
          role: "system",
          text: `${t("learn.failed", "❌ Ainda não passou.")}${brief ? `\n${brief}` : ""}`,
        });
        setChecking(false);
        push({ role: "tutor", text: await explainCheckFailure(ex, hintLevel, r.output, cwd) });
      }
    } catch (e) {
      pushError(e);
    } finally {
      setBusy(false);
      setChecking(false);
    }
  }

  const modeBtn = (m: Mode, label: string) => (
    <button
      onClick={() => setMode(m)}
      className={`px-2 py-0.5 rounded text-[11px] transition-colors ${
        mode === m ? "bg-brand text-bg" : "text-textMuted hover:text-text"
      }`}
    >
      {label}
    </button>
  );

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[600px] max-w-[92vw] h-[540px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Sparkles size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">OmniPartner</span>
          <div className="flex items-center gap-0.5 rounded bg-surface2 p-0.5 ml-2">
            {modeBtn("analyze", t("companion.modeAnalyze", "Analisar"))}
            {modeBtn("learn", t("companion.modeLearn", "Aprender"))}
            <button disabled title={t("companion.phase2", "Fase 2")} className="px-2 py-0.5 rounded text-[11px] text-textMuted opacity-40 cursor-not-allowed">
              {t("companion.modeDo", "Fazer")}
            </button>
            <button disabled title={t("companion.phase2", "Fase 2")} className="px-2 py-0.5 rounded text-[11px] text-textMuted opacity-40 cursor-not-allowed">
              {t("companion.modePair", "Par")}
            </button>
          </div>
          <span className="flex-1" />
          {mode === "analyze" && (
            <button
              onClick={() => void run()}
              disabled={loading}
              className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-50"
            >
              <RefreshCw size={12} className={loading ? "animate-spin" : ""} /> {loading ? t("companion.analyzing", "Analisando…") : t("companion.analyzeCanvas", "Analisar canvas")}
            </button>
          )}
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {mode === "analyze" ? (
          <div className="flex-1 overflow-auto p-4">
            {out ? (
              <pre className="text-[12px] text-text whitespace-pre-wrap break-words font-sans leading-relaxed">{out}</pre>
            ) : (
              <p className="text-[12px] text-textMuted opacity-70">
                {t("companion.emptyHint", "Clique em \"Analisar canvas\" — o OmniPartner lê seus agentes, o estado deles e a memória do projeto, e sugere os próximos passos. Usa o LLM BYOK (qualquer provider), não fica preso a nuvem.")}
              </p>
            )}
          </div>
        ) : (
          <div className="flex-1 flex flex-col min-h-0">
            {/* card do exercício */}
            <div className="px-4 py-2.5 border-b border-border bg-surface2/40 shrink-0">
              <div className="flex items-center gap-1.5">
                <GraduationCap size={13} className="text-brand" />
                <span className="text-[12px] font-medium text-text flex-1">{ex.title}</span>
                {done && (
                  <span className="flex items-center gap-1 text-[11px] text-brand">
                    <CheckCircle2 size={12} /> {t("learn.done", "Concluído")}
                  </span>
                )}
              </div>
              <p className="text-[11px] text-textMuted mt-1 leading-relaxed">{ex.statement}</p>
              <p className="text-[10px] text-textMuted opacity-70 mt-1 font-mono break-all">{ex.condition}</p>
            </div>

            {/* chat */}
            <div className="flex-1 overflow-auto p-3 space-y-2">
              {msgs.length === 0 && (
                <p className="text-[12px] text-textMuted opacity-70">
                  {t("learn.emptyHint", "Escreva o código no seu projeto e use o tutor: pergunte qualquer coisa, peça dicas graduadas (nunca a solução de cara) e clique em Verificar quando achar que terminou.")}
                </p>
              )}
              {msgs.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  <div
                    className={`max-w-[85%] rounded px-2.5 py-1.5 text-[12px] whitespace-pre-wrap break-words leading-relaxed ${
                      m.role === "user"
                        ? "bg-brand text-bg"
                        : m.role === "tutor"
                          ? "bg-surface2 text-text"
                          : "bg-surface2/50 text-textMuted italic"
                    }`}
                  >
                    {m.text}
                  </div>
                </div>
              ))}
              {busy && (
                <p className="text-[11px] text-textMuted opacity-70 animate-pulse">
                  {checking ? t("learn.verifying", "Verificando…") : t("learn.thinking", "Tutor pensando…")}
                </p>
              )}
              <div ref={endRef} />
            </div>

            {/* ações + input */}
            <div className="px-3 py-2 border-t border-border shrink-0 space-y-2">
              <div className="flex items-center gap-2">
                <button
                  onClick={() => void handleHint()}
                  disabled={busy}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-surface2 text-text hover:bg-surface3 transition-colors disabled:opacity-50"
                >
                  <Lightbulb size={12} /> {t("learn.hint", "Pedir dica")} ({hintLevel}/{MAX_HINT_LEVEL})
                </button>
                <button
                  onClick={() => void handleVerify()}
                  disabled={busy || done}
                  className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-50"
                >
                  <CheckCircle2 size={12} /> {t("learn.verify", "Verificar")}
                </button>
              </div>
              <div className="flex items-center gap-2">
                <input
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      void handleSend();
                    }
                  }}
                  placeholder={t("learn.inputPlaceholder", "Pergunte ao tutor… (Enter envia)")}
                  className="flex-1 bg-surface2 border border-border rounded px-2.5 py-1.5 text-[12px] text-text placeholder:text-textMuted focus:outline-none focus:border-brand"
                />
                <button
                  onClick={() => void handleSend()}
                  disabled={busy || !input.trim()}
                  className="p-1.5 rounded bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-50"
                  title={t("learn.send", "Enviar")}
                >
                  <Send size={13} />
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
