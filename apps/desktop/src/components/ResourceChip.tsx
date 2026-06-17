// src/components/ResourceChip.tsx
//
// Chip sempre-visível (canto inferior-direito) com CPU/RAM (e GPU quando houver).
// Cor vira âmbar/vermelho quando algo passa de ~85%. O painel completo (sparklines
// + tabela por-agente) é a sub-fase E; aqui clicar só alterna `expanded`.

import { useResourceStore } from "@/store/resource-store";
import { cn } from "@/lib/cn";

function gb(bytes: number): string {
  return (bytes / 1e9).toFixed(1);
}

function tone(pct: number): string {
  if (pct >= 90) return "text-danger";
  if (pct >= 85) return "text-yellow-400";
  return "text-text";
}

export function ResourceChip() {
  const last = useResourceStore((s) => s.last);
  const setExpanded = useResourceStore((s) => s.setExpanded);
  if (!last) return null;

  const g = last.global;
  const memPct = g.memTotal > 0 ? (g.memUsed / g.memTotal) * 100 : 0;
  const gpu = last.gpus[0];
  const worst = Math.max(g.cpuPct, memPct, gpu?.utilPct ?? 0);

  return (
    <button
      onClick={() => setExpanded(true)}
      title="Uso de recursos (CPU / RAM / GPU) — clique pra detalhes"
      className={cn(
        "fixed bottom-3 right-3 z-[55] flex items-center gap-1.5 px-2.5 py-1 rounded-full",
        "border bg-surface2/90 backdrop-blur shadow-lg text-[11px] font-mono select-none",
        "hover:bg-surface2 transition-colors",
        worst >= 90 ? "border-danger/50" : worst >= 85 ? "border-yellow-400/50" : "border-border",
      )}
    >
      <span className={tone(g.cpuPct)}>⚡ {g.cpuPct.toFixed(0)}%</span>
      <span className="text-textMuted opacity-40">·</span>
      <span className={tone(memPct)}>{gb(g.memUsed)}/{gb(g.memTotal)}GB</span>
      {gpu && (
        <>
          <span className="text-textMuted opacity-40">·</span>
          <span className={tone(gpu.utilPct)}>GPU {gpu.utilPct.toFixed(0)}%</span>
        </>
      )}
    </button>
  );
}
