// src/components/FluencyChip.tsx
//
// Sinal VISÍVEL do gate de fluidez: aparece quando MAIN-BLOCK / RENDER-LOOP /
// REMOUNT-CHURN estoura o limiar. Sem telemetria — só estado local + debug.log.

import { useEffect, useRef, useState } from "react";
import {
  FLUENCY,
  getRecentFluencyAlerts,
  subscribeFluencyAlerts,
  type FluencyAlert,
} from "@/lib/canvas-fluency";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

function labelFor(a: FluencyAlert): string {
  switch (a.kind) {
    case "MAIN-BLOCK":
      return a.severity === "severo" ? "main travada" : "jank";
    case "RENDER-LOOP":
      return "render-loop";
    case "REMOUNT-CHURN":
      return "remount";
  }
}

function alertsSignature(alerts: FluencyAlert[]): string {
  if (alerts.length === 0) return "";
  const last = alerts[alerts.length - 1]!;
  return `${alerts.length}:${last.kind}:${last.atMs}`;
}

export function FluencyChip() {
  const t = useT();
  const [alerts, setAlerts] = useState<FluencyAlert[]>(() => getRecentFluencyAlerts());
  const intervalRef = useRef<number | null>(null);

  useEffect(() => {
    const apply = (next: FluencyAlert[]) => {
      setAlerts((prev) => (alertsSignature(prev) === alertsSignature(next) ? prev : next));
    };

    const disarm = () => {
      if (intervalRef.current !== null) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
    };

    const arm = () => {
      if (intervalRef.current !== null) return;
      // Tick só enquanto há alerta (pra TTL sumir sem re-render eterno no App).
      intervalRef.current = window.setInterval(() => {
        const next = getRecentFluencyAlerts();
        apply(next);
        if (next.length === 0) disarm();
      }, 2000);
    };

    const onAlert = () => {
      apply(getRecentFluencyAlerts());
      arm();
    };

    const unsub = subscribeFluencyAlerts(onAlert);
    if (getRecentFluencyAlerts().length > 0) arm();

    return () => {
      unsub();
      disarm();
    };
  }, []);

  if (alerts.length === 0) return null;

  const last = alerts[alerts.length - 1]!;
  const severe = alerts.some((a) => a.severity === "severo" || a.kind === "RENDER-LOOP");
  const title = [
    t("fluency.chipTitle", "Fluidez do canvas — limiar estourado (também em ~/.omnirift/debug.log)"),
    ...alerts.slice(-5).map((a) => `${a.kind}: ${a.detail}`),
  ].join("\n");

  return (
    <div
      role="status"
      aria-live="polite"
      title={title}
      className={cn(
        "fixed bottom-3 right-[11.5rem] z-[55] flex items-center gap-1.5 px-2.5 py-1 rounded-full",
        "border bg-surface2/90 backdrop-blur shadow-lg text-[11px] font-mono select-none",
        severe ? "border-danger/50 text-danger" : "border-yellow-400/50 text-yellow-400",
      )}
      data-fluency-alerts={alerts.length}
      data-fluency-last-kind={last.kind}
    >
      <span aria-hidden>⏱</span>
      <span>
        {labelFor(last)}
        {alerts.length > 1 ? ` ·×${alerts.length}` : ""}
      </span>
      <span className="text-textMuted opacity-50 text-[10px]">
        {Math.max(0, Math.ceil((FLUENCY.CHIP_TTL_MS - (Date.now() - last.atMs)) / 1000))}s
      </span>
    </div>
  );
}
