// src/components/NodeHelp.tsx
//
// "Como usar" CONSISTENTE pra qualquer node do canvas: um ícone "?" no header
// que, no hover, abre um balão com instruções (Tooltip wide = quebra linha).
// Padrão: dropar <NodeHelp text="..." /> ao lado do {maxBtn} no header do node.

import { HelpCircle } from "lucide-react";
import { Tooltip } from "@/components/Tooltip";
import { cn } from "@/lib/cn";

export function NodeHelp({
  text,
  side = "bottom",
  className,
}: {
  text: string;
  side?: "right" | "top" | "bottom";
  /** Cor do ícone — passe quando o header for colorido (nota/grupo). */
  className?: string;
}) {
  return (
    <Tooltip label={text} side={side} wide className="shrink-0">
      <span
        // hover-only; stopPropagation evita iniciar drag do node ao mirar o ícone
        onPointerDown={(e) => e.stopPropagation()}
        className={cn("flex items-center cursor-help", className ?? "text-textMuted hover:text-brand")}
        aria-label="Como usar"
      >
        <HelpCircle size={12} />
      </span>
    </Tooltip>
  );
}
