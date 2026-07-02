// src/components/OmniGraphDiffModal.tsx
//
// OmniGraph F5 — DIFF TEMPORAL (MVP textual). Compara DOIS snapshots do graph.json (o loop F4
// tira um automático a cada rebuild; dá pra forçar um aqui) e mostra o que MUDOU na arquitetura:
// nós/arestas +/-, god nodes que emergiram, e — o eixo que importa — ambiguidades RESOLVIDAS
// (o loop limpou) vs NOVAS. Não renderiza 2 grafos lado a lado (MVP): só o resumo textual, que
// já responde "a arquitetura melhorou ou piorou entre A e B?".
//
// UI in-DOM (WebKitGTK não tem diálogo nativo — memória do projeto): overlay próprio, sem
// window.open/alert/confirm. Fecha no X, no ESC e no clique fora.

import { useEffect, useState } from "react";
import { GitCompare, Loader2, X, Camera, ArrowRight } from "lucide-react";

import {
  omnigraphListSnapshots,
  omnigraphDiff,
  omnigraphSnapshotGraph,
  EMPTY_DIFF,
  type GraphSnapshotInfo,
  type GraphDiff,
  type GraphDiffEdge,
} from "@/lib/omnigraph-client";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

interface Props {
  cwd: string;
  open: boolean;
  onClose: () => void;
}

/** Máx. de itens listados por seção do diff (o resto vira "+N"), pra não estourar o DOM. */
const MAX_LIST = 15;

function fmtTs(ts: number): string {
  try {
    return new Date(ts).toLocaleString();
  } catch {
    return String(ts);
  }
}

export function OmniGraphDiffModal({ cwd, open, onClose }: Props) {
  const t = useT();
  const [snaps, setSnaps] = useState<GraphSnapshotInfo[]>([]);
  const [aPath, setAPath] = useState("");
  const [bPath, setBPath] = useState("");
  const [diff, setDiff] = useState<GraphDiff | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);

  async function reload() {
    setLoading(true);
    try {
      const list = await omnigraphListSnapshots(cwd);
      setSnaps(list);
      // Default: B = mais recente (list[0]), A = o anterior (list[1]).
      if (list.length > 0) setBPath((prev) => prev || list[0].path);
      if (list.length > 1) setAPath((prev) => prev || list[1].path);
    } catch (e) {
      void notify(String(e), "error");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!open) return;
    setDiff(null);
    setAPath("");
    setBPath("");
    void reload();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, cwd]);

  if (!open) return null;

  async function handleSnapshot() {
    if (busy) return;
    setBusy(true);
    try {
      await omnigraphSnapshotGraph(cwd);
      void notify(t("diff.snapped", "Snapshot da arquitetura gravado."), "info");
      await reload();
    } catch (e) {
      void notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  async function handleCompare() {
    if (busy) return;
    if (!aPath || !bPath) {
      void notify(t("diff.pickBoth", "Escolha os dois snapshots (antes e depois)."), "error");
      return;
    }
    if (aPath === bPath) {
      void notify(t("diff.same", "Escolha snapshots diferentes pra comparar."), "error");
      return;
    }
    setBusy(true);
    try {
      const d = await omnigraphDiff(cwd, aPath, bPath);
      setDiff(d);
    } catch (e) {
      setDiff(EMPTY_DIFF);
      void notify(String(e), "error");
    } finally {
      setBusy(false);
    }
  }

  const selCls =
    "min-w-0 flex-1 rounded-md border border-border bg-surface1 px-2 py-1 text-[11px] text-text";

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[min(560px,92vw)] flex-col overflow-hidden rounded-lg border border-border bg-bg shadow-xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 border-b border-border px-3 py-2">
          <GitCompare size={15} className="text-brand" />
          <span className="flex-1 text-sm font-semibold text-text">
            {t("diff.title", "Comparar arquitetura (diff temporal)")}
          </span>
          <button onClick={onClose} className="p-0.5 text-textMuted hover:text-text" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto p-3 text-xs">
          {loading ? (
            <div className="flex items-center gap-2 text-textMuted">
              <Loader2 size={14} className="animate-spin" /> {t("diff.loading", "Carregando snapshots…")}
            </div>
          ) : snaps.length < 2 ? (
            <div className="space-y-3 text-textMuted">
              <p>
                {t(
                  "diff.needTwo",
                  "Preciso de pelo menos 2 snapshots pra comparar. O OmniGraph tira um automático a cada rebuild (loop F4) — trabalhe um pouco, ou force um agora.",
                )}
              </p>
              <p className="text-[11px] text-text/50">
                {t("diff.have", "Snapshots atuais")}: {snaps.length}
              </p>
              <button
                onClick={handleSnapshot}
                disabled={busy}
                className="flex items-center gap-1.5 rounded-md border border-border bg-surface1 px-2.5 py-1 text-[11px] text-text hover:border-brand/50 disabled:opacity-60"
              >
                {busy ? <Loader2 size={13} className="animate-spin" /> : <Camera size={13} />}
                {t("diff.snapNow", "tirar snapshot agora")}
              </button>
            </div>
          ) : (
            <>
              {/* Seletores A → B */}
              <div className="mb-3 flex items-center gap-2">
                <select className={cn(selCls)} value={aPath} onChange={(e) => setAPath(e.target.value)}>
                  <option value="">{t("diff.pickA", "antes (A)…")}</option>
                  {snaps.map((s) => (
                    <option key={s.path} value={s.path}>
                      {fmtTs(s.ts)}
                    </option>
                  ))}
                </select>
                <ArrowRight size={14} className="shrink-0 text-textMuted" />
                <select className={cn(selCls)} value={bPath} onChange={(e) => setBPath(e.target.value)}>
                  <option value="">{t("diff.pickB", "depois (B)…")}</option>
                  {snaps.map((s) => (
                    <option key={s.path} value={s.path}>
                      {fmtTs(s.ts)}
                    </option>
                  ))}
                </select>
              </div>
              <div className="mb-3 flex items-center gap-2">
                <button
                  onClick={handleCompare}
                  disabled={busy}
                  className="flex items-center gap-1.5 rounded-md border border-brand/50 bg-brand/10 px-2.5 py-1 text-[11px] text-text hover:bg-brand/20 disabled:opacity-60"
                >
                  {busy ? <Loader2 size={13} className="animate-spin" /> : <GitCompare size={13} />}
                  {t("diff.compare", "comparar")}
                </button>
                <button
                  onClick={handleSnapshot}
                  disabled={busy}
                  title={t("diff.snapTip", "Grava um snapshot da arquitetura AGORA")}
                  className="flex items-center gap-1.5 rounded-md border border-border bg-surface1 px-2 py-1 text-[11px] text-textMuted hover:border-brand/50 hover:text-text disabled:opacity-60"
                >
                  <Camera size={13} />
                </button>
              </div>

              {diff && <DiffSummary diff={diff} t={t} />}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function DiffSummary({ diff, t }: { diff: GraphDiff; t: (k: string, f?: string) => string }) {
  const changed =
    diff.addedNodes.length +
    diff.removedNodes.length +
    diff.addedEdges.length +
    diff.removedEdges.length +
    diff.newGodNodes.length +
    diff.resolvedAmbiguous.length +
    diff.newAmbiguous.length;

  if (changed === 0) {
    return (
      <div className="rounded-md border border-border bg-surface1/60 p-3 text-[11px] text-textMuted">
        {t("diff.identical", "Nenhuma mudança estrutural entre os dois snapshots.")}
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {/* Headline: os números que importam. */}
      <div className="flex flex-wrap gap-1.5 text-[10px]">
        <Chip n={diff.addedNodes.length} label={t("diff.addedNodes", "nós novos")} tone="add" />
        <Chip n={diff.removedNodes.length} label={t("diff.removedNodes", "nós removidos")} tone="rm" />
        <Chip n={diff.newGodNodes.length} label={t("diff.newGods", "god nodes surgiram")} tone="warn" />
        <Chip n={diff.resolvedAmbiguous.length} label={t("diff.resolved", "ambiguidades resolvidas")} tone="add" />
        <Chip n={diff.newAmbiguous.length} label={t("diff.newAmbiguous", "ambiguidades novas")} tone="warn" />
        <Chip n={diff.addedEdges.length} label={t("diff.addedEdges", "arestas novas")} tone="neutral" />
        <Chip n={diff.removedEdges.length} label={t("diff.removedEdges", "arestas removidas")} tone="neutral" />
      </div>

      <Section title={t("diff.newGodsTitle", "God nodes que surgiram (dívida)")} items={diff.newGodNodes} tone="warn" />
      <EdgeSection title={t("diff.resolvedTitle", "Ambiguidades resolvidas (o loop limpou)")} edges={diff.resolvedAmbiguous} tone="add" />
      <EdgeSection title={t("diff.newAmbiguousTitle", "Ambiguidades novas (acoplamento incerto)")} edges={diff.newAmbiguous} tone="warn" />
      <Section title={t("diff.addedNodesTitle", "Nós novos")} items={diff.addedNodes} tone="add" />
      <Section title={t("diff.removedNodesTitle", "Nós removidos")} items={diff.removedNodes} tone="rm" />
    </div>
  );
}

function toneCls(tone: "add" | "rm" | "warn" | "neutral"): string {
  switch (tone) {
    case "add":
      return "text-emerald-300 border-emerald-500/30 bg-emerald-500/10";
    case "rm":
      return "text-rose-300 border-rose-500/30 bg-rose-500/10";
    case "warn":
      return "text-amber-300 border-amber-500/30 bg-amber-500/10";
    default:
      return "text-textMuted border-border bg-surface1/60";
  }
}

function Chip({ n, label, tone }: { n: number; label: string; tone: "add" | "rm" | "warn" | "neutral" }) {
  if (n === 0) return null;
  return (
    <span className={cn("rounded border px-1.5 py-0.5 font-semibold", toneCls(tone))}>
      {n} {label}
    </span>
  );
}

function Section({ title, items, tone }: { title: string; items: string[]; tone: "add" | "rm" | "warn" | "neutral" }) {
  if (items.length === 0) return null;
  const shown = items.slice(0, MAX_LIST);
  const extra = items.length - shown.length;
  return (
    <div>
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-text/50">{title}</div>
      <div className="flex flex-wrap gap-1">
        {shown.map((it, i) => (
          <span key={`${it}-${i}`} className={cn("truncate rounded border px-1.5 py-0.5 font-mono text-[10px]", toneCls(tone))} title={it}>
            {it}
          </span>
        ))}
        {extra > 0 && <span className="px-1 py-0.5 text-[10px] italic text-text/40">+{extra}</span>}
      </div>
    </div>
  );
}

function EdgeSection({ title, edges, tone }: { title: string; edges: GraphDiffEdge[]; tone: "add" | "rm" | "warn" | "neutral" }) {
  if (edges.length === 0) return null;
  const shown = edges.slice(0, MAX_LIST);
  const extra = edges.length - shown.length;
  return (
    <div>
      <div className="mb-1 text-[9px] font-semibold uppercase tracking-wider text-text/50">{title}</div>
      <ul className="space-y-0.5">
        {shown.map((e, i) => (
          <li key={`${e.source}-${e.target}-${i}`} className={cn("truncate rounded border px-1.5 py-0.5 font-mono text-[10px]", toneCls(tone))} title={`${e.source} → ${e.target}`}>
            {e.source} → {e.target}
          </li>
        ))}
        {extra > 0 && <li className="px-1 py-0.5 text-[10px] italic text-text/40">+{extra}</li>}
      </ul>
    </div>
  );
}
