// src/hooks/useNodeMaximize.tsx
//
// Maximizar CONSISTENTE pra qualquer node do canvas. Devolve:
//  - maxBtn  → o botão pro header (⤡ / ⧉)
//  - frame() → renderiza o node normal OU um overlay tela-cheia (portal, fora do
//              transform do React Flow). Padrão pra TODO node de conteúdo.

import { useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Maximize2, Minimize2 } from "lucide-react";

export function useNodeMaximize(size?: { w?: string; h?: string }) {
  const [maximized, setMaximized] = useState(false);

  const maxBtn = (
    <button
      onClick={(e) => { e.stopPropagation(); setMaximized((m) => !m); }}
      title={maximized ? "Restaurar" : "Maximizar"}
      className="hover:text-brand shrink-0"
    >
      {maximized ? <Minimize2 size={12} /> : <Maximize2 size={12} />}
    </button>
  );

  /** `card` = o conteúdo (header+corpo); `node` = o card embrulhado no node normal. */
  function frame(card: ReactNode, node: ReactNode): ReactNode {
    if (!maximized) return node;
    return createPortal(
      <div className="fixed inset-0 z-[9999] bg-black/60 flex items-center justify-center p-4" onClick={() => setMaximized(false)}>
        <div
          className={`${size?.w ?? "w-[85vw]"} ${size?.h ?? "h-[88vh]"} rounded-lg border border-border bg-surface1 shadow-2xl flex flex-col overflow-hidden`}
          onClick={(e) => e.stopPropagation()}
        >
          {card}
        </div>
      </div>,
      document.body,
    );
  }

  return { maximized, maxBtn, frame };
}
