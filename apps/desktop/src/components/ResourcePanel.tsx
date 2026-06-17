// src/components/ResourcePanel.tsx
//
// Painel do Monitor de Recursos (sub-fase E): abre ao clicar no chip. Barras +
// sparklines (~60s) de CPU/RAM/swap/disco/rede. Seções GPU e por-agente aparecem
// quando há dados (fases C/D). Overlay próprio (canto inferior-direito, acima do chip).

import { useResourceStore } from "@/store/resource-store";
import type { ResourceSample } from "@/types/metrics";
import { cn } from "@/lib/cn";
import { X } from "lucide-react";

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
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
  if (!expanded || !last) return null;

  const g = last.global;
  const memPct = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0;
  const swapPct = g.swapTotal > 0 ? (g.swapUsed / g.swapTotal) * 100 : 0;
  const diskPct = g.disk.total > 0 ? (g.disk.used / g.disk.total) * 100 : 0;

  const series = (pick: (s: ResourceSample) => number) => ring.map(pick);
  const netMax = Math.max(1, ...ring.map((s) => Math.max(s.global.net.rxBytesPerSec, s.global.net.txBytesPerSec)));

  return (
    <div className="fixed bottom-12 right-3 z-[56] w-[320px] max-h-[70vh] rounded-lg border border-border bg-surface1/95 backdrop-blur shadow-2xl flex flex-col overflow-hidden">
      <header className="flex items-center gap-2 px-3 py-2 border-b border-border shrink-0">
        <span className="text-xs font-medium text-text">Recursos</span>
        <span className="text-[10px] text-textMuted font-mono">tempo real · 1s</span>
        <div className="flex-1" />
        <button onClick={() => setExpanded(false)} className="text-textMuted hover:text-text" title="Fechar">
          <X size={14} />
        </button>
      </header>

      <div className="flex-1 overflow-auto">
        <Metric label="CPU" value={`${g.cpuPct.toFixed(0)}%`} pct={g.cpuPct} spark={{ values: series((s) => s.global.cpuPct), max: 100 }} />
        <Metric label="RAM" value={`${gb(g.memUsed)} / ${gb(g.memTotal)} GB`} pct={memPct} spark={{ values: series((s) => (s.global.memTotal > 0 ? (s.global.memUsed / s.global.memTotal) * 100 : 0)), max: 100 }} />
        {g.swapTotal > 0 && <Metric label="Swap" value={`${gb(g.swapUsed)} / ${gb(g.swapTotal)} GB`} pct={swapPct} />}
        <Metric label="Disco" value={`${gb(g.disk.used)} / ${gb(g.disk.total)} GB`} pct={diskPct} />
        <Metric label="Rede ↓" value={rate(g.net.rxBytesPerSec)} spark={{ values: series((s) => s.global.net.rxBytesPerSec), max: netMax }} />
        <Metric label="Rede ↑" value={rate(g.net.txBytesPerSec)} spark={{ values: series((s) => s.global.net.txBytesPerSec), max: netMax }} />

        {last.gpus.map((gpu, i) => (
          <Metric key={i} label={`GPU · ${gpu.vendor}`} value={`${gpu.utilPct.toFixed(0)}% · ${gb(gpu.vramUsed)}/${gb(gpu.vramTotal)}GB${gpu.tempC != null ? ` · ${gpu.tempC.toFixed(0)}°C` : ""}`} pct={gpu.utilPct} spark={{ values: series((s) => s.gpus[i]?.utilPct ?? 0), max: 100 }} />
        ))}

        {/* Tabela por-agente — preenche na fase D */}
        <div className="px-3 py-2">
          <div className="text-[10px] uppercase tracking-wide text-textMuted mb-1">Por agente</div>
          {last.agents.length === 0 ? (
            <p className="text-[11px] text-textMuted opacity-60">Detalhamento por agente (CPU/RAM/VRAM) chega na próxima fase.</p>
          ) : (
            last.agents.map((a) => (
              <div key={a.sessionId} className="flex items-center gap-2 text-[11px] py-0.5">
                <span className="truncate flex-1">{a.label}</span>
                <span className="font-mono text-textMuted">{a.cpuPct.toFixed(0)}%</span>
                <span className="font-mono text-textMuted">{gb(a.rssBytes)}G</span>
                {a.vramBytes != null && <span className="font-mono text-brand">{gb(a.vramBytes)}G</span>}
              </div>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
