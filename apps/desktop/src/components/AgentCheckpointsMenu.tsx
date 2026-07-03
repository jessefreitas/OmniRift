// src/components/AgentCheckpointsMenu.tsx
//
// Menu de CHECKPOINTS do OmniFS no header do AgentNode — a feature-assinatura:
// cada turno que editou o drive virou um snapshot (ver lib/agent-checkpoints.ts), e
// aqui o usuário lista esses pontos e VOLTA o drive pro estado de qualquer um deles.
//
// Degrada limpo: sem checkpoint (sem OmniFS, ou nenhum turno editou) → o componente
// NÃO renderiza nada (o botão nem aparece). O rollback é DESTRUTIVO e restaura a
// ÁRVORE INTEIRA do drive (v1 — não é por-arquivo) → duplo-confirm com aviso explícito,
// via componente React (NUNCA window.confirm — WebKitGTK não tem diálogo nativo inline).
//
// GOTCHA zustand v5 (loop-trap): o seletor devolve a REFERÊNCIA ESTÁVEL do array do nó
// (`s.checkpointsByNode[nodeId]`, só muda em record/clear DESTE nó) — nunca deriva
// array/objeto novo dentro do seletor. A ordenação (recente no topo) vai pro useMemo.
// Popover + modal saem por createPortal (o node é overflow-hidden + está sob o
// transform do canvas — um absolute interno seria clipado / mal-posicionado).

import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, History, Undo2, X } from "lucide-react";

import { useAgentCheckpoints, type Checkpoint } from "@/lib/agent-checkpoints";
import { omnifsRollback } from "@/lib/omnifs-client";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";

interface Props {
  nodeId: string;
  label?: string;
}

/** "há 2 min" / "há 3 h" / "há 1 dia" — relativo, curto, pt por padrão (via t). */
function fmtAgo(at: number, t: ReturnType<typeof useT>): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return t("checkpoints.now", "agora");
  const m = Math.floor(s / 60);
  if (m < 60) return `${t("checkpoints.ago", "há")} ${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${t("checkpoints.ago", "há")} ${h} h`;
  const d = Math.floor(h / 24);
  return `${t("checkpoints.ago", "há")} ${d} ${d === 1 ? t("checkpoints.day", "dia") : t("checkpoints.days", "dias")}`;
}

export function AgentCheckpointsMenu({ nodeId, label }: Props) {
  const t = useT();
  // Seletor CONSERVADOR: referência ESTÁVEL do array deste nó (só muda em record/clear
  // dele). Sem derivação aqui — a ordenação vai pro useMemo abaixo.
  const list = useAgentCheckpoints((s) => s.checkpointsByNode[nodeId]);
  // Mais recente no topo (cópia — não muta o store). Recalcula só quando `list` (ref) muda.
  const checkpoints = useMemo(() => (list ? [...list].reverse() : []), [list]);

  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<Checkpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<{ top: number; right: number } | null>(null);

  // Fecha o popover ao clicar fora / Esc.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (btnRef.current && btnRef.current.contains(target)) return;
      // Cliques dentro do popover (portal no body) têm data-checkpoints-pop no ancestral.
      if ((target as HTMLElement).closest?.("[data-checkpoints-pop]")) return;
      setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // Degrada limpo: sem checkpoint → não renderiza nada (botão nem aparece).
  if (checkpoints.length === 0) return null;

  function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    if (open) {
      setOpen(false);
      return;
    }
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setAnchor({ top: r.bottom + 4, right: Math.max(8, window.innerWidth - r.right) });
    setOpen(true);
  }

  async function doRollback(cp: Checkpoint) {
    setBusy(true);
    try {
      await omnifsRollback(cp.commit);
      setConfirming(null);
      setOpen(false);
      await notify(
        `${t("checkpoints.restored", "Drive restaurado para")} "${cp.message}".`,
        "info",
      );
    } catch (e) {
      setConfirming(null);
      await notify(
        `${t("checkpoints.restoreFail", "Falha ao restaurar o drive")}: ${e instanceof Error ? e.message : String(e)}`,
        "error",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        onPointerDown={(e) => e.stopPropagation()}
        className="nodrag p-0.5 rounded text-text/50 hover:bg-white/10 hover:text-brand transition-colors"
        title={t(
          "checkpoints.button",
          "Checkpoints do drive OmniFS — voltar o drive pro estado de um turno ({n})",
        ).replace("{n}", String(checkpoints.length))}
        aria-label={t("checkpoints.buttonShort", "Checkpoints do drive")}
        aria-haspopup="menu"
        aria-expanded={open}
      >
        <History size={13} />
      </button>

      {open &&
        anchor &&
        createPortal(
          <div
            data-checkpoints-pop
            role="menu"
            className="fixed z-[9000] w-72 max-h-[60vh] overflow-auto rounded-xl border border-border bg-surface2/95 backdrop-blur p-1.5 shadow-2xl text-xs"
            style={{ top: anchor.top, right: anchor.right }}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-1.5 px-2 py-1 text-[10px] uppercase tracking-wider text-textMuted">
              <History size={11} />
              {t("checkpoints.title", "Checkpoints do drive")}
            </div>
            {checkpoints.map((cp) => (
              <div
                key={cp.commit}
                className="flex items-start gap-2 rounded-lg px-2 py-1.5 hover:bg-surface1"
              >
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12px] text-text" title={cp.message}>
                    {cp.message}
                  </span>
                  <span className="block text-[10px] text-textMuted">
                    {fmtAgo(cp.at, t)} · <span className="font-mono">{cp.commit.slice(0, 8)}</span>
                    {!cp.ok && ` · ${t("checkpoints.turnError", "turno com erro")}`}
                  </span>
                </span>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    setConfirming(cp);
                  }}
                  className="shrink-0 rounded bg-white/5 px-1.5 py-0.5 text-[11px] text-text/70 hover:bg-brand/20 hover:text-brand transition-colors"
                  title={t("checkpoints.restore", "Restaurar o drive para este ponto")}
                >
                  <span className="inline-flex items-center gap-1">
                    <Undo2 size={11} /> {t("checkpoints.restoreShort", "restaurar")}
                  </span>
                </button>
              </div>
            ))}
            <p className="px-2 pt-1 pb-0.5 text-[10px] leading-snug text-textMuted">
              {t(
                "checkpoints.hint",
                "Cada turno que editou arquivos virou um snapshot do drive. Restaurar volta o drive INTEIRO — não um arquivo só.",
              )}
            </p>
          </div>,
          document.body,
        )}

      {confirming &&
        createPortal(
          <div
            className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4"
            onClick={() => !busy && setConfirming(null)}
            onPointerDown={(e) => e.stopPropagation()}
          >
            <div
              className="w-[520px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
              onClick={(e) => e.stopPropagation()}
            >
              <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
                <Undo2 size={15} className="text-brand" />
                <span className="text-sm font-medium text-text">
                  {t("checkpoints.confirmTitle", "Restaurar o drive OmniFS")}
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => !busy && setConfirming(null)}
                  className="text-textMuted hover:text-text p-1"
                >
                  <X size={16} />
                </button>
              </header>

              <div className="px-4 py-3 flex flex-col gap-3">
                <div className="flex items-start gap-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2">
                  <AlertTriangle size={15} className="text-danger mt-0.5 shrink-0" />
                  <p className="text-[12px] text-text leading-snug">
                    {t(
                      "checkpoints.confirmWarn",
                      "Isto restaura o drive OmniFS INTEIRO pro estado deste ponto (byte-fiel). Mudanças posteriores neste drive serão desfeitas.",
                    )}{" "}
                    <span className="text-textMuted">
                      {t(
                        "checkpoints.confirmFloorNote",
                        "Em paralelos isolados (worktree), afeta só aquele drive.",
                      )}
                    </span>
                  </p>
                </div>

                <div className="text-[12px] text-text">
                  <div className="text-textMuted text-[11px] uppercase tracking-wide mb-1">
                    {t("checkpoints.point", "Ponto")}
                    {label ? ` · ${label}` : ""}
                  </div>
                  <div>{confirming.message}</div>
                  <div className="font-mono text-brand text-[11px] mt-0.5">
                    {confirming.commit.slice(0, 12)} · {fmtAgo(confirming.at, t)}
                  </div>
                </div>
              </div>

              <footer className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
                <button
                  onClick={() => setConfirming(null)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:text-text disabled:opacity-40"
                >
                  {t("common.cancel", "Cancelar")}
                </button>
                <button
                  onClick={() => void doRollback(confirming)}
                  disabled={busy}
                  className="px-3 py-1.5 rounded-md text-xs bg-danger text-bg hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5"
                >
                  <Undo2 size={13} />
                  {busy
                    ? t("checkpoints.restoring", "Restaurando…")
                    : t("checkpoints.confirmBtn", "Restaurar o drive")}
                </button>
              </footer>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
