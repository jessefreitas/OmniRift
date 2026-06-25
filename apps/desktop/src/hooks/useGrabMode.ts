// src/hooks/useGrabMode.ts
//
// Máquina de estado do Design Mode grab (ref RE 06 §5, useGrabMode.ts).
//
//   idle → armed → awaiting → confirming → idle
//                     │            │
//                     └────────────┴──→ error  (cross-origin, timeout, falha)
//
// - `armed`: overlay instalado no iframe, esperando o hover do usuário.
// - `awaiting`: aguardando o click que captura o elemento.
// - `confirming`: payload capturado, mostrando ações (copiar / enviar pro agente).
// - `error`: cross-origin (sem acesso ao DOM), timeout (120s) ou falha de injeção.
//
// STALE GUARD: cada arme gera um `opId` monotônico. Resultados (pick/cancel/timeout)
// que chegam com um opId != o corrente são IGNORADOS (troca de URL/reload/re-arme no
// meio de um grab não pode resolver a operação errada — ref §6.3).
//
// A lógica de transição é extraída em `grabReducer` (PURO, testável via node): o
// reducer ignora ações com opId stale e só transita pelos caminhos válidos.

import { useCallback, useEffect, useRef, useState } from "react";

import { armGrab, type GrabGuestHandle } from "@/lib/grab/guest-script";
import { clampPayload, type GrabPayload } from "@/lib/grab/payload";

export type GrabState = "idle" | "armed" | "awaiting" | "confirming" | "error";

/** Timeout duro de uma operação de grab (ref GRAB_OP_TIMEOUT_MS). */
export const GRAB_OP_TIMEOUT_MS = 120_000;

export interface GrabMachine {
  state: GrabState;
  /** opId da operação corrente (incrementa a cada arme). */
  opId: number;
  /** Payload capturado, presente em `confirming`. */
  payload: GrabPayload | null;
  /** Mensagem em `error`. */
  error: string | null;
}

export type GrabAction =
  | { type: "ARM"; opId: number }
  | { type: "AWAIT"; opId: number }
  | { type: "PICK"; opId: number; payload: GrabPayload }
  | { type: "CANCEL"; opId: number }
  | { type: "TIMEOUT"; opId: number }
  | { type: "ERROR"; opId: number; message: string }
  | { type: "RESET" };

export const initialGrabMachine: GrabMachine = { state: "idle", opId: 0, payload: null, error: null };

/**
 * Reducer PURO da máquina. Ignora ações com opId stale (≠ opId corrente), exceto
 * ARM (que abre uma nova op) e RESET (sempre volta pra idle).
 */
export function grabReducer(m: GrabMachine, a: GrabAction): GrabMachine {
  switch (a.type) {
    case "ARM":
      // Novo arme: adota o opId da ação como corrente.
      return { state: "armed", opId: a.opId, payload: null, error: null };
    case "RESET":
      return { ...initialGrabMachine, opId: m.opId };
    default:
      break;
  }
  // Daqui pra baixo, ações stale (opId diferente do corrente) são descartadas.
  if (a.opId !== m.opId) return m;
  switch (a.type) {
    case "AWAIT":
      return m.state === "armed" ? { ...m, state: "awaiting" } : m;
    case "PICK":
      // Só aceita pick enquanto armado/aguardando.
      if (m.state !== "armed" && m.state !== "awaiting") return m;
      return { ...m, state: "confirming", payload: clampPayload(a.payload), error: null };
    case "CANCEL":
      return { ...initialGrabMachine, opId: m.opId };
    case "TIMEOUT":
      if (m.state !== "armed" && m.state !== "awaiting") return m;
      return { ...m, state: "error", payload: null, error: "Tempo esgotado (120s) — captura cancelada." };
    case "ERROR":
      return { ...m, state: "error", payload: null, error: a.message };
    default:
      return m;
  }
}

export interface UseGrabModeResult {
  state: GrabState;
  payload: GrabPayload | null;
  error: string | null;
  /** Liga/desliga o grab no iframe dado. */
  toggle: (iframe: HTMLIFrameElement | null) => void;
  /** Cancela / limpa (volta a idle). */
  reset: () => void;
}

/**
 * Hook que dirige o grab num iframe. Cross-origin (sem acesso ao DOM) → estado
 * `error` com mensagem de degradação. Timeout duro de 120s.
 */
export function useGrabMode(crossOriginMessage: string): UseGrabModeResult {
  const [machine, setMachine] = useState<GrabMachine>(initialGrabMachine);
  const opRef = useRef(0);
  const handleRef = useRef<GrabGuestHandle | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimer = () => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
  };
  const teardownGuest = () => {
    handleRef.current?.teardown();
    handleRef.current = null;
  };

  const reset = useCallback(() => {
    clearTimer();
    teardownGuest();
    setMachine((m) => grabReducer(m, { type: "RESET" }));
  }, []);

  const toggle = useCallback((iframe: HTMLIFrameElement | null) => {
    // Se já está ativo (armed/awaiting/confirming/error), desliga.
    setMachine((m) => {
      if (m.state !== "idle") {
        clearTimer();
        teardownGuest();
        return grabReducer(m, { type: "RESET" });
      }
      // Liga: abre uma nova op.
      const opId = ++opRef.current;
      if (!iframe) {
        return grabReducer({ ...m, opId }, { type: "ERROR", opId, message: crossOriginMessage });
      }
      const handle = armGrab(
        iframe,
        (p) => {
          if (opRef.current !== opId) return; // stale.
          clearTimer();
          teardownGuest();
          setMachine((cur) => grabReducer(cur, { type: "PICK", opId, payload: p }));
        },
        () => {
          if (opRef.current !== opId) return; // stale.
          clearTimer();
          teardownGuest();
          setMachine((cur) => grabReducer(cur, { type: "CANCEL", opId }));
        },
      );
      if (!handle) {
        // Cross-origin / doc inacessível → degradação clara.
        return grabReducer({ ...m, opId }, { type: "ERROR", opId, message: crossOriginMessage });
      }
      handleRef.current = handle;
      // Timeout duro.
      clearTimer();
      timerRef.current = setTimeout(() => {
        if (opRef.current !== opId) return;
        teardownGuest();
        setMachine((cur) => grabReducer(cur, { type: "TIMEOUT", opId }));
      }, GRAB_OP_TIMEOUT_MS);
      // Transição armed → awaiting (overlay vivo, esperando click).
      const armed = grabReducer({ ...m, opId }, { type: "ARM", opId });
      return grabReducer(armed, { type: "AWAIT", opId });
    });
  }, [crossOriginMessage]);

  // Limpa ao desmontar.
  useEffect(() => () => { clearTimer(); teardownGuest(); }, []);

  return { state: machine.state, payload: machine.payload, error: machine.error, toggle, reset };
}
