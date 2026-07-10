// components/ConstructorPanel.tsx
//
// Painel flutuante ARRASTÁVEL do Constructor — a janela de resposta que flutua no canvas.
// A barra (ConductorBar) é só o input + seletor de cérebro; ESTE painel mostra a conversa
// (você ↔ Constructor ↔ agentes). Arrasta pelo header, redimensiona pelo canto, fecha no X.

import { useRef, useState, useCallback, useEffect } from "react";
import { X, GripHorizontal } from "lucide-react";

export interface ConstructorMsg {
  role: "user" | "agent" | "system" | "error";
  text: string;
  ts: number;
}

export function ConstructorPanel({
  messages,
  onClose,
}: {
  messages: ConstructorMsg[];
  onClose: () => void;
}) {
  // Posição inicial: canto superior direito do canvas (não cobre a barra de baixo).
  const [pos, setPos] = useState(() => ({
    x: Math.max(16, window.innerWidth - 436),
    y: 76,
  }));
  const dragRef = useRef<{ dx: number; dy: number } | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  const onHeaderDown = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { dx: e.clientX - pos.x, dy: e.clientY - pos.y };
      e.preventDefault();
    },
    [pos],
  );

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragRef.current) return;
      setPos({
        x: Math.max(0, Math.min(window.innerWidth - 200, e.clientX - dragRef.current.dx)),
        y: Math.max(0, Math.min(window.innerHeight - 80, e.clientY - dragRef.current.dy)),
      });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, []);

  // Auto-scroll pro fim quando chega mensagem nova.
  useEffect(() => {
    if (bodyRef.current) bodyRef.current.scrollTop = bodyRef.current.scrollHeight;
  }, [messages]);

  return (
    <div
      className="fixed z-40 flex flex-col rounded-xl bg-bg/95 backdrop-blur-md shadow-2xl border border-brand/40 overflow-hidden"
      style={{
        left: pos.x,
        top: pos.y,
        width: 420,
        height: 340,
        minWidth: 260,
        minHeight: 160,
        resize: "both",
        boxShadow: "0 0 24px -4px rgba(59,139,212,0.25), 0 8px 32px -8px rgba(0,0,0,0.5)",
      }}
    >
      {/* Header arrastável */}
      <div
        onMouseDown={onHeaderDown}
        className="flex items-center gap-1.5 px-3 py-1.5 border-b border-border/40 cursor-move select-none bg-brand/5 shrink-0"
      >
        <GripHorizontal size={12} className="text-textMuted" />
        <span className="text-[11px] font-medium text-brand">Constructor</span>
        <span className="text-[9px] text-textMuted">— conversa com o sistema</span>
        <button
          onClick={onClose}
          className="ml-auto text-textMuted hover:text-red-400 p-0.5 transition-colors"
          title="Fechar painel"
        >
          <X size={13} />
        </button>
      </div>

      {/* Conversa */}
      <div ref={bodyRef} className="flex-1 overflow-y-auto px-3 py-2 space-y-1 min-h-0">
        {messages.length === 0 ? (
          <div className="text-[11px] text-textMuted italic leading-snug">
            Converse com o sistema pela barra abaixo — as respostas aparecem aqui. O Constructor
            conhece o canvas e o código, e pode comandar o Orquestrador.
          </div>
        ) : (
          messages.map((m, i) => (
            <div
              key={i}
              className={`text-[11px] font-mono leading-snug whitespace-pre-wrap break-words ${
                m.role === "user"
                  ? "text-brand"
                  : m.role === "error"
                    ? "text-red-400"
                    : m.role === "system"
                      ? "text-textMuted"
                      : "text-text"
              }`}
            >
              <span className="text-textMuted text-[9px] mr-1 tabular-nums">
                {new Date(m.ts).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })}
              </span>
              {m.text}
            </div>
          ))
        )}
      </div>
    </div>
  );
}
