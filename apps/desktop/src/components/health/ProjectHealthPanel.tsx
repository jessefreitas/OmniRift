// src/components/health/ProjectHealthPanel.tsx
//
// Overlay grande "Saúde do Projeto" (spec 2026-06-23, Fase A). 1 por projeto,
// gated em `currentCwd`. Header didático (o "por que existe") + toggles de
// dimensão (☑ Código ativo; ☐ Banco de Dados — "em breve" nesta fase) + corpo.
//
// Abrir → dispara `projectScan(currentCwd)` e popula PROGRESSIVO: registra os
// listeners do streaming, acumula `health://file`, fecha o resumo no
// `health://scan-done`. Limpa os listeners no unmount (cleanup do efeito).
//
// Aberto via botão na CanvasToolbar + entrada na CommandPalette (CustomEvent
// "omnirift:open-tool" → "project-health", roteado na Sidebar).

import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Activity, X, RefreshCw, Loader2, Code2, Database } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import {
  projectScan,
  listenHealthScan,
  type FileHealth,
  type ScanSummary,
} from "@/lib/health-client";
import { CodeDimension } from "./CodeDimension";

type Dimension = "code" | "db";

export function ProjectHealthPanel({ onClose }: { onClose: () => void }) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd);

  const [active, setActive] = useState<Dimension>("code");
  const [files, setFiles] = useState<FileHealth[]>([]);
  const [summary, setSummary] = useState<ScanSummary | null>(null);
  const [scanning, setScanning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Token p/ descartar resultados de scans antigos (re-scan / unmount).
  const scanToken = useRef(0);

  async function runScan(root: string) {
    const token = ++scanToken.current;
    setScanning(true);
    setError(null);
    setFiles([]);
    setSummary(null);

    // Listeners ANTES de disparar — o backend emite enquanto calcula.
    const unlisten = await listenHealthScan({
      onFile: (f) => {
        if (scanToken.current !== token) return;
        // Dedup por path (re-scan pode reemitir; mantém o mais recente).
        setFiles((prev) => {
          const idx = prev.findIndex((p) => p.path === f.path);
          if (idx === -1) return [...prev, f];
          const next = [...prev];
          next[idx] = f;
          return next;
        });
      },
      onDone: (s) => {
        if (scanToken.current !== token) return;
        setSummary(s);
      },
    });

    try {
      const final = await projectScan(root);
      if (scanToken.current === token) setSummary(final);
    } catch (e) {
      if (scanToken.current === token) setError(String(e));
    } finally {
      if (scanToken.current === token) setScanning(false);
      unlisten();
    }
  }

  // Dispara o scan ao abrir (e quando troca o projeto).
  useEffect(() => {
    if (!currentCwd) return;
    void runScan(currentCwd);
    return () => {
      // Invalida o scan corrente — listeners já são limpos no finally do runScan.
      scanToken.current++;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentCwd]);

  const dimensions: Array<{ id: Dimension; label: string; icon: typeof Code2; disabled?: boolean; soon?: boolean }> = [
    { id: "code", label: t("health.dimCode", "Código"), icon: Code2 },
    { id: "db", label: t("health.dimDb", "Banco de Dados"), icon: Database, disabled: true, soon: true },
  ];

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[920px] max-w-[96vw] h-[80vh] max-h-[860px] rounded-xl border border-border bg-bg shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header didático */}
        <header className="px-5 pt-4 pb-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Activity size={18} className="text-brand" />
            <h2 className="text-base font-semibold text-text">{t("health.title", "Saúde do Projeto")}</h2>
            <div className="flex-1" />
            <button
              type="button"
              onClick={() => currentCwd && void runScan(currentCwd)}
              disabled={!currentCwd || scanning}
              title={t("health.rescan", "Re-escanear")}
              className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded text-textMuted hover:text-text disabled:opacity-40"
            >
              {scanning ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />}
              {t("health.rescan", "Re-escanear")}
            </button>
            <button type="button" onClick={onClose} className="text-textMuted hover:text-text p-1">
              <X size={16} />
            </button>
          </div>
          <p className="mt-1.5 text-[12px] text-textMuted leading-snug max-w-[760px]">
            {t(
              "health.why",
              "Mapeia a saúde do projeto num lugar só: acha os arquivos mais complexos/arriscados (onde bug nasce e refactor compensa) e a estrutura do seu banco — e pede análise de IA pra você agir antes que vire problema.",
            )}
          </p>
          {currentCwd && (
            <p className="mt-1 text-[11px] font-mono text-textMuted opacity-60 truncate" title={currentCwd}>
              {currentCwd}
            </p>
          )}

          {/* Toggles de dimensão */}
          <div className="mt-3 flex items-center gap-1.5">
            {dimensions.map((d) => {
              const Icon = d.icon;
              const isActive = active === d.id;
              return (
                <button
                  key={d.id}
                  type="button"
                  disabled={d.disabled}
                  onClick={() => !d.disabled && setActive(d.id)}
                  className={[
                    "flex items-center gap-1.5 px-3 py-1.5 text-[12px] rounded-lg border transition-colors",
                    isActive
                      ? "border-brand bg-brand/10 text-brand"
                      : "border-border bg-surface1 text-textMuted hover:text-text",
                    d.disabled ? "opacity-40 cursor-not-allowed" : "",
                  ].join(" ")}
                  title={d.soon ? t("health.comingSoon", "Em breve") : d.label}
                >
                  <span aria-hidden>{isActive ? "☑" : "☐"}</span>
                  <Icon size={13} />
                  {d.label}
                  {d.soon && (
                    <span className="text-[9px] uppercase tracking-wide opacity-70">
                      {t("health.soon", "em breve")}
                    </span>
                  )}
                </button>
              );
            })}
          </div>
        </header>

        {/* Corpo */}
        <div className="flex-1 overflow-y-auto px-5 py-4">
          {!currentCwd ? (
            <div className="h-full flex items-center justify-center text-center">
              <p className="text-[13px] text-textMuted max-w-[360px]">
                {t("health.noProject", "Abra um projeto primeiro para escanear a saúde do código.")}
              </p>
            </div>
          ) : error ? (
            <div className="rounded-lg border border-red-400/30 bg-red-400/5 p-4">
              <p className="text-[13px] text-red-400 font-medium">{t("health.scanError", "Falha no scan")}</p>
              <p className="text-[12px] text-textMuted mt-1 whitespace-pre-wrap">{error}</p>
            </div>
          ) : active === "code" ? (
            <CodeDimension files={files} summary={summary} scanning={scanning} />
          ) : (
            <div className="h-full flex items-center justify-center text-center">
              <p className="text-[13px] text-textMuted max-w-[360px]">
                {t("health.dbSoon", "A dimensão Banco de Dados chega numa próxima fase.")}
              </p>
            </div>
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
