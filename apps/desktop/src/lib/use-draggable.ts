// Hook de painel flutuante arrastável. Usa setPointerCapture no grip + escuta os eventos NO
// PRÓPRIO grip (não no window): no WebKitGTK o pointerup do window às vezes não dispara e o
// listener de move ficava preso — o painel grudava no cursor ("mouse travado"). Com capture,
// pointerup/pointercancel vêm sempre pro grip capturado. Posição persistida por storageKey.
// `fixed` (não absolute): left/top em coords de viewport, batendo com o clientX/clientY do drag.
import { useRef, useState, type CSSProperties, type PointerEvent as ReactPointerEvent } from "react";

type Pos = { x: number; y: number };

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(v, max));
}

export function useDraggable(storageKey: string) {
  const ref = useRef<HTMLDivElement>(null);

  const [pos, setPos] = useState<Pos | null>(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw) return JSON.parse(raw) as Pos;
    } catch {}
    return null;
  });

  const style: CSSProperties | undefined = pos
    ? { position: "fixed", left: pos.x, top: pos.y, right: "auto" }
    : undefined;

  const onPointerDown = (e: ReactPointerEvent<HTMLElement>) => {
    const el = ref.current;
    if (!el) return;

    const grip = e.currentTarget as HTMLElement;
    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    e.preventDefault();
    try {
      grip.setPointerCapture(e.pointerId);
    } catch {}

    const move = (ev: PointerEvent) => {
      const x = clamp(ev.clientX - dx, 0, window.innerWidth - w);
      const y = clamp(ev.clientY - dy, 0, window.innerHeight - h);
      setPos({ x, y });
    };

    const up = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", up);
      grip.removeEventListener("pointercancel", up);
      try {
        grip.releasePointerCapture(e.pointerId);
      } catch {}
      setPos((current) => {
        if (current) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(current));
          } catch {}
        }
        return current;
      });
    };

    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", up);
    grip.addEventListener("pointercancel", up);
  };

  return { ref, onPointerDown, style, floating: pos !== null };
}