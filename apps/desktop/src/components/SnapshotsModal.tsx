// src/components/SnapshotsModal.tsx
//
// Backup/history do canvas: cria snapshots versionados do workspace e restaura
// de qualquer um. Read/restore via SQLite (snapshot_*).

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Archive, Box, Camera, Clock, GitBranch, Layers, RotateCcw, Trash2, X, Zap } from "lucide-react";

import {
  snapshotCreate,
  snapshotsList,
  snapshotGet,
  snapshotDelete,
  buildCapsuleMeta,
  parseCapsuleMeta,
  hasFullCapsule,
  type SnapshotMeta,
  type CapsuleMeta,
} from "@/lib/snapshot-client";
import { loadAutoSnapSettings, saveAutoSnapSettings, snapshotNow, type AutoSnapSettings } from "@/lib/auto-snapshot";
import { dbSaveWorkspace } from "@/lib/db-client";
import { useCanvasStore } from "@/store/canvas-store";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";
import { notify, confirmDialog } from "@/lib/notify";

interface Props {
  onClose: () => void;
}

function fmt(s: string): string {
  const d = new Date(s.replace(" ", "T") + "Z");
  return Number.isNaN(d.getTime()) ? s : d.toLocaleString();
}

function kb(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;
}

/** Nº de nós agentes (terminal + agent) nos paralelos do projeto ativo. */
function countAgents(): number {
  return useCanvasStore
    .getState()
    .parallels.flatMap((f) => f.nodes)
    .filter((n) => n.kind === "terminal" || n.kind === "agent").length;
}

/** Linha de ponteiros da cápsula (Camada 1): "commit · branch · N agentes · $custo". */
function capsuleLine(m: CapsuleMeta, t: (k: string, d?: string) => string): string {
  const parts: string[] = [];
  if (m.commit) parts.push(m.commit);
  if (m.branch) parts.push(m.branch);
  if (typeof m.agents === "number") parts.push(`${m.agents} ${t("snapshots.agents", "agentes")}`);
  if (typeof m.costUsd === "number" && m.costUsd > 0) parts.push(`$${m.costUsd.toFixed(2)}`);
  return parts.join(" · ");
}

export function SnapshotsModal({ onClose }: Props) {
  const t = useT();
  const [items, setItems] = useState<SnapshotMeta[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<AutoSnapSettings>(() => loadAutoSnapSettings());
  /** Cápsula do tempo (#31): quando ligado, o "Criar snapshot" também congela o código
   *  (OmniFS) e liga a arquitetura (graph.json). Camada 2, opt-in. */
  const [capsule, setCapsule] = useState(false);
  const [creating, setCreating] = useState(false);

  function patchSettings(p: Partial<AutoSnapSettings>) {
    const next = { ...settings, ...p };
    setSettings(next);
    saveAutoSnapSettings(next); // persiste + re-arma o timer
  }

  async function load() {
    setLoading(true);
    setError(null);
    try {
      setItems(await snapshotsList());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    let mounted = true;
    async function run() {
      setLoading(true);
      setError(null);
      try {
        const items = await snapshotsList();
        if (!mounted) return;
        setItems(items);
      } catch (e) {
        if (!mounted) return;
        setError(String(e));
      } finally {
        if (!mounted) return;
        setLoading(false);
      }
    }
    void run();
    return () => { mounted = false; };
  }, []);

  async function create() {
    const label = prompt(t("snapshots.labelPrompt", "Rótulo do snapshot (opcional):")) ?? undefined;
    setCreating(true);
    try {
      const st = useCanvasStore.getState();
      const doc = JSON.stringify(st.getWorkspaceSnapshot());
      // Cápsula: Camada 1 sempre; Camada 2 (código + arquitetura) só com o toggle ligado.
      // Best-effort — se a montagem do meta falhar, grava o snapshot mesmo assim.
      const meta = await buildCapsuleMeta({ cwd: st.currentCwd, agents: countAgents(), capsule })
        .then((m) => JSON.stringify(m))
        .catch(() => null);
      await snapshotCreate(label?.trim() || undefined, doc, false, meta);
      void load();
    } finally {
      setCreating(false);
    }
  }

  /** Aplica só o canvas (comum aos dois modos de restauração). Retorna true no sucesso. */
  async function applyCanvas(id: number): Promise<boolean> {
    const doc = await snapshotGet(id);
    if (!doc) return false;
    try {
      useCanvasStore.getState().restoreWorkspace(JSON.parse(doc));
      await dbSaveWorkspace(doc);
      return true;
    } catch (e) {
      void notify(t("snapshots.restoreFailed", "Falha ao restaurar:") + "\n" + String(e), "error");
      return false;
    }
  }

  async function restore(id: number) {
    if (!(await confirmDialog(t("snapshots.restoreConfirm", "Restaurar este snapshot? O canvas atual será substituído (salve um snapshot antes se quiser).")))) return;
    if (await applyCanvas(id)) onClose();
  }

  /** Restaura o PROJETO (canvas + ponteiros de código/arquitetura). MVP: restaura o canvas
   *  e INSTRUI o rollback de código no painel OmniFS (não reverte arquivos automaticamente). */
  async function restoreProject(id: number, m: CapsuleMeta) {
    const ptr: string[] = [];
    if (m.omnifsShort) ptr.push(`• ${t("snapshots.capsuleCode", "código (OmniFS)")}: ${m.omnifsShort}`);
    if (m.graphPath) ptr.push(`• ${t("snapshots.capsuleArch", "arquitetura")}: ${m.graphPath}`);
    const msg =
      t(
        "snapshots.capsuleRestoreConfirm",
        "Restaurar a CÁPSULA traz o canvas de volta. O CÓDIGO não é revertido automaticamente (MVP): depois use o painel OmniFS para reverter o drive ao hash abaixo.",
      ) + (ptr.length ? "\n\n" + ptr.join("\n") : "");
    if (!(await confirmDialog(msg, t("snapshots.projectRestoreTitle", "Restaurar projeto (canvas + código)")))) return;
    if (!(await applyCanvas(id))) return;
    onClose();
    if (m.omnifsShort) {
      void notify(
        t("snapshots.capsuleAfter", "Canvas restaurado. Para reverter o CÓDIGO ao estado da cápsula, abra o painel OmniFS e faça rollback para:") +
          " " +
          m.omnifsShort,
        "info",
      );
    }
  }

  async function del(id: number) {
    await snapshotDelete(id);
    setItems((xs) => xs.filter((s) => s.id !== id));
  }

  return createPortal(
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        className="w-[620px] max-w-[92vw] h-[560px] max-h-[88vh] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border shrink-0">
          <Archive size={15} className="text-brand" />
          <span className="text-sm font-medium text-text flex-1">{t("snapshots.title", "Snapshots do canvas")}</span>
          <label
            className="flex items-center gap-1 text-[11px] text-textMuted cursor-pointer select-none"
            title={t("snapshots.capsuleTitle", "Cápsula do tempo: além do canvas, congela o código (OmniFS) e liga a arquitetura (graph.json)")}
          >
            <input
              type="checkbox"
              checked={capsule}
              onChange={(e) => setCapsule(e.target.checked)}
              className="accent-brand"
            />
            <Box size={12} /> {t("snapshots.capsule", "Cápsula")}
          </label>
          <button
            onClick={() => void create()}
            disabled={creating}
            className="flex items-center gap-1 px-2.5 py-1 rounded text-[12px] bg-brand text-bg hover:bg-brand-hover transition-colors disabled:opacity-50"
          >
            <Camera size={13} /> {creating ? t("snapshots.creating", "Capturando…") : t("snapshots.create", "Criar snapshot")}
          </button>
          <button onClick={onClose} className="text-textMuted hover:text-text p-1" title={t("common.close", "Fechar")}>
            <X size={16} />
          </button>
        </header>

        {/* Auto-backup (cron): liga/desliga, intervalo e teto de retenção. */}
        <div className="flex items-center gap-3 px-4 py-2 border-b border-border/60 bg-surface2/40 text-[11px] text-textMuted shrink-0 flex-wrap">
          <label className="flex items-center gap-1.5 cursor-pointer select-none">
            <input
              type="checkbox"
              checked={settings.enabled}
              onChange={(e) => patchSettings({ enabled: e.target.checked })}
              className="accent-brand"
            />
            <Clock size={12} /> {t("snapshots.autoBackup", "Auto-backup")}
          </label>
          <label className={cn("flex items-center gap-1", !settings.enabled && "opacity-40")}>
            {t("snapshots.every", "a cada")}
            <input
              type="number"
              min={1}
              max={720}
              disabled={!settings.enabled}
              value={settings.intervalMin}
              onChange={(e) => patchSettings({ intervalMin: Number(e.target.value) || 1 })}
              className="w-12 px-1 py-0.5 rounded bg-bg border border-border text-text text-center"
            />
            {t("snapshots.min", "min")}
          </label>
          <label className={cn("flex items-center gap-1", !settings.enabled && "opacity-40")}>
            {t("snapshots.keep", "manter")}
            <input
              type="number"
              min={1}
              max={500}
              disabled={!settings.enabled}
              value={settings.maxAuto}
              onChange={(e) => patchSettings({ maxAuto: Number(e.target.value) || 1 })}
              className="w-14 px-1 py-0.5 rounded bg-bg border border-border text-text text-center"
            />
            {t("snapshots.backups", "backups")}
          </label>
          <span className="flex-1" />
          <button
            onClick={async () => { await snapshotNow(); void load(); }}
            title={t("snapshots.backupNowTitle", "Fazer um backup automático agora")}
            className="flex items-center gap-1 px-2 py-0.5 rounded text-textMuted hover:text-brand border border-border hover:border-brand transition-colors"
          >
            <Zap size={12} /> {t("snapshots.backupNow", "Backup agora")}
          </button>
        </div>

        <div className="flex-1 overflow-auto">
          {error ? (
            <p className="px-4 py-3 text-[12px] text-danger font-mono whitespace-pre-wrap">{error}</p>
          ) : items.length === 0 ? (
            <p className="px-4 py-3 text-[12px] text-textMuted opacity-60">
              {loading ? t("common.loading", "Carregando…") : t("snapshots.empty", "Nenhum snapshot. Crie um pra ter um ponto de restauração do canvas.")}
            </p>
          ) : (
            items.map((s) => {
              const cap = parseCapsuleMeta(s.meta);
              const full = hasFullCapsule(cap);
              const line = cap ? capsuleLine(cap, t) : "";
              return (
              <div key={s.id} className="group flex items-center gap-2 px-4 py-2 border-b border-border/40">
                <div className="min-w-0 flex-1">
                  <span className="text-[12px] text-text flex items-center gap-1.5">
                    {s.label || `${t("snapshots.snapshotLabel", "Snapshot")} #${s.id}`}
                    {s.auto ? (
                      <span className="px-1 py-px rounded text-[9px] bg-surface2 text-textMuted border border-border/60">{t("snapshots.auto", "auto")}</span>
                    ) : (
                      <span className="px-1 py-px rounded text-[9px] bg-brand/15 text-brand border border-brand/30">{t("snapshots.manual", "manual")}</span>
                    )}
                    {full && (
                      <span
                        className="px-1 py-px rounded text-[9px] bg-brand/15 text-brand border border-brand/30 flex items-center gap-0.5"
                        title={cap?.omnifsShort ? `${t("snapshots.capsuleCode", "código (OmniFS)")}: ${cap.omnifsShort}` : undefined}
                      >
                        <Box size={9} /> {t("snapshots.capsuleBadge", "cápsula")}
                      </span>
                    )}
                  </span>
                  {line && (
                    <div className="text-[10px] text-textMuted opacity-80 flex items-center gap-1 truncate">
                      <GitBranch size={9} className="shrink-0" /> {line}
                    </div>
                  )}
                  <div className="text-[10px] text-textMuted opacity-60">{fmt(s.createdAt)} · {kb(s.bytes)}</div>
                </div>
                {full && cap && (
                  <button
                    onClick={() => void restoreProject(s.id, cap)}
                    title={t("snapshots.restoreProjectTitle", "Restaurar projeto (canvas + código)")}
                    className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-textMuted hover:text-brand border border-border hover:border-brand transition-colors"
                  >
                    <Layers size={12} /> {t("snapshots.restoreProject", "Projeto")}
                  </button>
                )}
                <button
                  onClick={() => void restore(s.id)}
                  title={full ? t("snapshots.restoreCanvasTitle", "Restaurar só o canvas") : t("snapshots.restore", "Restaurar")}
                  className="flex items-center gap-1 px-2 py-1 rounded text-[11px] text-textMuted hover:text-brand border border-border hover:border-brand transition-colors"
                >
                  <RotateCcw size={12} /> {full ? t("snapshots.restoreCanvas", "Canvas") : t("snapshots.restore", "Restaurar")}
                </button>
                <button
                  onClick={() => void del(s.id)}
                  title={t("common.delete", "Apagar")}
                  className="opacity-0 group-hover:opacity-100 text-textMuted hover:text-danger p-1 shrink-0"
                >
                  <Trash2 size={13} />
                </button>
              </div>
              );
            })
          )}
        </div>
      </div>
    </div>,
    document.body,
  );
}
