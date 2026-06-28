// src/components/ReviewFixConfirm.tsx
//
// Fase 4 (auto-fix): confirma e despacha um agente Claude Code pra corrigir UM
// achado. Sempre via agente (nunca patch cego) + AVISA e PEDE PERMISSÃO antes de
// tocar no código. O worker sobe com workerClaudeArgs (contrato DEV → ao terminar
// ele re-roda review_current, gateado por Stop hook). Respeita o teto de agentes.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { AlertTriangle, Wand2, X } from "lucide-react";

import type { Finding } from "@/lib/review";
import type { Parallel } from "@/types/workspace";
import { useCanvasStore } from "@/store/canvas-store";
import { agentMcpConfig, agentSettingsConfig, getMaxAgents, mcpListAgents } from "@/lib/mcp-client";
import { workerClaudeArgs } from "@/lib/agent-contract";
import { ROLE_CLIS } from "@/lib/agent-roles";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";

interface Props {
  finding: Finding;
  floor: Parallel;
  onClose: () => void;
  onDispatched: (terminalId: string, msg: string) => void;
}

/** Prompt cirúrgico do agente de correção — só esse achado, mínima mudança. */
export function fixerPrompt(f: Finding): string {
  const loc = f.line ? `${f.file}:${f.line}` : f.file;
  return [
    "Tarefa CIRÚRGICA de correção de um único achado de code review. Não faça nada além disso.",
    `Arquivo: ${loc}`,
    `Severidade: ${f.severity} · Categoria: ${f.category}`,
    `Problema: ${f.title}`,
    f.suggestion ? `Sugestão do revisor: ${f.suggestion}` : "",
    "",
    "Aplique a MENOR correção que resolve exatamente esse problema, no arquivo/linha indicados.",
    "Não refatore o resto nem toque em outros arquivos sem necessidade. Ao terminar, rode review_current",
    "na sua pasta de trabalho e conserte o que ela apontar antes de encerrar.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function ReviewFixConfirm({ finding, floor, onClose, onDispatched }: Props) {
  const t = useT();
  const [max, setMax] = useState<number | null>(null);
  const [active, setActive] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    getMaxAgents().then(setMax).catch(() => setMax(null));
    mcpListAgents().then((a) => setActive(a.length)).catch(() => setActive(null));
  }, []);

  const atCeiling = max != null && active != null && active >= max;
  const prompt = fixerPrompt(finding);

  async function dispatch() {
    setBusy(true);
    setErr(null);
    try {
      const label = `fix: ${finding.file.split("/").pop()}`;
      const [mcpPath, settingsPath] = await Promise.all([
        agentMcpConfig().catch(() => null),
        agentSettingsConfig(label).catch(() => null),
      ]);
      const claude = ROLE_CLIS.find((c) => c.id === "claude");
      const store = useCanvasStore.getState();
      // Garante que o agente nasça no floor revisado (cwd = worktree da branch).
      store.switchParallel(floor.id);
      const node = store.addTerminal({
        command: claude?.command ?? "claude",
        args: [...workerClaudeArgs(mcpPath, undefined, settingsPath), prompt],
        role: "claude-code",
        label,
      });
      if (!node) {
        setErr(t("reviewFixConfirm.limitBlocked", "Limite de agentes da edição community atingido."));
        setBusy(false);
        return;
      }
      onDispatched(node.id, `${t("reviewFixConfirm.dispatchedPrefix", "Agente de correção despachado no paralelo")} "${floor.name}". ${t("reviewFixConfirm.dispatchedSuffix", "O review re-roda sozinho quando ele terminar.")}`);
      onClose();
    } catch (e) {
      setErr(String(e));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="fixed inset-0 z-[10000] flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div className="w-[560px] max-w-[92vw] rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <header className="flex items-center gap-2 px-4 py-2.5 border-b border-border">
          <Wand2 size={15} className="text-brand" />
          <span className="text-sm font-medium text-text">{t("reviewFixConfirm.title", "Corrigir via agente")}</span>
          <div className="flex-1" />
          <button onClick={onClose} className="text-textMuted hover:text-text p-1"><X size={16} /></button>
        </header>

        <div className="px-4 py-3 flex flex-col gap-3">
          <div className="flex items-start gap-2 rounded-md border border-yellow-400/40 bg-yellow-400/10 px-3 py-2">
            <AlertTriangle size={15} className="text-yellow-300 mt-0.5 shrink-0" />
            <p className="text-[12px] text-yellow-100 leading-snug">
              {t("reviewFixConfirm.warnPart1", "Um agente")} <b>Claude Code</b> {t("reviewFixConfirm.warnPart2", "vai abrir no paralelo")} <b>{floor.branch ?? floor.name}</b> {t("reviewFixConfirm.warnPart3", "e")} <b>{t("reviewFixConfirm.warnEditFiles", "editar arquivos da branch")}</b> {t("reviewFixConfirm.warnPart4", "pra corrigir este achado. Ele aplica só a correção mínima e re-roda o review. Nada é alterado sem este OK.")}
            </p>
          </div>

          <div className="text-[12px] text-text">
            <div className="text-textMuted text-[11px] uppercase tracking-wide mb-1">{t("reviewFixConfirm.finding", "Achado")}</div>
            <div className="font-mono text-brand text-[11px]">{finding.file}{finding.line ? `:${finding.line}` : ""}</div>
            <div>{finding.title}</div>
          </div>

          <details className="text-[11px] text-textMuted">
            <summary className="cursor-pointer hover:text-text">{t("reviewFixConfirm.viewPrompt", "Ver o prompt que o agente vai receber")}</summary>
            <pre className="mt-1 rounded bg-bg/60 border border-border/50 p-2 whitespace-pre-wrap text-[10px] leading-snug">{prompt}</pre>
          </details>

          <div className="text-[11px] text-textMuted">
            {t("reviewFixConfirm.activeAgents", "Agentes ativos:")} <b className={cn(atCeiling && "text-danger")}>{active ?? "?"}</b> / {t("reviewFixConfirm.ceiling", "teto")} {max ?? "?"}
            {atCeiling && <span className="text-danger"> {t("reviewFixConfirm.ceilingReached", "— teto atingido, aguarde um encerrar.")}</span>}
          </div>

          {err && <p className="text-[11px] text-danger font-mono whitespace-pre-wrap">{err}</p>}
        </div>

        <footer className="flex items-center justify-end gap-2 px-4 py-2.5 border-t border-border">
          <button onClick={onClose} className="px-3 py-1.5 rounded-md text-xs text-textMuted hover:text-text">{t("reviewFixConfirm.cancel", "Cancelar")}</button>
          <button
            onClick={() => void dispatch()}
            disabled={busy || atCeiling}
            className="px-3 py-1.5 rounded-md text-xs bg-brand text-bg hover:bg-brand-hover disabled:opacity-40 flex items-center gap-1.5"
          >
            <Wand2 size={13} /> {busy ? t("reviewFixConfirm.dispatching", "Despachando…") : t("reviewFixConfirm.dispatch", "Despachar agente")}
          </button>
        </footer>
      </div>
    </div>,
    document.body,
  );
}
