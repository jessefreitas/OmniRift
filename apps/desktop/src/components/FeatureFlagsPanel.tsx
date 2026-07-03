// src/components/FeatureFlagsPanel.tsx
//
// Painel de Feature flags — rollout gradual / kill-switch / gating de beta, LOCAL.
// Lista as flags conhecidas (label + descrição + badge de stage), um toggle por flag
// (liga/desliga o override local), "resetar pro padrão" por flag e "resetar todas".
// Mostra o valor EFETIVO e sinaliza quando difere do default (override do usuário).
// Espelha a estrutura/estilo do MobileDevicesModal (header/close/seções, portal).

import { createPortal } from "react-dom";
import { RotateCcw, ToggleLeft, X } from "lucide-react";

import { FLAGS, useFeatureFlagStore, type FlagStage } from "@/lib/feature-flags";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

interface Props {
  onClose: () => void;
}

// Cores do badge por maturidade (só visual).
const STAGE_STYLE: Record<FlagStage, string> = {
  stable: "text-green-400 bg-green-400/15",
  beta: "text-amber-400 bg-amber-400/15",
  experimental: "text-fuchsia-400 bg-fuchsia-400/15",
};
const STAGE_LABEL: Record<FlagStage, string> = {
  stable: "estável",
  beta: "beta",
  experimental: "experimental",
};

export function FeatureFlagsPanel({ onClose }: Props) {
  const t = useT();
  // Seletores conservadores: `overrides` é uma referência estável (só muda ao mutar);
  // as actions são estáveis. Nenhum seletor cria objeto/array inline → sem loop (v5).
  const overrides = useFeatureFlagStore((s) => s.overrides);
  const setFlag = useFeatureFlagStore((s) => s.setFlag);
  const resetFlag = useFeatureFlagStore((s) => s.resetFlag);
  const resetAll = useFeatureFlagStore((s) => s.resetAll);

  const overrideCount = Object.keys(overrides).length;

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[600px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <ToggleLeft size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("flags.title", "Feature flags")}</span>
          <button
            onClick={resetAll}
            disabled={overrideCount === 0}
            title={t("flags.resetAll", "Resetar todas pro padrão")}
            className="flex items-center gap-1 text-[11px] text-textMuted hover:text-brand px-1.5 py-1 rounded disabled:opacity-30 disabled:cursor-not-allowed"
          >
            <RotateCcw size={12} /> {t("flags.resetAllShort", "Resetar todas")}
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        <p className="px-4 py-2 text-[11px] text-textMuted border-b border-border">
          {t(
            "flags.intro",
            "Liga/desliga recursos localmente (rollout gradual, kill-switch, beta). A escolha vale só nesta máquina e persiste.",
          )}
        </p>

        <div className="flex-1 overflow-auto p-3 space-y-2">
          {FLAGS.map((f) => {
            const stage = f.stage ?? "stable";
            const overridden = f.key in overrides;
            const effective = overridden ? overrides[f.key] : f.default;
            return (
              <div key={f.key} className="rounded-md border border-border bg-bg/40 p-3">
                <div className="flex items-start gap-2">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5 flex-wrap">
                      <span className="text-sm text-text font-medium">{t("flag." + f.key, f.label)}</span>
                      <span className={cn("text-[9px] uppercase px-1.5 py-0.5 rounded shrink-0", STAGE_STYLE[stage])}>
                        {t("flagStage." + stage, STAGE_LABEL[stage])}
                      </span>
                      {overridden && (
                        <span className="text-[9px] text-brand bg-brand/15 px-1.5 py-0.5 rounded shrink-0">
                          {t("flags.overridden", "modificada")}
                        </span>
                      )}
                    </div>
                    <p className="text-[11px] text-textMuted mt-1 leading-snug">{t("flagDesc." + f.key, f.description)}</p>
                    <div className="text-[10px] text-textMuted opacity-70 mt-1 flex items-center gap-1.5">
                      <span>
                        {t("flags.effective", "Efetivo")}:{" "}
                        <b className={effective ? "text-green-400" : "text-textMuted"}>
                          {effective ? t("flags.on", "ligado") : t("flags.off", "desligado")}
                        </b>
                      </span>
                      <span className="opacity-50">·</span>
                      <span>
                        {t("flags.defaultIs", "padrão")}: {f.default ? t("flags.on", "ligado") : t("flags.off", "desligado")}
                      </span>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 shrink-0">
                    {overridden && (
                      <button
                        onClick={() => resetFlag(f.key)}
                        title={t("flags.reset", "Resetar pro padrão")}
                        className="text-textMuted hover:text-brand p-1"
                      >
                        <RotateCcw size={13} />
                      </button>
                    )}
                    <button
                      role="switch"
                      aria-checked={effective}
                      onClick={() => setFlag(f.key, !effective)}
                      title={effective ? t("flags.turnOff", "Desligar") : t("flags.turnOn", "Ligar")}
                      className={cn(
                        "relative h-5 w-9 rounded-full transition-colors shrink-0",
                        effective ? "bg-brand" : "bg-surface2 border border-border",
                      )}
                    >
                      <span
                        className={cn(
                          "absolute top-0.5 h-4 w-4 rounded-full bg-white shadow transition-all",
                          effective ? "left-[18px]" : "left-0.5",
                        )}
                      />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <footer className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          {t(
            "flags.footer",
            "Local por máquina. Um rollout remoto (via Cloudflare Worker) pode chegar depois — seu override sempre vence.",
          )}
        </footer>
      </div>
    </div>,
    document.body,
  );
}
