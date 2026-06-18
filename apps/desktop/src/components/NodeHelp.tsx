// src/components/NodeHelp.tsx
//
// "Como usar" CONSISTENTE pra qualquer node. Um ícone "?" no header que, no hover,
// abre um balão com instruções. O balão é PORTALIZADO (position:fixed em
// document.body) pra NÃO ser cortado pelo `overflow-hidden` do node, e é
// reposicionado pra caber na tela (clamp horizontal + flip pra cima se faltar
// espaço embaixo).

import { useRef, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { HelpCircle } from "lucide-react";
import { cn } from "@/lib/cn";
import { useT } from "@/lib/i18n";

const W = 240; // largura do balão

export function NodeHelp({
  text,
  className,
}: {
  text: string;
  /** Cor do ícone — passe quando o header for colorido (nota/grupo). */
  className?: string;
  /** Aceito por compat (ignorado: a posição é calculada). */
  side?: "right" | "top" | "bottom";
}) {
  const t = useT();
  const ref = useRef<HTMLSpanElement | null>(null);
  const [box, setBox] = useState<CSSProperties | null>(null);

  function show() {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    // Alinha pela direita do ícone (cresce pra esquerda) e mantém na tela.
    const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8));
    const openUp = r.bottom + 150 > window.innerHeight;
    setBox(
      openUp
        ? { left, bottom: window.innerHeight - r.top + 6, width: W }
        : { left, top: r.bottom + 6, width: W },
    );
  }

  return (
    <>
      <span
        ref={ref}
        onPointerDown={(e) => e.stopPropagation()}
        onMouseEnter={show}
        onMouseLeave={() => setBox(null)}
        className={cn("flex items-center cursor-help", className ?? "text-textMuted hover:text-brand")}
        aria-label={t("nodeHelp.ariaLabel", "Como usar")}
      >
        <HelpCircle size={12} />
      </span>
      {box &&
        createPortal(
          <div
            style={{ position: "fixed", ...box }}
            className="z-[10000] pointer-events-none rounded-md border border-border bg-surface2 px-2 py-1.5 text-[11px] leading-snug text-text shadow-lg whitespace-normal"
          >
            {text}
          </div>,
          document.body,
        )}
    </>
  );
}
