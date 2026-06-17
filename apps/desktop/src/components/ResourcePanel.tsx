// src/components/ResourcePanel.tsx
//
// Painel do Monitor de Recursos: abre ao clicar no chip. Abas [Geral · 1 por
// agente] — Geral = CPU/RAM/swap/disco/rede/GPU do sistema; cada agente = consumo
// (CPU/RAM/VRAM) do seu processo-raiz + descendentes. Overlay canto inferior-direito.

import { useMemo, useState } from "react";
import { useResourceStore } from "@/store/resource-store";
import { useCanvasStore } from "@/store/canvas-store";
import type { AgentStat, ResourceSample } from "@/types/metrics";
import { cn } from "@/lib/cn";
import { X } from "lucide-react";

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}
function mem(bytes: number): string {
  return bytes >= 1e9 ? `${(bytes / 1e9).toFixed(2)} GB` : `${(bytes / 1e6).toFixed(0)} MB`;
}
function rate(bytesPerSec: number): string {
  if (bytesPerSec >= 1e6) return `${(bytesPerSec / 1e6).toFixed(1)} MB/s`;
  if (bytesPerSec >= 1e3) return `${(bytesPerSec / 1e3).toFixed(0)} kB/s`;
  return `${bytesPerSec} B/s`;
}
function barColor(pct: number): string {
  if (pct >= 90) return "bg-danger";
  if (pct >= 85) return "bg-yellow-400";
  return "bg-brand";
}

function Sparkline({ values, max, color }: { values: number[]; max?: number; color: string }) {
  const w = 100;
  const h = 22;
  if (values.length < 2) return <svg className="w-full h-5" />;
  const hi = max ?? Math.max(1, ...values);
  const pts = values
    .map((v, i) => {
      const x = (i / (values.length - 1)) * w;
      const y = h - (Math.min(Math.max(v, 0), hi) / hi) * h;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" className="w-full h-5">
      <polyline points={pts} fill="none" stroke={color} strokeWidth={1.5} vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Metric({
  label,
  value,
  pct,
  spark,
}: {
  label: string;
  value: string;
  pct?: number;
  spark?: { values: number[]; max?: number };
}) {
  return (
    <div className="px-3 py-2 border-b border-border/40">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-textMuted">{label}</span>
        <span className="font-mono text-text">{value}</span>
      </div>
      {pct !== undefined && (
        <div className="mt-1 h-1.5 rounded-full bg-bg overflow-hidden">
          <div className={cn("h-full rounded-full transition-all", barColor(pct))} style={{ width: `${Math.min(100, pct)}%` }} />
        </div>
      )}
      {spark && <div className="mt-1 text-brand/70"><Sparkline values={spark.values} max={spark.max} color="currentColor" /></div>}
    </div>
  );
}

export function ResourcePanel() {
  const expanded = useResourceStore((s) => s.expanded);
  const setExpanded = useResourceStore((s) => s.setExpanded);
  const last = useResourceStore((s) => s.last);
  const ring = useResourceStore((s) => s.ring);
  const floors = useCanvasStore((s) => s.floors);
  const [tab, setTab] = useState<string>("geral"); // "geral" | sessionId

  const labelOf = useMemo(() => {
    const m = new Map<string, string>();
    for (const f of floors) {
      for (const n of f.nodes) {
        if (n.kind === "terminal") m.set(n.session_id, n.label ?? n.command);
      }
    }
    return (sid: string) => m.get(sid) ?? sid.slice(0, 8);
  }, [floors]);

  if (!expanded || !last) return null;

  const g = last.global;
  const memPct = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0;
  const swapPct = g.swapTotal > 0 ? (g.swapUsed / g.swapTotal) * 100 : 0;
  const diskPct = g.disk.total > 0 ? (g.disk.used / g.disk.total) * 100 : 0;

  const series = (pick: (s: ResourceSample) => number) => ring.map(pick);
  const netMax = Math.max(1, ...ring.map((s) => Math.max(s.global.net.rxBytesPerSec, s.global.net.txBytesPerSec)));

  const agents = [...last.agents].sort((a, b) => b.cpuPct - a.cpuPct);
  const active = tab !== "geral" ? agents.find((a) => a.sessionId === tab) : null;
  // série por-agente (casa por sessionId em cada amostra do ring).
  const agentSeries = (sid: string, pick: (a: AgentStat) => number) =>
    ring.map((s) => { const a = s.agents.find((x) => x.sessionId === sid); return a ? pick(a) : 0; });

  return (
    <div className="fixed bottom-12 right-3 z-[56] w-[340px] max-h-[72vh] rounded-lg border border-border bg-surface1/95 backdrop-blur shadow-2xl flex flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text">Recursos</span>
        <span className="text-[10px] text-textMuted font-mono">tempo real · 1s</span>
        <div className="flex-1" />
        <button onClick={() => setExpanded(false)} className="text-textMuted hover:text-text" title="Fechar">
          <X size={14} />
        </button>
      </header>

      {/* Abas: Geral + 1 por agente */}
      <div className="flex gap-1 px-2 pt-1.5 border-b border-border shrink-0 overflow-x-auto">
        {[{ id: "geral", label: "Geral" }, ...agents.map((a) => ({ id: a.sessionId, label: labelOf(a.sessionId) }))].map((t) => (
          <button
            key={t.id}
            onClick={() => setTab(t.id)}
            title={t.label}
            className={
              "px-2.5 py-1 text-[11px] rounded-t-md border-b-2 -mb-px whitespace-nowrap max-w-[110px] truncate transition-colors " +
              ((tab === t.id || (tab !== "geral" && !active && t.id === "geral"))
                ? "border-brand text-text"
                : "border-transparent text-textMuted hover:text-text")
            }
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-auto">
        {!active ? (
          <>
            <Metric label="CPU" value={`${g.cpuPct.toFixed(0)}%`} pct={g.cpuPct} spark={{ values: series((s) => s.global.cpuPct), max: 100 }} />
            <Metric label="RAM" value={`${gb(g.memUsed)} / ${gb(g.memTotal)} GB`} pct={memPct} spark={{ values: series((s) => (s.global.memTotal > 0 ? (s.global.memUsed / s.global.memTotal) * 100 : 0)), max: 100 }} />
            {g.swapTotal > 0 && <Metric label="Swap" value={`${gb(g.swapUsed)} / ${gb(g.swapTotal)} GB`} pct={swapPct} />}
            <Metric label="Disco" value={`${gb(g.disk.used)} / ${gb(g.disk.total)} GB`} pct={diskPct} />
            <Metric label="Rede ↓" value={rate(g.net.rxBytesPerSec)} spark={{ values: series((s) => s.global.net.rxBytesPerSec), max: netMax }} />
            <Metric label="Rede ↑" value={rate(g.net.txBytesPerSec)} spark={{ values: series((s) => s.global.net.txBytesPerSec), max: netMax }} />
            {last.gpus.map((gpu, i) => (
              <Metric key={i} label={`GPU · ${gpu.vendor}`} value={`${gpu.utilPct.toFixed(0)}% · ${gb(gpu.vramUsed)}/${gb(gpu.vramTotal)}GB${gpu.tempC != null ? ` · ${gpu.tempC.toFixed(0)}°C` : ""}`} pct={gpu.utilPct} spark={{ values: series((s) => s.gpus[i]?.utilPct ?? 0), max: 100 }} />
            ))}
            {agents.length > 0 && (
              <div className="px-3 py-2 text-[10px] text-textMuted opacity-60">
                {agents.length} agente(s) ativos — abra a aba de cada um pra ver o consumo.
              </div>
            )}
          </>
        ) : (
          <>
            <div className="px-3 py-2 border-b border-border/40 flex items-center justify-between">
              <span className="text-[12px] text-text font-medium truncate">{labelOf(active.sessionId)}</span>
              <span className="text-[10px] text-textMuted font-mono">PID {active.pid}</span>
            </div>
            <Metric label="CPU" value={`${active.cpuPct.toFixed(0)}%`} pct={active.cpuPct} spark={{ values: agentSeries(active.sessionId, (a) => a.cpuPct), max: Math.max(100, ...agentSeries(active.sessionId, (a) => a.cpuPct)) }} />
            <Metric label="RAM (RSS)" value={mem(active.rssBytes)} pct={g.memTotal > 0 ? (active.rssBytes / g.memTotal) * 100 : undefined} spark={{ values: agentSeries(active.sessionId, (a) => a.rssBytes) }} />
            {active.vramBytes != null && (
              <Metric label="VRAM" value={mem(active.vramBytes)} spark={{ values: agentSeries(active.sessionId, (a) => a.vramBytes ?? 0) }} />
            )}
            <div className="px-3 py-2 text-[10px] text-textMuted opacity-60">
              Soma do processo-raiz do agente + descendentes. CPU% pode passar de 100% (vários núcleos).
            </div>
          </>
        )}
      </div>
    </div>
  );
}
