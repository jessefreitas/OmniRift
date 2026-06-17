/**
 * ClisModal.tsx
 *
 * Modal para gerenciamento de CLIs de agentes de IA. Lista CLIs conhecidas,
 * permite instalar/desinstalar com um clique e acompanhar o progresso local
 * da instalação. Usa createPortal para renderizar sobre a aplicação Tauri.
 */

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Download, ExternalLink, RefreshCw, Trash2, X, CheckCircle2 } from "lucide-react";
import {
  clisList,
  cliInstall,
  cliUninstall,
  type CliInfo,
  type InstallProgress,
  CLI_CATALOG,
  openHomepage,
} from "@/lib/clis-client";
import { cn } from "@/lib/cn";

interface ClisModalProps {
  onClose: () => void;
}

const tierLabels: Record<"official" | "community", string> = {
  official: "oficial",
  community: "community",
};

export function ClisModal({ onClose }: ClisModalProps) {
  const [clis, setClis] = useState<CliInfo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [installingId, setInstallingId] = useState<string | null>(null);
  const [progress, setProgress] = useState<InstallProgress | null>(null);

  const fetchList = async (withLoading = false) => {
    if (withLoading) setLoading(true);
    setError(null);
    try {
      const list = await clisList();
      setClis(list);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (withLoading) setLoading(false);
    }
  };

  useEffect(() => {
    fetchList(true);
  }, []);

  const handleInstall = async (id: string) => {
    setError(null);
    setInstallingId(id);
    setProgress(null);

    try {
      const updated = await cliInstall(id, (p) => setProgress(p));
      setClis((prev) => (prev ? prev.map((c) => (c.id === id ? updated : c)) : [updated]));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingId(null);
      setProgress(null);
    }
  };

  const handleUninstall = async (cli: CliInfo) => {
    if (!window.confirm(`Remover ${cli.label} do sistema?`)) return;

    setError(null);
    setInstallingId(cli.id);
    setProgress(null);

    try {
      await cliUninstall(cli.id);
      await fetchList(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setInstallingId(null);
    }
  };

  return createPortal(
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
      role="dialog"
      aria-modal="true"
    >
      <div
        className="w-[680px] max-w-[94vw] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <div className="flex items-center gap-2">
            <Download size={15} className="text-brand shrink-0" />
            <h2 className="text-sm font-medium text-text">CLIs de agentes</h2>
          </div>

          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => fetchList(true)}
              disabled={loading}
              className={cn(
                "flex items-center gap-1.5 px-2 py-1 rounded text-[11px] text-textMuted border border-border",
                "hover:text-brand hover:bg-surface2 transition-colors",
                loading && "opacity-50 cursor-not-allowed"
              )}
            >
              <RefreshCw size={14} className={cn(loading && "animate-spin")} />
              Atualizar
            </button>

            <button
              type="button"
              onClick={onClose}
              className="p-1 rounded text-textMuted hover:text-danger hover:bg-surface2 transition-colors"
              aria-label="Fechar"
            >
              <X size={15} />
            </button>
          </div>
        </div>

        <div className="flex-1 overflow-auto p-3 space-y-3">
          {error && (
            <div className="text-[11px] text-danger border-b border-border break-words pb-2">
              {error}
            </div>
          )}

          {loading && clis === null ? (
            <div className="text-sm text-textMuted text-center py-8">Carregando…</div>
          ) : clis === null || clis.length === 0 ? (
            <div className="text-sm text-textMuted text-center py-8">
              Nenhuma CLI encontrada.
            </div>
          ) : (
            clis.map((cli) => {
              const catalog = CLI_CATALOG.find((c) => c.id === cli.id);
              const isWorking = installingId === cli.id;

              return (
                <div
                  key={cli.id}
                  className="flex items-center gap-3 p-2.5 rounded-md border border-border bg-surface2/50"
                >
                  <div className="text-xl shrink-0">{catalog?.emoji ?? "🤖"}</div>

                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[12px] font-medium text-text truncate">
                        {cli.label}
                      </span>
                      {catalog && (
                        <span className="text-[10px] px-1.5 py-0.5 rounded bg-surface1 border border-border text-textMuted">
                          {catalog.vendor} · {tierLabels[catalog.tier]}
                        </span>
                      )}
                    </div>
                    <p className="text-[10px] text-textMuted opacity-70 leading-snug mt-0.5 line-clamp-2">
                      {cli.description}
                    </p>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    {cli.installed ? (
                      <div className="flex items-center gap-1.5 text-[10px] text-brand bg-brand/10 px-2 py-0.5 rounded-full border border-brand/20">
                        <CheckCircle2 size={11} />
                        <span>instalado</span>
                      </div>
                    ) : (
                      <span className="text-[10px] text-textMuted">não instalado</span>
                    )}

                    {cli.installed && cli.version && (
                      <span className="text-[10px] text-textMuted font-mono">
                        {cli.version}
                      </span>
                    )}

                    {isWorking && progress && (
                      <span className="text-[11px] text-brand font-mono">
                        {progress.stage}: {progress.message}
                      </span>
                    )}

                    <div className="flex items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => openHomepage(cli.homepage)}
                        className="p-1 rounded text-textMuted hover:text-brand hover:bg-surface2 transition-colors"
                        aria-label="Abrir site oficial"
                        title="Abrir site oficial"
                      >
                        <ExternalLink size={13} />
                      </button>

                      {cli.installed ? (
                        <button
                          type="button"
                          onClick={() => handleUninstall(cli)}
                          disabled={isWorking}
                          className={cn(
                            "flex items-center gap-1 px-2 py-1 rounded border border-border text-[11px] text-danger hover:bg-surface2 transition-colors",
                            isWorking && "opacity-50 cursor-not-allowed"
                          )}
                        >
                          <Trash2 size={12} />
                          Remover
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleInstall(cli.id)}
                          disabled={isWorking}
                          className={cn(
                            "flex items-center gap-1 px-2.5 py-1 rounded text-[11px] bg-brand text-bg hover:bg-brand-hover transition-colors",
                            isWorking && "opacity-70 cursor-not-allowed"
                          )}
                        >
                          <Download size={12} />
                          Instalar
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>

        <div className="px-4 py-2 border-t border-border text-[10px] text-textMuted opacity-60 shrink-0">
          CLIs oficiais e da comunidade, instalados via npm/pipx/curl. Sem telemetria — a
          instalação roda localmente.
        </div>
      </div>
    </div>,
    document.body
  );
}