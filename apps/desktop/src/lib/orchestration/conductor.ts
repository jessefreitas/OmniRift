// lib/orchestration/conductor.ts
//
// Cliente do Conductor — a ponte entre a barra de input e o backend Rust.
// Quando o parser determina que precisa de interpretação (sem @, ou ambíguo),
// chama o Conductor (LLM ou Agent). Quando é determinístico (@ explícito),
// despacha direto via commands Rust.

import { invoke } from "@tauri-apps/api/core";
import { parseConductorInput, type ParsedCommand } from "./parser";
import { useCanvasStore } from "@/store/canvas-store";
import { llmChat, loadLlmConfig } from "@/lib/llm-client";
import { analyzeCanvas } from "@/lib/companion";

export type ConductorEngine = "claude" | "codex" | "hermes" | "llm" | "shell";

export interface ConductorConfig {
  engine: ConductorEngine;
  model: string | null;
}

export interface OrchestratorEntry {
  id: string;
  timestamp: number;
  source: string;
  target: string;
  payload: string;
  status: string;
  stage: number;
  parentId: string | null;
}

/** Despacha um comando do Conductor. Roteia entre determinístico e LLM. */
export async function dispatchConductor(
  input: string,
  config: ConductorConfig,
): Promise<void> {
  const parsed = parseConductorInput(input);

  if (parsed.stages.length === 0) return;

  // Log do comando original na stream
  await invoke("orchestrator_log", {
    source: "user",
    target: parsed.hasMentions ? parsed.stages.map((s) => s.mentions.map((m) => m.raw).join(" ")).join(", ") : "conductor",
    payload: input,
    status: "dispatched",
    stage: 0,
    parentId: null,
  });

  if (parsed.needsConductor && config.engine !== "shell") {
    // Precisa de interpretação → Conductor LLM/Agent
    await dispatchViaConductor(input, parsed, config.engine);
  } else {
    // Determinístico → despacha direto
    await dispatchDirect(parsed);
  }
}

/** Despacho determinístico — @ explícito, sem necessidade de LLM. */
async function dispatchDirect(parsed: ParsedCommand): Promise<void> {
  for (let i = 0; i < parsed.stages.length; i++) {
    const stage = parsed.stages[i];

    if (stage.mentions.length === 0) continue;

    const targets = stage.mentions.map((m) => m.raw).join(" ");

    // Despacha via backend (que resolve @ → AgentNode e injeta via ACP/PTY)
    const result = await invoke<string>("orchestrator_dispatch_task", {
      targets,
      task: stage.payload,
      context: stage.pipeFromPrevious ? "pipe-from-previous" : null,
      priority: "blocking",
    });

    // Log do resultado
    await invoke("orchestrator_log", {
      source: targets,
      target: "user",
      payload: result,
      status: "done",
      stage: i,
      parentId: null,
    });
  }
}

/** Despacho via Conductor LLM/Agent — precisa interpretar/decompor. */
async function dispatchViaConductor(
  input: string,
  _parsed: ParsedCommand,
  engine: ConductorEngine,
): Promise<void> {
  if (engine === "llm") {
    // Modo leve: uma chamada llm_chat com snapshot do canvas
    const cfg = loadLlmConfig();
    if (!cfg) {
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: "Configure um LLM em Ferramentas → 'LLM do review (BYOK)'.",
        status: "error",
        stage: 0,
        parentId: null,
      });
      return;
    }

    const canvasSnap = await analyzeCanvas();
    const system = `Você é o Conductor do OmniRift — o maestro de orquestração de agentes.
Olhe o canvas e o input do usuário. Decida qual agente deve fazer o quê.
Responda SEMPRE em formato JSON: {"dispatches": [{"target": "@nome", "task": "descrição", "priority": "blocking|async"}]}

Canvas atual:
${canvasSnap}`;

    const response = await llmChat(cfg, system, input, { kind: "conductor" });

    // Parse do plano JSON — extrai JSON da resposta (pode vir em ```json``` ou cru)
    try {
      const jsonMatch = response.match(/```json?\s*([\s\S]*?)```/) ?? response.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;
      const plan = JSON.parse(jsonStr);
      if (plan.dispatches) {
        for (const d of plan.dispatches) {
          const result = await invoke<string>("orchestrator_dispatch_task", {
            targets: d.target,
            task: d.task,
            context: null,
            priority: d.priority ?? "blocking",
          });
          await invoke("orchestrator_log", {
            source: "conductor",
            target: d.target,
            payload: result,
            status: "done",
            stage: 0,
            parentId: null,
          });
        }
      }
    } catch {
      // Se não conseguiu parsear JSON, loga a resposta bruta
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: response,
        status: "done",
        stage: 0,
        parentId: null,
      });
    }
  } else {
    // Modo Agent (claude/codex/hermes) — despacha como user-message no ACP do Conductor
    // O Conductor é um AgentNode hidden que já está spawnado
    const conductorSid = useCanvasStore.getState().orchestratorSid;
    if (!conductorSid) {
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: "Nenhum Conductor definido. Use o seletor na barra pra escolher.",
        status: "error",
        stage: 0,
        parentId: null,
      });
      return;
    }

    // Injeta input como user-message no ACP do Conductor
    // O Conductor (Claude Code) vai raciocinar, chamar tools, despachar
    await invoke("acp_send_message", {
      id: conductorSid,
      message: input,
    });
  }
}

/** Carrega a config do Conductor (persistida em localStorage). */
export function loadConductorConfig(): ConductorConfig {
  try {
    const raw = localStorage.getItem("omnirift-conductor-config");
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { engine: "claude", model: null };
}

/** Salva a config do Conductor. */
export function saveConductorConfig(cfg: ConductorConfig): void {
  localStorage.setItem("omnirift-conductor-config", JSON.stringify(cfg));
}

/** Carrega o histórico da stream de orquestração. */
export async function loadOrchestratorStream(): Promise<OrchestratorEntry[]> {
  return invoke("orchestrator_stream_load");
}
