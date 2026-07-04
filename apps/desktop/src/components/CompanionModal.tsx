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
import { ArrowRight, CheckCircle2, GraduationCap, Lightbulb, RefreshCw, Send, Sparkles, X } from "lucide-react";

import { runCheck } from "@/lib/acp-client";
import { analyzeCanvas } from "@/lib/companion";
import { useT } from "@/lib/i18n";
import { askHint, askTutor, explainCheckFailure, type LearnMessage } from "@/lib/learn";
import { LEARN_TRACKS, MAX_HINT_LEVEL } from "@/lib/learn-exercises";
import { kanbanCardCreate } from "@/lib/kanban-client";
import { useCanvasStore } from "@/store/canvas-store";

interface Props {
  onClose: () => void;
}

type Mode = "analyze" | "learn";

// Persistência da escolha do aprendiz (trilha + exercício atual) entre sessões.
const LEARN_TRACK_LS = "omnirift-learn-track";
const LEARN_EX_IDX_LS = "omnirift-learn-ex-idx";

/** Trilha salva (valida contra o catálogo — id desconhecido cai na primeira). */
function loadSavedTrackId(): string {
  const saved = localStorage.getItem(LEARN_TRACK_LS);
  return LEARN_TRACKS.some((tr) => tr.id === saved) ? (saved as string) : LEARN_TRACKS[0].id;
}

/** Índice de exercício salvo, clampeado no tamanho da trilha salva. */
function loadSavedExIdx(): number {
  const track = LEARN_TRACKS.find((tr) => tr.id === loadSavedTrackId()) ?? LEARN_TRACKS[0];
  const n = Number.parseInt(localStorage.getItem(LEARN_EX_IDX_LS) ?? "0", 10);
  return Number.isFinite(n) ? Math.min(Math.max(n, 0), track.exercises.length - 1) : 0;
}

// A2 — progresso durável: exercícios CONCLUÍDOS por trilha (persistidos → sobrevivem a reinício).
const LEARN_COMPLETED_LS = "omnirift-learn-completed-v1";

function loadCompleted(trackId: string): Set<string> {
  try {
    const all = JSON.parse(localStorage.getItem(LEARN_COMPLETED_LS) ?? "{}") as Record<string, string[]>;
    return new Set(Array.isArray(all[trackId]) ? all[trackId] : []);
  } catch {
    return new Set();
  }
}

function saveCompleted(trackId: string, ids: Set<string>): void {
  try {
    const all = JSON.parse(localStorage.getItem(LEARN_COMPLETED_LS) ?? "{}") as Record<string, string[]>;
    all[trackId] = [...ids];
    localStorage.setItem(LEARN_COMPLETED_LS, JSON.stringify(all));
  } catch {
    /* localStorage off */
  }
}

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

  // ── modo Aprender (A0+) ─────────────────────────────────────────────────────
  // Trilha (linguagem) + exercício atual, persistidos em localStorage.
  const [trackId, setTrackId] = useState<string>(loadSavedTrackId);
  const [exIdx, setExIdx] = useState<number>(loadSavedExIdx);
  // A4 — exercícios já registrados como card no Kanban nesta sessão (por id), pra não duplicar.
  const cardedRef = useRef<Set<string>>(new Set());
  // A2 — exercícios concluídos da trilha ATUAL (durável). Recarrega ao trocar de trilha.
  const [completed, setCompleted] = useState<Set<string>>(() => loadCompleted(trackId));
  useEffect(() => setCompleted(loadCompleted(trackId)), [trackId]);
  const track = LEARN_TRACKS.find((tr) => tr.id === trackId) ?? LEARN_TRACKS[0];
  const ex = track.exercises[Math.min(exIdx, track.exercises.length - 1)];
  const hasNextEx = exIdx < track.exercises.length - 1;
  const [msgs, setMsgs] = useState<LearnMessage[]>([]);
  const [input, setInput] = useState("");
  const [hintLevel, setHintLevel] = useState(1);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const [done, setDone] = useState(false);
  const endRef = useRef<HTMLDivElement>(null);

  /** Zera chat + nível de dica + concluído (troca de trilha ou de exercício). */
  function resetLearnSession() {
    setMsgs([]);
    setInput("");
    setHintLevel(1);
    setDone(false);
  }

  function selectTrack(id: string) {
    if (id === trackId || busy) return;
    setTrackId(id);
    setExIdx(0);
    resetLearnSession();
    localStorage.setItem(LEARN_TRACK_LS, id);
    localStorage.setItem(LEARN_EX_IDX_LS, "0");
  }

  function nextExercise() {
    if (!hasNextEx || busy) return;
    const next = exIdx + 1;
    setExIdx(next);
    resetLearnSession();
    localStorage.setItem(LEARN_EX_IDX_LS, String(next));
  }

  /** A2 — pula pra um exercício arbitrário da trilha (clique na barra de progresso). */
  function gotoExercise(i: number) {
    if (i === exIdx || busy || i < 0 || i >= track.exercises.length) return;
    setExIdx(i);
    resetLearnSession();
    localStorage.setItem(LEARN_EX_IDX_LS, String(i));
  }

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
      push({ role: "tutor", text: await askTutor(ex, track.label, hintLevel, q, cwd) });
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
      push({ role: "tutor", text: await askHint(ex, track.label, hintLevel, cwd) });
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
        // A2 — marca o exercício como concluído (durável entre sessões).
        setCompleted((prev) => {
          const next = new Set(prev).add(ex.id);
          saveCompleted(trackId, next);
          return next;
        });
        // A4 — registra a conquista no Kanban do projeto (col "done"), 1x por exercício.
        // Best-effort: se o Kanban falhar, libera o id pra tentar de novo e não trava o verify.
        if (!cardedRef.current.has(ex.id)) {
          cardedRef.current.add(ex.id);
          void kanbanCardCreate({
            project: cwd,
            col: "done",
            title: `🎓 ${track.label}: ${ex.title}`,
            body: `Exercício do modo Aprender concluído ✓ (${ex.condition}).`,
          }).catch(() => cardedRef.current.delete(ex.id));
        }
        push({
          role: "system",
          text: hasNextEx
            ? t("learn.passed", "✅ Passou! Exercício concluído — avance pro próximo quando quiser.")
            : t("learn.trackDone", "🎉 Passou! Trilha concluída — escolha outra trilha pra continuar aprendendo."),
        });
      } else {
        const brief = (r.output || "").trim().slice(0, 400);
        push({
          role: "system",
          text: `${t("learn.failed", "❌ Ainda não passou.")}${brief ? `\n${brief}` : ""}`,
        });
        setChecking(false);
        push({ role: "tutor", text: await explainCheckFailure(ex, track.label, hintLevel, r.output, cwd) });
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
            {/* seletor de trilha (linguagem) + posição na progressão */}
            <div className="flex items-center gap-1 px-4 py-1.5 border-b border-border shrink-0 overflow-x-auto">
              {LEARN_TRACKS.map((tr) => (
                <button
                  key={tr.id}
                  onClick={() => selectTrack(tr.id)}
                  disabled={busy}
                  className={`px-2 py-0.5 rounded text-[11px] whitespace-nowrap transition-colors disabled:opacity-50 ${
                    tr.id === track.id ? "bg-brand text-bg" : "bg-surface2 text-textMuted hover:text-text"
                  }`}
                  title={`${t("learn.track", "Trilha")}: ${tr.label}`}
                >
                  {tr.emoji} {tr.label}
                </button>
              ))}
              <span className="flex-1" />
              <span className="text-[10px] text-textMuted whitespace-nowrap">
                {t("learn.exercise", "Exercício")} {exIdx + 1}/{track.exercises.length}
              </span>
            </div>

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
                {done && hasNextEx && (
                  <button
                    onClick={nextExercise}
                    className="flex items-center gap-1 px-2 py-0.5 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover transition-colors"
                  >
                    {t("learn.nextExercise", "Próximo exercício")} <ArrowRight size={11} />
                  </button>
                )}
              </div>
              <p className="text-[11px] text-textMuted mt-1 leading-relaxed">{ex.statement}</p>
              <p className="text-[10px] text-textMuted opacity-70 mt-1 font-mono break-all">{ex.condition}</p>
              {/* A2 — barra de progresso da trilha: segmento por exercício (concluído / atual /
                  futuro), clicável pra pular. Persistido → o aprendiz vê o que já resolveu. */}
              <div className="flex items-center gap-1 mt-2">
                {track.exercises.map((e, i) => {
                  const isDone = completed.has(e.id);
                  const isCur = i === exIdx;
                  return (
                    <button
                      key={e.id}
                      onClick={() => gotoExercise(i)}
                      title={`${i + 1}. ${e.title}${isDone ? " ✓" : ""}`}
                      aria-label={`${i + 1}. ${e.title}`}
                      className={`h-1.5 flex-1 rounded-full transition-colors ${
                        isDone ? "bg-emerald-500" : isCur ? "bg-brand" : "bg-border hover:bg-textMuted/40"
                      }`}
                    />
                  );
                })}
                <span className="text-[9px] text-textMuted ml-1 tabular-nums">
                  {completed.size}/{track.exercises.length}
                </span>
              </div>
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
