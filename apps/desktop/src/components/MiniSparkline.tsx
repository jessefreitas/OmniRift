// src/components/MiniSparkline.tsx
//
// Mini gráfico de barras em SVG puro (sem lib) — barras proporcionais ao maior valor,
// com tooltip no hover. Discreto, no tom do modal (usa o token de tema `fill-brand`).
// Genérico de propósito: recebe `SparkBar[]` já formatado pelo chamador (custo/tokens/
// o que for) e só desenha. Degrada limpo: `bars` vazio → não renderiza nada.

import { useState } from "react";

export interface SparkBar {
  /** Rótulo curto do ponto (ex.: dia "07-01") — usado no tooltip. */
  label: string;
  /** Valor da barra: define a altura proporcional (>= 0). */
  value: number;
  /** Texto exibido no hover (dia + valores formatados). */
  tooltip: string;
}

/**
 * @param bars   pontos já prontos (formatação/decisão de métrica é do chamador)
 * @param height altura do gráfico em px (default 44)
 */
export function MiniSparkline({ bars, height = 44 }: { bars: SparkBar[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  if (bars.length === 0) return null;

  const max = Math.max(1, ...bars.map((b) => b.value)); // >=1 evita divisão por zero
  const n = bars.length;
  const W = 100; // viewBox em "percentuais": escala pro container via width 100%
  const gap = n > 1 ? Math.min(1.5, W / n / 5) : 0;
  const bw = (W - gap * (n - 1)) / n;

  return (
    <div className="relative">
      <svg
        viewBox={`0 0 ${W} ${height}`}
        width="100%"
        height={height}
        preserveAspectRatio="none"
        className="block"
      >
        {bars.map((b, i) => {
          const bh = Math.max(1, (Math.max(0, b.value) / max) * (height - 1));
          const x = i * (bw + gap);
          const active = hover === null || hover === i;
          return (
            <rect
              key={i}
              x={x}
              y={height - bh}
              width={bw}
              height={bh}
              rx={0.5}
              className="fill-brand"
              style={{ opacity: active ? 1 : 0.3, transition: "opacity 120ms" }}
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
            />
          );
        })}
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute -top-1 left-1/2 z-10 -translate-x-1/2 -translate-y-full whitespace-nowrap rounded border border-border bg-surface3 px-2 py-0.5 text-[10px] text-text shadow-lg">
          {bars[hover].tooltip}
        </div>
      )}
    </div>
  );
}
