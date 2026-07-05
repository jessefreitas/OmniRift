// src/hooks/useOrchestrationWatchdog.ts — vigia o time de agentes e cobra o líder.
//
// POR QUE EXISTE: deadlock silencioso observado em produção — o Pipeline monta o
// time, os workers (corretamente) aguardam o contrato, e se o líder/Arquiteto
// deriva e não entrega as fatias, NINGUÉM age: a Recitação pega carona em
// mensagens (time parado = sem turnos = sem recitação) e o usuário paga um time
// inteiro ocioso sem ser avisado.
//
// O QUE OBSERVA (tick de 30s, floor do orquestrador): agentes ociosos (sem turno
// recente via agent-metrics), atividade em curso e entrega no Kanban (card de
// tarefa = nodeId null, ou qualquer card fora do backlog).
//
// ESCADA (máquina pura em lib/orchestration/watchdog.ts, testada): 5 min de
// stall → cobrança 1 no líder (acp_prompt) → +5 min → cobrança 2 → +5 min →
// toast pro usuário → silêncio até o fluxo se recuperar (aí reseta).
//
// Kill-switch: feature flag "orchestration-watchdog". Erros todos engolidos —
// o watchdog nunca quebra a UI.

import { useEffect, useRef } from "react";
import { useCanvasStore } from "@/store/canvas-store";
import { useAgentMetrics } from "@/lib/agent-metrics";
import { kanbanList, kanbanCardCreate } from "@/lib/kanban-client";
import { acpPrompt } from "@/lib/acp-client";
import { notify } from "@/lib/notify";
import { getFlag } from "@/lib/feature-flags";
import {
  stepWatchdog,
  INITIAL_WATCHDOG_STATE,
  DEFAULT_WATCHDOG_OPTS,
  type WatchdogState,
  type WatchdogSignals,
} from "@/lib/orchestration/watchdog";

const INTERVAL_MS = 30_000;
/** Turno concluído há menos disto = time ativo (não é stall). */
const ACTIVE_MS = 60_000;
/** Agente sem turno há isto (ou nunca) = ocioso esperando trabalho. */
const IDLE_MS = 120_000;

const NUDGE1 =
  "⏰ WATCHDOG DA ORQUESTRAÇÃO: sua equipe está ociosa há minutos esperando o contrato. " +
  "AGORA: (1) registre o contrato com memory_remember; (2) crie as fatias como cards com " +
  "kanban_card_create e mova a primeira pra 'doing'; (3) acione o agente responsável com " +
  "terminal_send_text. Não descreva o plano — EXECUTE os passos.";

const NUDGE2 =
  "⏰ WATCHDOG — SEGUNDA COBRANÇA: sua equipe CONTINUA parada esperando as fatias. " +
  "Registre o contrato (memory_remember), crie os cards (kanban_card_create) e acione um " +
  "agente (terminal_send_text) NESTE turno — se não entregar agora, o usuário será " +
  "alertado de que o time está travado.";

const ALERT_MSG =
  "⚠️ Seu time de agentes está parado há vários minutos esperando o Arquiteto entregar " +
  "as fatias. Verifique o terminal dele ou o Kanban do projeto.";

const REVIEW_PROMPT =
  "📋 REVIEW DO CONTRATO: o Arquiteto registrou o contrato e as fatias do projeto. " +
  "ANTES da implementação avançar, revise: rode kanban_list e memory_recall, avalie se " +
  "as interfaces fazem sentido, se as fatias são independentes e quais os riscos. " +
  "Grave seu parecer com kanban_card_note no card 'Review do contrato'.";

/** Signals "neutros" pros caminhos sem orquestrador/floor — só servem pro reset. */
function absentSignals(now: number): WatchdogSignals {
  return { now, orchestratorPresent: false, readyIdleAgents: 0, anyRunning: false, hasDelivery: false };
}

export function useOrchestrationWatchdog(): void {
  const stateRef = useRef<WatchdogState>(INITIAL_WATCHDOG_STATE);
  // Parte C (reviewer no contrato): floors cujo review do contrato já foi acionado
  // (uma vez por floor) + último hasDelivery visto (pra detectar a TRANSIÇÃO).
  const reviewDoneRef = useRef<Set<string>>(new Set());
  const lastDeliveryRef = useRef<Record<string, boolean>>({});

  useEffect(() => {
    const tick = async () => {
      try {
        if (!getFlag("orchestration-watchdog")) return;

        const canvasState = useCanvasStore.getState();
        const sid = canvasState.orchestratorSid;
        const now = Date.now();

        if (!sid) {
          stateRef.current = stepWatchdog(stateRef.current, absentSignals(now), DEFAULT_WATCHDOG_OPTS).state;
          return;
        }

        const floor = canvasState.parallels.find((p) => p.nodes.some((n) => n.id === sid));
        if (!floor) {
          stateRef.current = stepWatchdog(stateRef.current, absentSignals(now), DEFAULT_WATCHDOG_OPTS).state;
          return;
        }

        const turnsByNode = useAgentMetrics.getState().turnsByNode;
        const lastAt = (nodeId: string): number => {
          const turns = turnsByNode[nodeId];
          return turns && turns.length > 0 ? turns[turns.length - 1].at : 0;
        };

        const teamAgents = floor.nodes.filter((n) => n.kind === "agent" && n.id !== sid);

        // Turno recente em QUALQUER um (líder incluso) = time ativo, não é stall.
        const anyRunning = [sid, ...teamAgents.map((a) => a.id)].some(
          (id) => now - lastAt(id) < ACTIVE_MS,
        );
        // Workers sem turno há IDLE_MS (ou que nunca rodaram) = ociosos esperando.
        const readyIdleAgents = teamAgents.filter((a) => now - lastAt(a.id) >= IDLE_MS).length;

        // Entrega = card de tarefa (nodeId null) OU qualquer card fora do backlog.
        // Floor sem projeto → não vigia (hasDelivery true = nunca staleia).
        const hasDelivery =
          floor.cwd === null
            ? true
            : (await kanbanList(floor.cwd)).some((c) => c.nodeId === null || c.col !== "backlog");

        // Parte C — reviewer entra no CONTRATO (não só no diff final): na TRANSIÇÃO
        // "sem entrega → 1ª entrega", cria o card de review e cutuca o Code Reviewer
        // do floor (label contendo "review"). Uma vez por floor; fail-soft sem reviewer.
        const seen = floor.id in lastDeliveryRef.current;
        const prevDelivery = lastDeliveryRef.current[floor.id] ?? false;
        lastDeliveryRef.current[floor.id] = hasDelivery;
        // `seen`: o 1º tick de um floor só OBSERVA (senão reabrir o app num projeto
        // já em andamento dispararia o review de um contrato antigo).
        if (seen && hasDelivery && !prevDelivery && !reviewDoneRef.current.has(floor.id) && floor.cwd) {
          const reviewer = teamAgents.find((a) =>
            ((a as { label?: string }).label ?? "").toLowerCase().includes("review"),
          );
          if (reviewer) {
            reviewDoneRef.current.add(floor.id);
            console.log("[watchdog] contrato entregue → acionando reviewer", reviewer.id);
            void kanbanCardCreate({
              project: floor.cwd,
              title: "Review do contrato",
              body: "Parecer do Code Reviewer sobre o contrato/fatias ANTES da implementação (criado pelo watchdog).",
              agent: "Code Reviewer",
            }).then(() => acpPrompt(reviewer.id, REVIEW_PROMPT)).catch(() => {});
          }
        }

        const { state, fire } = stepWatchdog(
          stateRef.current,
          { now, orchestratorPresent: true, readyIdleAgents, anyRunning, hasDelivery },
          DEFAULT_WATCHDOG_OPTS,
        );
        stateRef.current = state;

        if (fire) {
          console.log("[watchdog] fire:", fire);
          if (fire === "nudge1") void acpPrompt(sid, NUDGE1);
          else if (fire === "nudge2") void acpPrompt(sid, NUDGE2);
          else if (fire === "alert") void notify(ALERT_MSG);
        }
      } catch (err) {
        // Watchdog é best-effort: nunca pode quebrar a UI.
        console.error("[watchdog] tick falhou (engolido):", err);
      }
    };

    const id = setInterval(() => void tick(), INTERVAL_MS);
    return () => clearInterval(id);
  }, []);
}
