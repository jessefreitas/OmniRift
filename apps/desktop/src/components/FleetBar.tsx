// src/components/FleetBar.tsx
//
// FLEET BAR (#12): faixa discreta no topo-centro do canvas (logo abaixo da
// CanvasToolbar) com o progresso agregado dos agentes do FLOOR ATIVO —
// "5/7 prontos · 42m · 310k tok". Só aparece quando o floor tem lote de
// verdade (≥2 nós kind terminal|agent). Clique → abre o Kanban do projeto
// (mesmo CustomEvent "omnirift:open-tool" da Command palette).

import { useEffect, useMemo, useState } from "react";
import { Users } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { useFleetUsage } from "@/lib/fleet-usage";
import { useT } from "@/lib/i18n";

/** 4321 → "4.3k", 1_200_000 → "1.2M". */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Decorrido compacto: 3min → "3m", 42min → "42m", 95min → "1h35". */
function fmtElapsed(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h${String(min % 60).padStart(2, "0")}`;
}

export function FleetBar() {
  const t = useT();
  // ⚠️ zustand v5: os seletores retornam SÓ referências que já vivem no store
  // (primitivas ou campos diretos) — NUNCA array/objeto criado dentro do seletor
  // (referência instável = loop infinito de render que trava o app). Toda a
  // derivação (filtro/contagem/soma) fica no useMemo abaixo.
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const terminalStatuses = useCanvasStore((s) => s.terminalStatuses);
  const tokensByNode = useFleetUsage((s) => s.tokensByNode);

  // Tick de 30s só pro tempo decorrido (precisão de minuto basta).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);

  const fleet = useMemo(() => {
    const floor = parallels.find((f) => f.id === activeParallelId);
    let total = 0;
    let ready = 0;
    let tokens = 0;
    let oldest: number | null = null;
    for (const n of floor?.nodes ?? []) {
      if (n.kind !== "terminal" && n.kind !== "agent") continue;
      total += 1;
      // Terminal PTY: estado vivo do store (keyed por session_id). Agente ACP não
      // publica em terminalStatuses → sem sinal = "idle" (conta como pronto).
      const st = n.kind === "terminal" ? (terminalStatuses[n.session_id] ?? "idle") : "idle";
      if (st === "done" || st === "idle") ready += 1;
      if (n.createdAt != null && (oldest === null || n.createdAt < oldest)) oldest = n.createdAt;
      tokens += tokensByNode[n.id] ?? 0;
    }
    return { total, ready, tokens, oldest };
  }, [parallels, activeParallelId, terminalStatuses, tokensByNode]);

  if (fleet.total < 2) return null; // sem lote, sem barra

  const parts: string[] = [`${fleet.ready}/${fleet.total} ${t("fleet.ready", "prontos")}`];
  if (fleet.oldest != null) parts.push(fmtElapsed(Math.max(0, now - fleet.oldest)));
  if (fleet.tokens > 0) parts.push(`${fmtTokens(fleet.tokens)} tok`);

  const allReady = fleet.ready === fleet.total;
  return (
    <button
      onClick={() => window.dispatchEvent(new CustomEvent("omnirift:open-tool", { detail: "kanban" }))}
      title={t(
        "fleet.tooltip",
        "Frota do paralelo: agentes prontos/total (concluído+ocioso = pronto) · tempo desde o 1º agente do lote · tokens dos agentes ACP. Clique pra abrir o Kanban.",
      )}
      className="absolute top-14 left-1/2 -translate-x-1/2 z-30 pointer-events-auto flex items-center gap-1.5 bg-surface1/90 backdrop-blur border border-border rounded-md px-3 py-1 text-[11px] text-textMuted hover:text-text hover:border-brand/50 transition-colors"
    >
      <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${allReady ? "bg-green-500" : "bg-yellow-400 animate-pulse"}`} />
      <Users size={11} className="shrink-0 opacity-70" />
      <span className="tabular-nums whitespace-nowrap">{parts.join(" · ")}</span>
    </button>
  );
}
