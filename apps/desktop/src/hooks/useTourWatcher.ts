// src/hooks/useTourWatcher.ts — Observa sinais do canvas e da ACP para avançar
// as missões do tour.
// GUARDRAIL: este hook apenas LÊ o canvas-store via seletores/zustand getters;
// nunca escreve de volta no canvas-store.

import { useCallback, useEffect, useRef } from "react";
import { useCanvasStore } from "@/store/canvas-store";
import type { CanvasNode } from "@/types/canvas";
import { useTourStore } from "@/store/tour-store";
import {
  computeMissionStatus,
  nextMission,
  MISSION_ORDER,
  type TourSignals,
  type TourBaseline,
} from "@/lib/tour/tour-missions";
import { listenAcpTurnDone } from "@/lib/acp-client";
import type { UnlistenFn } from "@tauri-apps/api/event";

interface AgentLike extends CanvasNode {
  session_id?: string;
}

/**
 * Observa sinais do canvas e da ACP para avançar as missões do tour.
 * Retorna callbacks que componentes externos devem chamar para registrar
 * interações do usuário (movimento do viewport, abertura do kanban, save).
 */
export function useTourWatcher(): {
  onMove: () => void;
  onKanbanOpen: () => void;
  onWorkspaceSave: () => void;
} {
  const isActive = useTourStore((s) => s.isActive);

  // Baseline capturada uma única vez no início do tour.
  const baselineRef = useRef<TourBaseline | null>(null);

  // Sinais acumulados em refs (não disparam re-render diretamente).
  const viewportMovedRef = useRef(false);
  const kanbanPanelOpenedRef = useRef(false);
  const workspaceSavedAtRef = useRef<number | null>(null);
  const turnsByAgentIdRef = useRef<Record<string, number>>({});
  // Ref para a função de re-avaliação (estável, lê valores atuais).
  const reevalRef = useRef<() => void>(() => {});

  // Leitura do canvas-store: somente leitura.
  const agentNodes = useCanvasStore(
    (s) =>
      s.parallels.find((f) => f.id === s.activeParallelId)?.nodes.filter(
        (n) => n.kind === "agent",
      ) ?? [],
  );
  const edges = useCanvasStore(
    (s) =>
      s.parallels.find((f) => f.id === s.activeParallelId)?.edges ?? [],
  );

  const agentNodeIds = agentNodes.map((n) => n.id);
  const agentEdgeCount = edges.filter(
    (e) => agentNodeIds.includes(e.source) && agentNodeIds.includes(e.target),
  ).length;

  // 1) Captura a baseline no exato momento em que o tour fica ativo.
  useEffect(() => {
    if (!isActive || baselineRef.current) return;

    const state = useCanvasStore.getState();
    const activeId = state.activeParallelId;
    const nodes = state.parallels.find((f) => f.id === activeId)?.nodes ?? [];
    const edgesAtStart = state.parallels.find((f) => f.id === activeId)?.edges ?? [];

    const ids = nodes.filter((n) => n.kind === "agent").map((n) => n.id);
    const count = edgesAtStart.filter(
      (e) => ids.includes(e.source) && ids.includes(e.target),
    ).length;

    baselineRef.current = { agentNodeIds: ids, agentEdgeCount: count };
    // Força re-avaliação após capturar baseline.
    reevalRef.current();
  }, [isActive]);

  // 2) Escuta eventos ACP turn-done para agentes que não existiam na baseline.
  useEffect(() => {
    if (!isActive) return;

    let cancelled = false;
    const unlistenFns: UnlistenFn[] = [];

    const withSession = agentNodes.filter(
      (n) => (n as AgentLike).session_id,
    ) as AgentLike[];

    const register = async () => {
      for (const agent of withSession) {
        const sessionId = agent.session_id!;
        const unlisten = await listenAcpTurnDone(sessionId, () => {
          const baseline = baselineRef.current;
          if (!baseline) return;
          if (baseline.agentNodeIds.includes(agent.id)) return;
          turnsByAgentIdRef.current[agent.id] =
            (turnsByAgentIdRef.current[agent.id] ?? 0) + 1;
          reevalRef.current();
        });
        if (cancelled) {
          unlisten();
        } else {
          unlistenFns.push(unlisten);
        }
      }
    };

    register();

    return () => {
      cancelled = true;
      unlistenFns.forEach((u) => u());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, agentNodes.length]);

  // 3) Re-avalia missões sempre que um sinal relevante mudar.
  // reevalRef é uma função estável que lê os valores atuais e atualiza o tour-store.
  useEffect(() => {
    const reeval = () => {
      if (!isActive) return;
      const baseline = baselineRef.current;
      if (!baseline) return;

      const signals: TourSignals = {
        agentNodeIds,
        agentEdgeCount,
        viewportMoved: viewportMovedRef.current,
        kanbanPanelOpened: kanbanPanelOpenedRef.current,
        workspaceSavedAt: workspaceSavedAtRef.current,
        turnsByAgentId: { ...turnsByAgentIdRef.current },
      };

      const done = computeMissionStatus(signals, baseline);
      const nextId = nextMission(done);
      if (nextId === null) return;

      const index = MISSION_ORDER.indexOf(nextId);
      if (index === -1) return;

      const tourState = useTourStore.getState();
      if (tourState.currentMissionIndex !== index) {
        tourState.setCurrentMissionIndex(index);
      }
    };

    reevalRef.current = reeval;
    reeval();
  }, [isActive, agentNodeIds, agentEdgeCount]);

  const onMove = useCallback(() => {
    viewportMovedRef.current = true;
    reevalRef.current();
  }, []);

  const onKanbanOpen = useCallback(() => {
    kanbanPanelOpenedRef.current = true;
    reevalRef.current();
  }, []);

  const onWorkspaceSave = useCallback(() => {
    workspaceSavedAtRef.current = Date.now();
    reevalRef.current();
  }, []);

  return { onMove, onKanbanOpen, onWorkspaceSave };
}
