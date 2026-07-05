import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface TooltipProps {
  label: ReactNode;
  side?: "right" | "top" | "bottom";
  children: ReactNode;
  className?: string;
  /** Balão largo com quebra de linha — pra textos de instrução ("como usar"). */
  wide?: boolean;
}

/**
 * Tooltip leve, CSS-only (sem dependência, sem portal). O wrapper é um
 * `group/tt` nomeado — não conflita com o `group` da linha de floor. Por padrão
 * abre à direita (a sidebar tem o canvas à direita, então não corta).
 */
export function Tooltip({ label, side = "right", children, className, wide }: TooltipProps) {
  // Tooltips largos (instrução) ancoram pela DIREITA e crescem pra esquerda — o
  // "?" fica no canto direito do node, então centralizar vazava a tela.
  const pos =
    side === "right"
      ? "left-full top-1/2 -translate-y-1/2 ml-2"
      : side === "top"
        ? wide
          ? "bottom-full right-0 mb-1.5"
          : "bottom-full left-1/2 -translate-x-1/2 mb-1.5"
        : wide
          ? "top-full right-0 mt-1.5"
          : "top-full left-1/2 -translate-x-1/2 mt-1.5";
  return (
    <span className={cn("relative inline-flex group/tt", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 rounded-md border border-border",
          "bg-surface2 px-2 py-1 text-[11px] leading-snug text-text shadow-lg",
          "opacity-0 scale-95 transition-all duration-100",
          "group-hover/tt:opacity-100 group-hover/tt:scale-100",
          // Default agora QUEBRA LINHA com largura máxima (antes era whitespace-nowrap,
          // que cortava toda tooltip longa na borda da sidebar). Rótulo curto continua
          // numa linha só (max-w não força largura); só o texto longo passa a envolver.
          // `wide` segue como variante ancorada à direita p/ textos de instrução.
          wide ? "w-56 whitespace-normal text-left" : "max-w-[15rem] whitespace-normal text-left",
          pos,
        )}
      >
        {label}
      </span>
    </span>
  );
}
