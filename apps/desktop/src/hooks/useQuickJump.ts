// src/hooks/useQuickJump.ts
//
// Quick Jump: Alt+1..9 pula direto pro floor N. Útil quando o dispatch paralelo
// cria vários floors-branch. O listener é em CAPTURE phase pra interceptar antes
// do xterm (senão um terminal focado engoliria o atalho).

import { useEffect } from "react";
import { useCanvasStore } from "@/store/canvas-store";

export function useQuickJump(): void {
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Alt+dígito, sem ctrl/meta (evita pegar combos do sistema/terminal).
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (!/^[1-9]$/.test(e.key)) return;
      const idx = Number(e.key) - 1;
      const st = useCanvasStore.getState();
      // Floors do projeto ativo (floors é flat no store).
      const pf = st.parallels.filter((f) => f.projectId === st.activeProjectId);
      if (idx >= pf.length) return;
      e.preventDefault();
      e.stopPropagation();
      st.switchParallel(pf[idx].id);
    };
    window.addEventListener("keydown", handler, true); // capture: antes do xterm
    return () => window.removeEventListener("keydown", handler, true);
  }, []);
}
