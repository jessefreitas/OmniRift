// src/components/health/DebtTab.tsx
//
// Aba "Dívida" do painel Saúde do Projeto (spec 2026-06-24, §3+§5). Lista os
// findings que viraram ação ("corrigir") como `DebtItem[]` persistidos por
// projeto (health-tracker). Cada item carrega o status e o backupId criado.
//
// Ações por item:
//   • restaurar  → confirmDialog → healthBackupRestore(root, backupId)  (desfaz o fix)
//   • resolvido  → marca status="resolvido"
//   • ignorado   → marca status="ignorado"
//   • remover    → tira do tracker
//
// Filtros: por status (todos/aberto/corrigindo/resolvido/ignorado) e por arquivo
// (texto). Empty-state didático quando não há dívida.

import { useEffect, useMemo, useState } from "react";
import { Wrench, RotateCcw, CheckCircle2, EyeOff, Trash2, ShieldCheck, Loader2 } from "lucide-react";

import { useT } from "@/lib/i18n";
import { confirmDialog, notify } from "@/lib/notify";
import { healthBackupRestore, type DebtItem, type DebtStatus, type FindingSeverity } from "@/lib/health-client";
import { loadDebt, setStatus as trackerSetStatus, removeDebt } from "@/lib/health-tracker";

const STATUS_TONE: Record<DebtStatus, string> = {
  aberto: "text-sky-400 bg-sky-400/10 border-sky-400/30",
  corrigindo: "text-yellow-400 bg-yellow-400/10 border-yellow-400/30",
  resolvido: "text-emerald-400 bg-emerald-400/10 border-emerald-400/30",
  ignorado: "text-textMuted bg-surface2 border-border",
};

function severityDot(sev: FindingSeverity): string {
  switch (String(sev).toLowerCase()) {
    case "critical":
    case "high":
      return "bg-red-400";
    case "warning":
    case "warn":
      return "bg-yellow-400";
    default:
      return "bg-sky-400";
  }
}

const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function DebtTab({ currentCwd }: { currentCwd: string }) {
  const t = useT();
  const [items, setItems] = useState<DebtItem[]>(() => loadDebt(currentCwd));
  const [statusFilter, setStatusFilter] = useState<DebtStatus | "all">("all");
  const [fileFilter, setFileFilter] = useState("");
  const [restoring, setRestoring] = useState<Set<string>>(new Set());

  // Recarrega quando troca de projeto.
  useEffect(() => {
    setItems(loadDebt(currentCwd));
  }, [currentCwd]);

  const statusLabel: Record<DebtStatus, string> = {
    aberto: t("health.debtStatusOpen", "aberto"),
    corrigindo: t("health.debtStatusFixing", "corrigindo"),
    resolvido: t("health.debtStatusDone", "resolvido"),
    ignorado: t("health.debtStatusIgnored", "ignorado"),
  };

  const filtered = useMemo(() => {
    const q = fileFilter.trim().toLowerCase();
    return items
      .filter((d) => (statusFilter === "all" ? true : d.status === statusFilter))
      .filter((d) => (q ? d.file.toLowerCase().includes(q) : true))
      .sort((a, b) => (b.ts > a.ts ? 1 : -1));
  }, [items, statusFilter, fileFilter]);

  async function restore(item: DebtItem) {
    if (!item.backupId) {
      void notify(t("health.debtNoBackup", "Este item não tem backup associado para restaurar."), "error");
      return;
    }
    const ok = await confirmDialog(
      t("health.debtRestoreConfirm", "Restaurar o backup vai sobrescrever o arquivo atual com a versão de antes do fix. Continuar?") + `\n\n${item.file}`,
      t("health.debtRestoreTitle", "Restaurar backup"),
    );
    if (!ok) return;
    setRestoring((p) => new Set(p).add(item.id));
    try {
      await healthBackupRestore(currentCwd, item.backupId);
      void notify(t("health.debtRestored", "Arquivo restaurado do backup.") + `\n${item.file}`, "info");
    } catch (e) {
      void notify(t("health.debtRestoreFailed", "Falha ao restaurar o backup:") + "\n" + String(e), "error");
    } finally {
      setRestoring((p) => { const n = new Set(p); n.delete(item.id); return n; });
    }
  }

  function mark(id: string, status: DebtStatus) {
    setItems(trackerSetStatus(currentCwd, id, status));
  }

  function drop(id: string) {
    setItems(removeDebt(currentCwd, id));
  }

  const filters: Array<{ id: DebtStatus | "all"; label: string }> = [
    { id: "all", label: t("health.debtFilterAll", "todos") },
    { id: "aberto", label: statusLabel.aberto },
    { id: "corrigindo", label: statusLabel.corrigindo },
    { id: "resolvido", label: statusLabel.resolvido },
    { id: "ignorado", label: statusLabel.ignorado },
  ];

  if (items.length === 0) {
    return (
      <div className="h-full flex items-center justify-center text-center">
        <div className="max-w-[420px] space-y-2">
          <Wrench size={28} className="mx-auto text-textMuted opacity-40" />
          <p className="text-[13px] text-text font-medium">
            {t("health.debtEmptyTitle", "Nenhuma dívida rastreada ainda")}
          </p>
          <p className="text-[12px] text-textMuted leading-snug">
            {t(
              "health.debtEmptyHint",
              "Quando você clicar em \"corrigir\" num achado de IA (aba Código ou Banco), o OmniRift faz um backup automático e registra o item aqui — com status e backup restaurável. Você decide o que atacar, e nada muda sem o seu OK.",
            )}
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {/* Header didático */}
      <p className="text-[12px] text-textMuted leading-snug">
        {t(
          "health.debtIntro",
          "Cada achado que você mandou corrigir vira um item aqui — com backup restaurável. Acompanhe o status e desfaça com 1 clique se o fix não ficou bom.",
        )}
      </p>

      {/* Filtros */}
      <div className="flex items-center gap-2 flex-wrap">
        <div className="flex items-center gap-1">
          {filters.map((f) => (
            <button
              key={f.id}
              type="button"
              onClick={() => setStatusFilter(f.id)}
              className={[
                "px-2 py-1 text-[11px] rounded-md border transition-colors",
                statusFilter === f.id
                  ? "border-brand bg-brand/10 text-brand"
                  : "border-border bg-surface1 text-textMuted hover:text-text",
              ].join(" ")}
            >
              {f.label}
            </button>
          ))}
        </div>
        <div className="flex-1" />
        <input
          type="text"
          value={fileFilter}
          onChange={(e) => setFileFilter(e.target.value)}
          placeholder={t("health.debtFilterFile", "filtrar por arquivo…")}
          className="px-2 py-1 text-[11px] rounded-md border border-border bg-surface1 text-text placeholder:text-textMuted/60 w-[200px] focus:outline-none focus:border-brand"
        />
      </div>

      {/* Lista */}
      {filtered.length === 0 ? (
        <p className="px-2 py-3 text-[12px] text-textMuted opacity-60">
          {t("health.debtNoMatch", "Nenhum item com esse filtro.")}
        </p>
      ) : (
        <div className="space-y-1.5">
          {filtered.map((d) => (
            <div
              key={d.id}
              className="rounded-md border border-border bg-surface1 px-3 py-2 space-y-1.5"
            >
              <div className="flex items-center gap-2">
                <span className={`inline-block h-1.5 w-1.5 rounded-full shrink-0 ${severityDot(d.severity)}`} />
                <span className="text-[12px] text-text truncate" title={d.title}>{d.title}</span>
                <span className={`ml-auto text-[9px] uppercase tracking-wide px-1.5 py-0.5 rounded border shrink-0 ${STATUS_TONE[d.status]}`}>
                  {statusLabel[d.status]}
                </span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[11px] font-mono text-textMuted truncate" title={d.file}>
                  {baseName(d.file)}
                </span>
                {d.backupId && (
                  <span className="flex items-center gap-1 text-[10px] text-emerald-400/80 shrink-0" title={t("health.debtBackupId", "Backup") + ` ${d.backupId}`}>
                    <ShieldCheck size={11} />
                    {t("health.debtHasBackup", "backup")}
                  </span>
                )}
              </div>
              <div className="flex items-center gap-1.5 pt-0.5">
                <button
                  type="button"
                  onClick={() => void restore(d)}
                  disabled={!d.backupId || restoring.has(d.id)}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border bg-bg text-text hover:bg-surface2 disabled:opacity-40"
                  title={d.backupId ? t("health.debtRestoreHint", "Sobrescreve o arquivo com o backup de antes do fix") : t("health.debtNoBackup", "Este item não tem backup associado para restaurar.")}
                >
                  {restoring.has(d.id) ? <Loader2 size={12} className="animate-spin" /> : <RotateCcw size={12} />}
                  {t("health.debtRestore", "restaurar")}
                </button>
                <button
                  type="button"
                  onClick={() => mark(d.id, "resolvido")}
                  disabled={d.status === "resolvido"}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-emerald-400/30 text-emerald-400 hover:bg-emerald-400/10 disabled:opacity-40"
                >
                  <CheckCircle2 size={12} />
                  {t("health.debtMarkDone", "resolvido")}
                </button>
                <button
                  type="button"
                  onClick={() => mark(d.id, "ignorado")}
                  disabled={d.status === "ignorado"}
                  className="flex items-center gap-1 px-2 py-1 text-[11px] rounded border border-border text-textMuted hover:text-text disabled:opacity-40"
                >
                  <EyeOff size={12} />
                  {t("health.debtMarkIgnored", "ignorar")}
                </button>
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={() => drop(d.id)}
                  className="p-1 rounded text-textMuted hover:text-red-400"
                  title={t("health.debtRemove", "Remover do tracker")}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
