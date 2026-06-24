// src/components/health/AiReportView.tsx
//
// Renderiza inline um relatório de IA (AiReport) — achados por severidade + resumo.
// Botões: "abrir agente" (escala pro fluxo de spawn do canvas), "copiar" e, por
// finding, "corrigir" (spec 2026-06-24 — ações com backup).
//
// NOTA sobre "abrir agente": o spawn de agente (spawnRole / addTerminal + role +
// prompt inicial) vive na Sidebar e NÃO é exportado. Para não inventar um import
// nem acoplar o painel ao Sidebar, sinalizamos a intenção via CustomEvent
// `omnirift:health-spawn-agent` (caminho já usado p/ "open-tool"). Quem quiser
// implementar a escalada escuta esse evento e chama o fluxo de spawn existente
// com `target` + `report` no detail. Sem listener, é um no-op seguro.
//
// FLUXO "corrigir" (REGRA INVIOLÁVEL — backup ANTES de corrigir):
//   1) confirmDialog (usuário decide)
//   2) healthBackup(root, [file])  — se falhar → notify(erro) e ABORTA (não corrige)
//   3) dispatch `omnirift:health-spawn-agent` { target, finding, backupId }
//   4) trackFinding(... "corrigindo", backupId)  — vira dívida no tracker

import { useState } from "react";
import { Bot, Copy, Check, Wrench, Loader2, ShieldCheck } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { confirmDialog, notify } from "@/lib/notify";
import { healthBackup, type AiReport, type AiFinding, type FindingSeverity, type BackupRef } from "@/lib/health-client";
import { trackFinding } from "@/lib/health-tracker";

/** Cor de borda/badge por severidade (alinhada às cores de nível do 9e). */
function severityTone(sev: FindingSeverity): { dot: string; text: string; border: string } {
  switch (String(sev).toLowerCase()) {
    case "critical":
    case "high":
      return { dot: "bg-red-400", text: "text-red-400", border: "border-red-400/30" };
    case "warning":
    case "warn":
      return { dot: "bg-yellow-400", text: "text-yellow-400", border: "border-yellow-400/30" };
    default:
      return { dot: "bg-sky-400", text: "text-sky-400", border: "border-sky-400/30" };
  }
}

/** ts curtinho (HH:MM:SS) pra exibir o BackupRef criado. */
function shortTs(ts: string): string {
  const d = new Date(ts);
  return Number.isNaN(d.getTime()) ? ts : d.toLocaleTimeString();
}

function FindingCard({
  f,
  root,
  onFix,
  fixing,
  backup,
  fixable,
}: {
  f: AiFinding;
  root: string | null;
  /** Dispara o gate de fix deste finding (confirma→backup→spawn→tracker). */
  onFix: () => void;
  /** true enquanto o backup deste finding roda. */
  fixing: boolean;
  /** BackupRef criado pra este finding (mostra ts curtinho). */
  backup?: BackupRef;
  /** O alvo do relatório é um arquivo backupável (false p/ DB = diretório/schema). */
  fixable: boolean;
}) {
  const t = useT();
  const tone = severityTone(f.severity);
  // Só faz sentido corrigir quando há projeto aberto + alvo de arquivo backupável
  // (o finding herda `report.target` quando não traz `file` próprio).
  const canFix = !!root && fixable;
  return (
    <div className={`rounded-md border ${tone.border} bg-bg/40 p-2.5 space-y-1.5`}>
      <div className="flex items-center gap-2">
        <span className={`inline-block h-1.5 w-1.5 rounded-full ${tone.dot}`} />
        <span className={`text-[10px] uppercase tracking-wide font-medium ${tone.text}`}>{f.severity}</span>
        {f.kind && <span className="text-[10px] uppercase tracking-wide text-textMuted opacity-60">· {f.kind}</span>}
        {typeof f.line === "number" && (
          <span className="ml-auto text-[10px] font-mono text-textMuted">
            {t("health.line", "linha")} {f.line}
          </span>
        )}
      </div>
      <div className="text-[13px] font-medium text-text">{f.title}</div>
      {f.detail && <p className="text-[12px] text-textMuted leading-snug whitespace-pre-wrap">{f.detail}</p>}
      {f.suggestion && (
        <div className="text-[12px] text-text/90 leading-snug">
          <span className="text-[10px] uppercase tracking-wide text-emerald-400/80 mr-1">
            {t("health.suggestion", "sugestão")}
          </span>
          <span className="whitespace-pre-wrap">{f.suggestion}</span>
        </div>
      )}
      <div className="flex items-center gap-2 pt-0.5">
        {backup && (
          <span
            className="flex items-center gap-1 text-[10px] text-emerald-400/90"
            title={t("health.fixBackupAt", "Backup criado") + ` ${backup.id}`}
          >
            <ShieldCheck size={11} />
            {t("health.fixBackupDone", "backup")} {shortTs(backup.ts)}
          </span>
        )}
        <div className="flex-1" />
        {canFix && (
          <button
            type="button"
            onClick={onFix}
            disabled={fixing}
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded bg-brand/15 text-brand hover:bg-brand/25 border border-brand/30 disabled:opacity-50"
            title={t("health.fixHint", "Faz backup do arquivo e manda um agente corrigir SÓ este achado")}
          >
            {fixing ? <Loader2 size={12} className="animate-spin" /> : <Wrench size={12} />}
            {fixing ? t("health.fixing", "preparando…") : t("health.fix", "corrigir")}
          </button>
        )}
      </div>
    </div>
  );
}

interface Props {
  report: AiReport;
  /**
   * Raiz do projeto (p/ o backup-gate). Quando omitido, lê `currentCwd` do store.
   * O DbDimension passa o root explicitamente; o CodeDimension pode confiar no store.
   */
  root?: string | null;
  /**
   * O `report.target` é um arquivo backupável? Default `true` (dimensão Código —
   * o target É o arquivo). O DbDimension passa `false` porque o target é o repo/
   * schema (diretório), não um arquivo único — sem ação de "corrigir" com backup.
   */
  fixable?: boolean;
}

export function AiReportView({ report, root: rootProp, fixable = true }: Props) {
  const t = useT();
  const currentCwd = useCanvasStore((s) => s.currentCwd);
  const root = rootProp ?? currentCwd;

  const [copied, setCopied] = useState(false);
  // Findings com backup em andamento (índice) e BackupRefs já criados.
  const [fixingIdx, setFixingIdx] = useState<Set<number>>(new Set());
  const [fixingAll, setFixingAll] = useState(false);
  const [backups, setBackups] = useState<Record<number, BackupRef>>({});
  const [fileBackup, setFileBackup] = useState<BackupRef | null>(null);

  async function copy() {
    const lines: string[] = [`# ${t("health.aiReport", "Relatório de IA")} — ${report.target}`, ""];
    if (report.summary) lines.push(report.summary, "");
    for (const f of report.findings) {
      lines.push(`## [${f.severity}] ${f.title}${typeof f.line === "number" ? ` (L${f.line})` : ""}`);
      if (f.kind) lines.push(`_${f.kind}_`);
      if (f.detail) lines.push(f.detail);
      if (f.suggestion) lines.push(`→ ${f.suggestion}`);
      lines.push("");
    }
    try {
      await navigator.clipboard.writeText(lines.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard off → ignora */
    }
  }

  // Escala pro fluxo de spawn de agente do canvas (desacoplado — ver nota no topo).
  // Caminho ANTIGO (genérico): { target, report }. Mantido funcionando.
  function openAgent() {
    window.dispatchEvent(
      new CustomEvent("omnirift:health-spawn-agent", {
        detail: { target: report.target, report },
      }),
    );
  }

  /**
   * Gate de fix de UM finding (REGRA INVIOLÁVEL): confirma → backup → spawn →
   * tracker. Se o backup falhar, ABORTA (não corrige).
   */
  async function fixFinding(idx: number, f: AiFinding) {
    const file = f.file || report.target;
    if (!root || !file) return;
    const ok = await confirmDialog(
      t("health.fixConfirm", "Vou fazer backup do arquivo e mandar um agente corrigir isso, ok?") + `\n\n${file}\n→ ${f.title}`,
      t("health.fixConfirmTitle", "Corrigir com backup"),
    );
    if (!ok) return;

    setFixingIdx((p) => new Set(p).add(idx));
    let ref: BackupRef;
    try {
      ref = await healthBackup(root, [file]);
    } catch (e) {
      // Backup falhou → NÃO corrige.
      void notify(t("health.fixBackupFailed", "Backup falhou — correção abortada (nada foi alterado):") + "\n" + String(e), "error");
      setFixingIdx((p) => { const n = new Set(p); n.delete(idx); return n; });
      return;
    }
    setBackups((p) => ({ ...p, [idx]: ref }));

    // Spawn focado naquele finding (payload estendido) + registra no tracker.
    window.dispatchEvent(
      new CustomEvent("omnirift:health-spawn-agent", {
        detail: { target: file, finding: f, backupId: ref.id },
      }),
    );
    trackFinding(root, { file, title: f.title, severity: f.severity, line: f.line }, "corrigindo", ref.id);

    setFixingIdx((p) => { const n = new Set(p); n.delete(idx); return n; });
  }

  /**
   * "Corrigir tudo do arquivo": 1 backup do arquivo → 1 agente com TODOS os
   * findings. Reaproveita o gate (confirma → backup → spawn → tracker em lote).
   */
  async function fixAll() {
    const file = report.target;
    if (!root || !file || report.findings.length === 0) return;
    const ok = await confirmDialog(
      t("health.fixAllConfirm", "Vou fazer um backup do arquivo e mandar um agente corrigir TODOS os achados dele, ok?") + `\n\n${file}\n(${report.findings.length})`,
      t("health.fixConfirmTitle", "Corrigir com backup"),
    );
    if (!ok) return;

    setFixingAll(true);
    let ref: BackupRef;
    try {
      ref = await healthBackup(root, [file]);
    } catch (e) {
      void notify(t("health.fixBackupFailed", "Backup falhou — correção abortada (nada foi alterado):") + "\n" + String(e), "error");
      setFixingAll(false);
      return;
    }
    setFileBackup(ref);

    // 1 agente com o relatório inteiro + backupId. Registra cada finding no tracker.
    window.dispatchEvent(
      new CustomEvent("omnirift:health-spawn-agent", {
        detail: { target: file, report, backupId: ref.id },
      }),
    );
    for (const f of report.findings) {
      trackFinding(root, { file, title: f.title, severity: f.severity, line: f.line }, "corrigindo", ref.id);
    }
    setFixingAll(false);
  }

  return (
    <div className="rounded-lg border border-border bg-surface1 p-3 space-y-3">
      <div className="flex items-center gap-2">
        <span className="text-[11px] uppercase tracking-wide text-textMuted">
          {t("health.aiReport", "Relatório de IA")}
        </span>
        <span className="text-[11px] font-mono text-textMuted truncate" title={report.target}>
          {report.target}
        </span>
        <div className="flex-1" />
        {root && fixable && report.findings.length > 0 && (
          <button
            type="button"
            onClick={() => void fixAll()}
            disabled={fixingAll}
            className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded bg-brand/15 text-brand hover:bg-brand/25 border border-brand/30 disabled:opacity-50"
            title={t("health.fixAllHint", "Um backup do arquivo + um agente pra corrigir todos os achados")}
          >
            {fixingAll ? <Loader2 size={13} className="animate-spin" /> : <Wrench size={13} />}
            {t("health.fixAll", "corrigir tudo do arquivo")}
          </button>
        )}
        <button
          type="button"
          onClick={openAgent}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded bg-surface2 text-text hover:bg-bg border border-border"
          title={t("health.openAgentHint", "Escala a análise pra um agente no canvas")}
        >
          <Bot size={13} />
          {t("health.openAgent", "abrir agente")}
        </button>
        <button
          type="button"
          onClick={() => void copy()}
          className="flex items-center gap-1.5 px-2 py-1 text-[11px] rounded text-textMuted hover:text-text"
        >
          {copied ? <Check size={13} /> : <Copy size={13} />}
          {copied ? t("health.copied", "copiado") : t("health.copy", "copiar")}
        </button>
      </div>

      {fileBackup && (
        <p className="flex items-center gap-1 text-[11px] text-emerald-400/90">
          <ShieldCheck size={12} />
          {t("health.fixAllBackupDone", "Backup do arquivo criado")} ({shortTs(fileBackup.ts)}) — {t("health.fixDebtTracked", "veja na aba Dívida pra restaurar/acompanhar")}
        </p>
      )}

      {report.summary && (
        <p className="text-[12px] text-text/90 leading-snug whitespace-pre-wrap">{report.summary}</p>
      )}

      {report.findings.length === 0 ? (
        <p className="text-[12px] text-textMuted opacity-60">
          {t("health.noFindings", "Sem achados — o arquivo parece saudável.")}
        </p>
      ) : (
        <div className="space-y-2">
          {report.findings.map((f, i) => (
            <FindingCard
              key={`${f.title}-${i}`}
              f={f}
              root={root}
              fixable={fixable}
              fixing={fixingIdx.has(i)}
              backup={backups[i]}
              onFix={() => void fixFinding(i, f)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
