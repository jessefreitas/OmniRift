// src/components/health/AiReportView.tsx
//
// Renderiza inline um relatório de IA (AiReport) — achados por severidade + resumo.
// Botões: "abrir agente" (escala pro fluxo de spawn do canvas) e "copiar".
//
// NOTA sobre "abrir agente": o spawn de agente (spawnRole / addTerminal + role +
// prompt inicial) vive na Sidebar e NÃO é exportado. Para não inventar um import
// nem acoplar o painel ao Sidebar, sinalizamos a intenção via CustomEvent
// `omnirift:health-spawn-agent` (caminho já usado p/ "open-tool"). Quem quiser
// implementar a escalada escuta esse evento e chama o fluxo de spawn existente
// com `target` + `report` no detail. Sem listener, é um no-op seguro.

import { useState } from "react";
import { Bot, Copy, Check } from "lucide-react";

import { useT } from "@/lib/i18n";
import type { AiReport, AiFinding, FindingSeverity } from "@/lib/health-client";

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

function FindingCard({ f }: { f: AiFinding }) {
  const t = useT();
  const tone = severityTone(f.severity);
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
    </div>
  );
}

interface Props {
  report: AiReport;
}

export function AiReportView({ report }: Props) {
  const t = useT();
  const [copied, setCopied] = useState(false);

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
  // TODO: ligar a um listener que chame spawnRole/addTerminal com o relatório como
  // contexto inicial. Por ora é um sinal seguro (no-op sem listener).
  function openAgent() {
    window.dispatchEvent(
      new CustomEvent("omnirift:health-spawn-agent", {
        detail: { target: report.target, report },
      }),
    );
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
            <FindingCard key={`${f.title}-${i}`} f={f} />
          ))}
        </div>
      )}
    </div>
  );
}
