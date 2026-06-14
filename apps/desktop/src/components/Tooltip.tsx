import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

interface TooltipProps {
  label: ReactNode;
  side?: "right" | "top" | "bottom";
  children: ReactNode;
  className?: string;
}

/**
 * Tooltip leve, CSS-only (sem dependência, sem portal). O wrapper é um
 * `group/tt` nomeado — não conflita com o `group` da linha de floor. Por padrão
 * abre à direita (a sidebar tem o canvas à direita, então não corta).
 */
export function Tooltip({ label, side = "right", children, className }: TooltipProps) {
  const pos =
    side === "right"
      ? "left-full top-1/2 -translate-y-1/2 ml-2"
      : side === "top"
        ? "bottom-full left-1/2 -translate-x-1/2 mb-1.5"
        : "top-full left-1/2 -translate-x-1/2 mt-1.5";
  return (
    <span className={cn("relative inline-flex group/tt", className)}>
      {children}
      <span
        role="tooltip"
        className={cn(
          "pointer-events-none absolute z-50 whitespace-nowrap rounded-md border border-border",
          "bg-surface2 px-2 py-1 text-[11px] leading-tight text-text shadow-lg",
          "opacity-0 scale-95 transition-all duration-100",
          "group-hover/tt:opacity-100 group-hover/tt:scale-100",
          pos,
        )}
      >
        {label}
      </span>
    </span>
  );
}
