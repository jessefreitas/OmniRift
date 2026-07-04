// src/components/TourOverlay.tsx — Overlay do tour guiado (spotlight + popover).
// Zero dependência nova: posicionamento via getBoundingClientRect.

import { useEffect, useState, useCallback } from "react";
import { useTourStore } from "@/store/tour-store";
import { useI18n } from "@/lib/i18n";
import { translate } from "@/lib/i18n";
import { MISSION_ORDER, type MissionId } from "@/lib/tour/tour-missions";

type Placement = "top" | "bottom" | "left" | "right";

const POPOVER_WIDTH = 384; // max-w-sm
const POPOVER_HEIGHT = 220;
const GAP = 12;

function missionTourId(mission: MissionId): string {
  switch (mission) {
    case "open-project":
      return "sidebar";
    case "create-agent":
      return "new-agent";
    case "send-message":
      return "agent-terminal";
    case "move-canvas":
      return "canvas";
    case "save-workspace":
      return "save-workspace";
    case "connect-agents":
      return "canvas";
    case "see-kanban":
      return "kanban-toggle";
    default:
      return "canvas";
  }
}

function getCenterRect(): DOMRect {
  const w = 320;
  const h = 200;
  const left = window.innerWidth / 2 - w / 2;
  const top = window.innerHeight / 2 - h / 2;
  return {
    x: left,
    y: top,
    left,
    top,
    right: left + w,
    bottom: top + h,
    width: w,
    height: h,
    toJSON: () => ({}),
  } as DOMRect;
}

function getTargetRect(mission: MissionId): DOMRect {
  const id = missionTourId(mission);
  const el = document.querySelector(`[data-tour-id="${id}"]`) as HTMLElement | null;
  return el?.getBoundingClientRect() ?? getCenterRect();
}

function getBestPlacement(rect: DOMRect): Placement {
  const spaceTop = rect.top;
  const spaceBottom = window.innerHeight - rect.bottom;
  const spaceLeft = rect.left;
  const spaceRight = window.innerWidth - rect.right;

  if (spaceTop >= POPOVER_HEIGHT + GAP && rect.left + POPOVER_WIDTH <= window.innerWidth) {
    return "top";
  }
  if (spaceBottom >= POPOVER_HEIGHT + GAP && rect.left + POPOVER_WIDTH <= window.innerWidth) {
    return "bottom";
  }
  if (spaceRight >= POPOVER_WIDTH + GAP) {
    return "right";
  }
  if (spaceLeft >= POPOVER_WIDTH + GAP) {
    return "left";
  }
  return "bottom";
}

const MISSION_TEXT: Record<MissionId, { title: string; desc: string }> = {
  "open-project": {
    title: "Abrir um projeto",
    desc: "Você já tem um projeto aberto! O canvas à esquerda é a Sidebar. Nela você abre pastas, cria agentes e salva seu workspace.",
  },
  "create-agent": {
    title: "Criar um agente",
    desc: 'Clique em "Novo agente" na Sidebar para adicionar um assistente de IA ao canvas.',
  },
  "send-message": {
    title: "Mandar mensagem pro agente",
    desc: "Digite no terminal do agente que você criou e espere ele responder.",
  },
  "move-canvas": {
    title: "Mover o canvas",
    desc: "Arraste o fundo vazio ou use o scroll do mouse para dar zoom. Explore o canvas infinito.",
  },
  "save-workspace": {
    title: "Salvar o workspace",
    desc: "Clique em Salvar na Sidebar para persistir seu canvas.",
  },
  "connect-agents": {
    title: "Conectar agentes",
    desc: "Arraste de um agente até outro para criar uma conexão. A saída de um vira entrada do outro.",
  },
  "see-kanban": {
    title: "Ver o Kanban",
    desc: "Abra o painel Kanban na Sidebar para ver os cards do seu projeto.",
  },
};

/** Conteúdo do overlay — só monta quando há missão ativa (hooks incondicionais). */
function TourOverlayContent({
  mission,
  currentMissionIndex,
}: {
  mission: MissionId;
  currentMissionIndex: number;
}) {
  const locale = useI18n((s) => s.locale);
  const t = useCallback(
    (key: string, fallback: string) => translate(locale, key, fallback),
    [locale],
  );

  const [targetRect, setTargetRect] = useState<DOMRect>(() => getTargetRect(mission));
  const [placement, setPlacement] = useState<Placement>(() =>
    getBestPlacement(getTargetRect(mission)),
  );

  const update = useCallback(() => {
    const rect = getTargetRect(mission);
    setTargetRect(rect);
    setPlacement(getBestPlacement(rect));
  }, [mission]);

  useEffect(() => {
    // Posicionamento do spotlight precisa recalcular após o render — intencional.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [update]);

  const popoverStyle: React.CSSProperties =
    placement === "top"
      ? { left: targetRect.left, top: targetRect.top - POPOVER_HEIGHT - GAP, maxWidth: POPOVER_WIDTH }
      : placement === "bottom"
        ? { left: targetRect.left, top: targetRect.bottom + GAP, maxWidth: POPOVER_WIDTH }
        : placement === "left"
          ? { left: targetRect.left - POPOVER_WIDTH - GAP, top: targetRect.top, maxWidth: POPOVER_WIDTH }
          : { left: targetRect.right + GAP, top: targetRect.top, maxWidth: POPOVER_WIDTH };

  const text = MISSION_TEXT[mission];

  return (
    <>
      {/* Scrim */}
      <div className="fixed inset-0 bg-black/40 z-[9998]" />

      {/* Spotlight — box-shadow escurece tudo fora do retângulo */}
      <div
        className="absolute z-[9999]"
        style={{
          left: targetRect.left,
          top: targetRect.top,
          width: targetRect.width,
          height: targetRect.height,
          backgroundColor: "transparent",
          boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.4)",
          borderRadius: 8,
          pointerEvents: "none",
        }}
      />

      {/* Popover */}
      <div
        className="absolute z-[9999] bg-white dark:bg-zinc-900 text-zinc-900 dark:text-zinc-100 rounded-lg shadow-xl border border-zinc-200 dark:border-zinc-800 p-4"
        style={popoverStyle}
      >
        <h3 className="font-semibold text-base mb-1">
          {t(`tour.mission.${mission}.title`, text.title)}
        </h3>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-4">
          {t(`tour.mission.${mission}.desc`, text.desc)}
        </p>

        <div className="flex items-center justify-between gap-2">
          {mission === "open-project" ? (
            <button
              type="button"
              onClick={() =>
                useTourStore.getState().setCurrentMissionIndex(currentMissionIndex + 1)
              }
              className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-80 text-sm font-medium"
            >
              {t("tour.next", "Próximo")}
            </button>
          ) : (
            <span className="text-sm text-zinc-500 dark:text-zinc-500">
              {t("tour.waiting", "Aguardando você fazer isso...")}
            </span>
          )}

          <button
            type="button"
            onClick={() => useTourStore.getState().dismiss()}
            className="px-3 py-1.5 rounded-md bg-zinc-900 text-white dark:bg-white dark:text-zinc-900 hover:opacity-80 text-sm font-medium"
          >
            {t("tour.skip", "Pular tour")}
          </button>
        </div>
      </div>
    </>
  );
}

/** Overlay do tour — wrapper que decide se renderiza conteúdo. */
export function TourOverlay() {
  const isActive = useTourStore((s) => s.isActive);
  const currentMissionIndex = useTourStore((s) => s.currentMissionIndex);

  if (!isActive) return null;

  const mission = MISSION_ORDER[currentMissionIndex];
  if (!mission) return null;

  return <TourOverlayContent mission={mission} currentMissionIndex={currentMissionIndex} />;
}
