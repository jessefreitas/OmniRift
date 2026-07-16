// Hook genérico de "painel flutuante arrastável": prende um elemento pelo grip, clampa
// dentro da viewport e persiste a posição por storageKey (localStorage). Sem posição salva,
// style é undefined (o CSS default posiciona); ao arrastar, vira {left, top} absoluto.
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
    } catch {
      return null;
    }
    return null;
  });

  // `fixed` (não `absolute`): assim left/top são coordenadas de VIEWPORT, batendo com o
  // clientX/clientY do drag. Com `absolute` o offset do container (sidebar/aba) fazia o
  // painel saltar pra longe do cursor. `right:auto` neutraliza o `right-3` do default.
  const style: CSSProperties | undefined = pos
    ? { position: "fixed", left: pos.x, top: pos.y, right: "auto" }
    : undefined;

  const onPointerDown = (e: ReactPointerEvent) => {
    const el = ref.current;
    if (!el) return;

    const rect = el.getBoundingClientRect();
    const dx = e.clientX - rect.left;
    const dy = e.clientY - rect.top;
    const w = el.offsetWidth;
    const h = el.offsetHeight;

    e.preventDefault();

    // Handler de movimento: recalcula left/top clampados dentro da viewport
    const move = (ev: PointerEvent) => {
      const x = clamp(ev.clientX - dx, 0, window.innerWidth - w);
      const y = clamp(ev.clientY - dy, 0, window.innerHeight - h);
      setPos({ x, y });
    };

    // Handler de soltar: remove listeners e persiste a posição no localStorage
    const up = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);

      setPos((current) => {
        if (current) {
          try {
            localStorage.setItem(storageKey, JSON.stringify(current));
          } catch {}
        }
        return current;
      });
    };

    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
  };

  return { ref, onPointerDown, style, floating: pos !== null };
}