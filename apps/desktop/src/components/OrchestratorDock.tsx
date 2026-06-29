// src/components/OrchestratorDock.tsx
//
// Dock onipresente do Orquestrador: painel flutuante visível em QUALQUER floor.
// Não cria xterm próprio — é só o HOST: publica seu <div> alvo em
// orchestrator-dock-mount, e o TerminalNode do orquestrador reloca o PRÓPRIO
// xterm (appendChild) pra cá. Mesmo elemento, mesma sessão → pixel-perfect.

import { useEffect, useMemo, useRef, useState } from "react";
import { Crown, ChevronDown, ChevronUp, CornerUpRight } from "lucide-react";

import { useCanvasStore } from "@/store/canvas-store";
import { setOrchestratorMount } from "@/lib/orchestrator-dock-mount";
import { StatusDot } from "@/components/StatusDot";
import { useT } from "@/lib/i18n";

export function OrchestratorDock() {
  const t = useT();
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);
  const parallels = useCanvasStore((s) => s.parallels);
  const activeParallelId = useCanvasStore((s) => s.activeParallelId);
  const switchParallel = useCanvasStore((s) => s.switchParallel);
  const status = useCanvasStore((s) =>
    orchestratorSid ? (s.terminalStatuses[orchestratorSid] ?? "idle") : "idle",
  );
  const [collapsed, setCollapsed] = useState(false);
  const mountRef = useRef<HTMLDivElement | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ ox: number; oy: number; sx: number; sy: number } | null>(null);

  // Posição do dock (arrastável). null = canto inferior-direito padrão.
  const [pos, setPos] = useState<{ x: number; y: number } | null>(() => {
    try {
      const s = localStorage.getItem("omnirift-dock-pos");
      return s ? JSON.parse(s) : null;
    } catch {
      return null;
    }
  });

  // Arrasta o dock pelo header (ignora cliques nos botões).
  const onDragStart = (e: React.PointerEvent) => {
    if ((e.target as HTMLElement).closest("button")) return;
    const r = panelRef.current?.getBoundingClientRect();
    if (!r) return;
    dragRef.current = { ox: r.left, oy: r.top, sx: e.clientX, sy: e.clientY };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onDragMove = (e: React.PointerEvent) => {
    const d = dragRef.current;
    if (!d) return;
    const x = Math.max(0, Math.min(window.innerWidth - 80, d.ox + (e.clientX - d.sx)));
    const y = Math.max(0, Math.min(window.innerHeight - 32, d.oy + (e.clientY - d.sy)));
    setPos({ x, y });
  };
  const onDragEnd = (e: React.PointerEvent) => {
    if (dragRef.current && pos) {
      try { localStorage.setItem("omnirift-dock-pos", JSON.stringify(pos)); } catch { /* ignore */ }
    }
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Acha o nó do orquestrador (e seu floor) entre todos os floors.
  const orch = useMemo(() => {
    if (!orchestratorSid) return null;
    for (const f of parallels) {
      const n = f.nodes.find((x) => x.kind === "terminal" && x.session_id === orchestratorSid);
      if (n && n.kind === "terminal") return { label: n.label ?? n.command, floor: f };
    }
    return null;
  }, [parallels, orchestratorSid]);

  // Publica o alvo de montagem a cada render (idempotente no singleton);
  // limpa no unmount → o TerminalNode devolve o xterm pro seu floor.
  useEffect(() => {
    setOrchestratorMount(mountRef.current);
  });
  useEffect(() => () => setOrchestratorMount(null), []);

  if (!orch) return null; // nenhum orquestrador designado → sem dock

  const onOrchFloor = orch.floor.id === activeParallelId;
  // No floor do próprio Orquestrador o terminal volta pro node → sem dock flutuante.
  // (getOrchestratorMount() vira null → TerminalNode recoloca o xterm no slot do nó.)
  if (onOrchFloor) return null;

  return (
    <div
      ref={panelRef}
      className="absolute z-40 w-[440px] flex flex-col rounded-lg border border-yellow-500/40 bg-surface1 shadow-2xl overflow-hidden"
      style={pos ? { left: pos.x, top: pos.y } : { bottom: 12, right: 12 }}
    >
      <header
        onPointerDown={onDragStart}
        onPointerMove={onDragMove}
        onPointerUp={onDragEnd}
        className="flex items-center gap-2 px-3 py-1.5 bg-surface2 border-b border-border text-textMuted shrink-0 cursor-move select-none"
      >
        <Crown size={13} className="text-yellow-500 shrink-0" />
        <span className="text-xs font-medium text-yellow-400 truncate">{orch.label}</span>
        <span className="text-[9px] text-yellow-500/80 font-normal shrink-0">{t("orchestrator.orqBadge", "orq")}</span>
        <StatusDot status={status} size={5} />
        <span className="flex-1" />
        <span
          className="text-[9px] text-textMuted opacity-70 truncate max-w-[110px]"
          title={`${t("orchestrator.floor", "Paralelo")}: ${orch.floor.name}`}
        >
          {orch.floor.name}
        </span>
        {!onOrchFloor && (
          <button
            onClick={() => switchParallel(orch.floor.id)}
            title={t("orchestrator.goToFloor", "Ir pro paralelo do Orquestrador")}
            className="p-0.5 rounded hover:bg-bg hover:text-text transition-colors shrink-0"
          >
            <CornerUpRight size={13} />
          </button>
        )}
        <button
          onClick={() => setCollapsed((c) => !c)}
          title={collapsed ? t("orchestrator.expand", "Expandir") : t("orchestrator.minimize", "Minimizar")}
          className="p-0.5 rounded hover:bg-bg hover:text-text transition-colors shrink-0"
        >
          {collapsed ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
        </button>
      </header>
      {/* Alvo do xterm relocado. Colapsado = display:none (o FitAddon detecta
          dimensão zero e NÃO redimensiona o PTY; o xterm fica no DOM, oculto). */}
      <div
        ref={mountRef}
        className="relative bg-bg h-[280px]"
        style={{ display: collapsed ? "none" : "block" }}
      />
    </div>
  );
}
