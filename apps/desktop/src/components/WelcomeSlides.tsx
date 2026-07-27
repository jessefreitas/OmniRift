import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n";

export function WelcomeSlides({ onDone }: { onDone: () => void }) {
  const t = useT();
  const [step, setStep] = useState(0);

  // Atalhos de teclado: direita/Enter avançam, esquerda volta, Esc fecha.
  useEffect(() => {
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onDone();
        return;
      }

      if (e.key === "ArrowRight") {
        e.preventDefault();
        setStep((s) => Math.min(s + 1, 3));
        return;
      }

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        setStep((s) => Math.max(s - 1, 0));
        return;
      }

      if (e.key === "Enter") {
        // Deixa o Enter padrão dos botões funcionar (ex.: Pular/Começar).
        if (document.activeElement instanceof HTMLButtonElement) return;
        e.preventDefault();
        if (step === 3) onDone();
        else setStep((s) => Math.min(s + 1, 3));
      }
    };

    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [step, onDone]);

  const next = () => {
    if (step === 3) onDone();
    else setStep((s) => s + 1);
  };

  const prev = () => setStep((s) => Math.max(s - 1, 0));

  const slides = [
    {
      title: t("welcome.hello", "Bem-vindo ao OmniRift"),
      desc: t(
        "welcome.helloDescription",
        "Um canvas onde você e seus agentes de IA trabalham lado a lado."
      ),
      art: (
        <div className="flex justify-center py-2">
          <div className="flex h-28 w-28 items-center justify-center rounded-full bg-gradient-to-br from-violet-500 to-fuchsia-600 text-3xl font-bold text-white shadow-lg">
            OR
          </div>
        </div>
      ),
    },
    {
      title: t("welcome.canvas", "Um canvas, não uma lista"),
      desc: t(
        "welcome.canvasDescription",
        "Cada terminal, agente e nota fica onde você colocou. Arraste, agrupe, volte depois: o lugar das coisas é seu."
      ),
      art: (
        <div className="relative h-40 w-full overflow-hidden rounded-xl border border-border bg-[radial-gradient(circle,rgba(120,120,120,0.22)_1px,transparent_1px)] bg-[length:20px_20px]">
          <div className="absolute left-5 top-5 flex items-center gap-1.5 rounded-md border border-border bg-surface2 px-3 py-2 shadow-sm">
            <span className="font-mono text-textMuted">&gt;_</span>
            <span className="text-xs">{t("welcome.terminal", "terminal")}</span>
          </div>
          <div className="absolute right-6 top-8 w-28 rounded-md border border-yellow-500/30 bg-yellow-500/15 p-2">
            <div className="mb-1.5 h-1.5 w-20 rounded bg-yellow-500/50" />
            <div className="h-1.5 w-14 rounded bg-yellow-500/40" />
          </div>
          <div className="absolute left-1/2 top-24 flex -translate-x-1/2 items-center gap-2 rounded-md border border-blue-500/30 bg-blue-500/15 px-3 py-2 shadow-sm">
            <div className="h-4 w-4 rounded-full bg-blue-500/60" />
            <span className="text-xs font-medium">{t("welcome.agent", "agente")}</span>
          </div>
        </div>
      ),
    },
    {
      title: t("welcome.agents", "Agentes que conversam"),
      desc: t(
        "welcome.agentsDescription",
        "Ligue a saída de um agente na entrada de outro e eles trocam contexto sozinhos, em tempo real."
      ),
      art: (
        <div className="relative flex h-40 items-center justify-center gap-10">
          <div className="z-10 rounded-xl border border-border bg-surface2 p-3 shadow-sm">
            <div className="mb-1 text-xs text-textMuted">
              {t("welcome.agentA", "Agente A")}
            </div>
            <div className="h-2 w-24 rounded bg-text/20" />
          </div>

          <svg
            className="absolute inset-0 h-full w-full text-textMuted"
            viewBox="0 0 320 160"
            preserveAspectRatio="none"
            aria-hidden="true"
          >
            <defs>
              <marker
                id="welcome-arrow"
                markerWidth="10"
                markerHeight="10"
                refX="9"
                refY="3"
                orient="auto"
                markerUnits="strokeWidth"
              >
                <path d="M0,0 L0,6 L9,3 z" fill="currentColor" />
              </marker>
            </defs>
            <line
              x1="110"
              y1="80"
              x2="210"
              y2="80"
              stroke="currentColor"
              strokeWidth="2"
              markerEnd="url(#welcome-arrow)"
            />
          </svg>

          <div className="z-10 rounded-xl border border-border bg-surface2 p-3 shadow-sm">
            <div className="mb-1 text-xs text-textMuted">
              {t("welcome.agentB", "Agente B")}
            </div>
            <div className="h-2 w-24 rounded bg-text/20" />
          </div>
        </div>
      ),
    },
    {
      title: t("welcome.simple", "Começando pelo simples"),
      desc: t(
        "welcome.simpleDescription",
        "O app abre com o essencial: terminal, agente e nota. Quando quiser o resto — quadro de tarefas, andares, rotinas, mapa do código — é um clique em 'Ver tudo' na barra lateral."
      ),
      art: (
        <div className="w-full space-y-2 py-1">
          {[
            {
              key: "welcome.itemTerminal",
              text: "Terminal e canvas",
            },
            {
              key: "welcome.itemDefaultAgent",
              text: "Agente padrão",
            },
            {
              key: "welcome.itemWelcomeNote",
              text: "Nota de boas-vindas",
            },
          ].map((item) => (
            <div key={item.key} className="flex items-center gap-3">
              <svg
                className="h-4 w-4 text-green-500"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
                <path d="M3 8l3 3 7-7" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              <span className="text-sm text-text">{t(item.key, item.text)}</span>
            </div>
          ))}
          {[
            { key: "welcome.comingTasks", text: "Quadro de tarefas" },
            { key: "welcome.comingFloors", text: "Andares e rotinas" },
            { key: "welcome.comingCodeMap", text: "Mapa do código" },
          ].map((item) => (
            <div key={item.key} className="flex items-center gap-3 opacity-40">
              <div className="h-4 w-4 rounded-full border border-textMuted" />
              <span className="text-sm text-textMuted">{t(item.key, item.text)}</span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  const current = slides[step];

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("welcome.dialogLabel", "Boas-vindas ao OmniRift")}
      className="fixed inset-0 z-50 flex items-center justify-center bg-bg/85 backdrop-blur-sm"
    >
      <style>{"@keyframes welcomeFade { from { opacity: 0 } to { opacity: 1 } }"}</style>
      <div className="w-full max-w-[560px] rounded-2xl border border-border bg-surface1 p-8 text-text shadow-2xl">
        <div
          key={step}
          className="flex min-h-[260px] flex-col gap-6"
          style={{ animation: "welcomeFade 200ms ease-out" }}
        >
          {current.art}

          <div className="space-y-2">
            <h2 className="text-2xl font-semibold">{current.title}</h2>
            <p className="text-base text-textMuted">{current.desc}</p>
          </div>
        </div>

        <footer className="relative mt-8 flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onDone}
              className="text-sm text-textMuted transition-colors hover:text-text"
            >
              {t("welcome.skip", "Pular")}
            </button>

            {step > 0 && (
              <button
                type="button"
                onClick={prev}
                className="text-sm text-textMuted transition-colors hover:text-text"
              >
                {t("welcome.back", "Voltar")}
              </button>
            )}
          </div>

          <div className="absolute left-1/2 top-1/2 flex -translate-x-1/2 -translate-y-1/2 items-center gap-2">
            {[0, 1, 2, 3].map((i) => (
              <span
                key={i}
                className={`rounded-full transition-all ${
                  i === step
                    ? "h-2 w-2 bg-brand"
                    : "h-1.5 w-1.5 bg-textMuted/50"
                }`}
                aria-hidden="true"
              />
            ))}
          </div>

          <button
            type="button"
            onClick={next}
            className="rounded-lg bg-brand px-4 py-2 text-sm font-medium text-bg transition-colors hover:bg-brand-hover"
          >
            {step === 3
              ? t("welcome.start", "Começar")
              : t("welcome.continue", "Continuar")}
          </button>
        </footer>
      </div>
    </div>
  );
}
