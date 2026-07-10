// lib/orchestration/conductor.ts
//
// Cliente do Conductor — a ponte entre a barra de input e os agentes no canvas.
// Resolve @nome localmente (via canvas-store), despacha direto via ptyWrite/acp.
// Só chama o Conductor LLM/Agent quando precisa interpretar (sem @, ou ambíguo).

import { invoke } from "@tauri-apps/api/core";
import { parseConstructorInput, type ParsedCommand } from "./parser";
import { useCanvasStore } from "@/store/canvas-store";
import { llmChat, loadLlmConfig } from "@/lib/llm-client";
import { analyzeCanvas } from "@/lib/companion";
import { ptyWrite } from "@/lib/pty-client";
import { acpPrompt } from "@/lib/acp-client";
import { ROLE_CLIS, buildCliSwitch } from "@/lib/agent-roles";
import { agentMcpConfig } from "@/lib/mcp-client";
import type { TerminalNode, AgentNode } from "@/types/canvas";

export type ConstructorEngine = "claude" | "codex" | "hermes" | "llm" | "shell";

export interface ConstructorConfig {
  engine: ConstructorEngine;
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
export async function dispatchConstructor(
  input: string,
  config: ConstructorConfig,
): Promise<void> {
  const parsed = parseConstructorInput(input);
  if (parsed.stages.length === 0) return;

  // Log do comando original
  await invoke("orchestrator_log", {
    source: "user",
    target: parsed.hasMentions ? parsed.stages.map((s) => s.mentions.map((m) => m.raw).join(" ")).join(", ") : "conductor",
    payload: input,
    status: "dispatched",
    stage: 0,
    parentId: null,
  });

  if (parsed.needsConductor && config.engine !== "shell") {
    await dispatchViaConductor(input, parsed, config.engine);
  } else {
    await dispatchDirect(parsed);
  }
}

/** Resolve @nome → TerminalNode/AgentNode no canvas-store. */
function resolveMention(mention: { kind: string; value: string }): Array<{ label: string; sessionId: string; kind: string }> {
  const s = useCanvasStore.getState();
  const activeFloor = s.parallels.find((p) => p.id === s.activeParallelId);
  if (!activeFloor) return [];

  const terminals = activeFloor.nodes.filter((n): n is TerminalNode => n.kind === "terminal");
  const agents = activeFloor.nodes.filter((n): n is AgentNode => n.kind === "agent");
  const all = [...terminals, ...agents];

  if (mention.kind === "all") {
    return all.map((n) => ({ label: n.label ?? n.id, sessionId: (n as TerminalNode).session_id ?? n.id, kind: n.kind }));
  }
  if (mention.kind === "idle") {
    return all
      .filter((n) => {
        const sid = (n as TerminalNode).session_id ?? n.id;
        const st = s.terminalStatuses[sid];
        return !st || st === "idle";
      })
      .map((n) => ({ label: n.label ?? n.id, sessionId: (n as TerminalNode).session_id ?? n.id, kind: n.kind }));
  }
  // @nome ou @role:x — match por label ou role (case-insensitive)
  const query = mention.value.toLowerCase();
  return all
    .filter((n) => {
      const label = (n.label ?? "").toLowerCase();
      const role = ((n as TerminalNode).role ?? "").toString().toLowerCase();
      if (mention.kind === "role") return role.includes(query);
      return label === query || label.includes(query) || (label.length > 0 && query.includes(label));
    })
    .map((n) => ({ label: n.label ?? n.id, sessionId: (n as TerminalNode).session_id ?? n.id, kind: n.kind }));
}

/** Despacho determinístico — @ explícito, resolve localmente e envia via PTY. */
async function dispatchDirect(parsed: ParsedCommand): Promise<void> {
  for (let i = 0; i < parsed.stages.length; i++) {
    const stage = parsed.stages[i];
    if (stage.mentions.length === 0) continue;

    const targets: Array<{ label: string; sessionId: string; kind: string }> = [];
    for (const m of stage.mentions) {
      targets.push(...resolveMention(m));
    }

    if (targets.length === 0) {
      const mentionStr = stage.mentions.map((m) => m.raw).join(" ");
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: `Nenhum agente casou '${mentionStr}'. Crie um agente no canvas e use o nome dele com @.`,
        status: "error",
        stage: i,
        parentId: null,
      });
      continue;
    }

    for (const target of targets) {
      const task = stage.payload || "";
      try {
        const st = useCanvasStore.getState().terminalStatuses[target.sessionId];
        const isBusy = st === "working" || st === "blocked";

        await ptyWrite(target.sessionId, task);
        await new Promise((r) => setTimeout(r, 150));
        await ptyWrite(target.sessionId, "\r");

        await invoke("orchestrator_log", {
          source: "conductor",
          target: target.label,
          payload: isBusy ? `${task}\n⏳ ${target.label} está ocupado — entrou na fila dele.` : task,
          status: "dispatched",
          stage: i,
          parentId: null,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await invoke("orchestrator_log", {
          source: "conductor",
          target: target.label,
          payload: `Erro: ${msg}`,
          status: "error",
          stage: i,
          parentId: null,
        });
      }
    }
  }
}

/** Encontra ou cria um agente Conductor do tipo especificado (claude/codex/hermes). */
async function findOrCreateConductor(engine: ConstructorEngine): Promise<string | null> {
  const s = useCanvasStore.getState();
  const activeFloor = s.parallels.find((p) => p.id === s.activeParallelId);
  if (!activeFloor) return null;

  const cliDef = ROLE_CLIS.find((c) => c.id === engine);
  if (!cliDef) return null;

  // Procura um terminal com este CLI no floor ativo
  const existing = activeFloor.nodes.find((n): n is TerminalNode => {
    if (n.kind !== "terminal") return false;
    return (n as TerminalNode).command === cliDef.command;
  });
  if (existing) {
    s.setOrchestratorSid(existing.session_id);
    return existing.session_id;
  }

  // Não existe — cria um novo agente Conductor
  const mcpPath = cliDef.role === "claude-code" ? await agentMcpConfig().catch(() => null) : null;
  const built = buildCliSwitch({ cli: cliDef, persona: await constructorContext(), mcpConfigPath: mcpPath, settingsPath: null });

  const id = `cond-${engine}-${Date.now().toString(36)}`;
  s.addTerminal({
    command: built.command,
    args: built.args,
    role: built.role,
    label: `Constructor (${cliDef.label})`,
    id,
  });

  // Espera o PTY estar pronto (3s de grace)
  await new Promise((r) => setTimeout(r, 3000));

  // Busca o sessionId do nó criado
  const node = useCanvasStore.getState().parallels
    .find((p) => p.id === s.activeParallelId)
    ?.nodes.find((n) => n.id === id) as TerminalNode | undefined;

  if (node?.session_id) {
    useCanvasStore.getState().setOrchestratorSid(node.session_id);
    // Envia a persona como primeira mensagem (se não for claude-code com flag)
    if (built.firstMessage) {
      await ptyWrite(node.session_id, built.firstMessage);
      await new Promise((r) => setTimeout(r, 200));
      await ptyWrite(node.session_id, "\r");
    }
    return node.session_id;
  }

  return null;
}

/** Engines que só existem como agente ACP (sem CLI de terminal) — o modo PTY do
 *  Conductor não consegue criá-los (não há entry no ROLE_CLIS). Roteados p/ ACP. */
const ACP_CONDUCTOR_ENGINES: ConstructorEngine[] = ["hermes"];

/** Persona do Conductor — compartilhada entre o modo PTY e o ACP. */
const CONDUCTOR_PERSONA =
  "Você é o Constructor — o copiloto do sistema OmniRift. Você CONVERSA com o usuário e tem acesso " +
  "total ao sistema. NÃO chute: use as tools pra ver o estado REAL antes de responder ou agir.\n\n" +
  "VOCÊ CONHECE O CANVAS: use orchestrator_status / orchestrator_query / agent_status pra ver os " +
  "agentes, terminais, estados (idle/working/blocked/done) e conexões AGORA.\n" +
  "VOCÊ CONHECE O CÓDIGO: use serena (símbolos/navegação), omnifs (busca semântica no código), " +
  "code_chunks (fatiar arquivo por AST) e context7 (docs de libs) pra entender o projeto.\n" +
  "VOCÊ COMANDA O ORQUESTRADOR: use orchestrator_dispatch (manda tarefa a um agente), " +
  "orchestrator_spawn_agent (cria agente), agent_ask/agent_tell (fala com um agente) e " +
  "orchestration_send (fan-out pra um grupo) pra colocar a frota pra trabalhar.\n\n" +
  "Responda direto e útil, em português. Quando for AGIR (não só responder), diga o que vai fazer e use a tool.";

/** Persona do Constructor + snapshot do canvas no momento (grounding inicial). As tools dão o
 *  estado FRESCO; o snapshot é só pra ele já começar situado sem gastar um turno consultando. */
async function constructorContext(): Promise<string> {
  let canvas = "";
  try {
    canvas = await analyzeCanvas();
  } catch {
    /* segue sem snapshot — ele consulta via orchestrator_status/query */
  }
  return canvas
    ? `${CONDUCTOR_PERSONA}\n\n--- Snapshot do canvas agora (use as tools p/ estado fresco) ---\n${canvas}`
    : CONDUCTOR_PERSONA;
}

/** Despacho via OmniAgent ACP (ex: hermes) — cria o agente se preciso e entrega a task.
 *  Diferente do modo PTY: não há terminal pra ptyWrite. A 1ª task vai embutida na persona
 *  (o AgentNode entrega no ready); as seguintes via acpPrompt na sessão ACP viva. */
async function dispatchViaAcpAgent(input: string, engine: ConstructorEngine): Promise<void> {
  const store = useCanvasStore.getState();
  const activeFloor = store.parallels.find((p) => p.id === store.activeParallelId);
  if (!activeFloor) return;
  const provider = engine as "hermes";

  // Reusa um Constructor ACP do mesmo provider já no floor (label "Constructor (…)").
  const existing = activeFloor.nodes.find(
    (n): n is AgentNode =>
      n.kind === "agent" && n.provider === provider && (n.label ?? "").startsWith("Constructor"),
  );

  if (existing?.acpSessionId) {
    // Sessão ACP viva → manda a task direto.
    await acpPrompt(existing.acpSessionId, input);
    await invoke("orchestrator_log", {
      source: "conductor", target: "user",
      payload: `Despachado pro agente ${engine}.`, status: "dispatched", stage: 0, parentId: null,
    });
    return;
  }

  if (existing) {
    // Criado mas ainda conectando (sem acpSessionId) — avisa p/ repetir em instantes.
    await invoke("orchestrator_log", {
      source: "conductor", target: "user",
      payload: `Agente ${engine} ainda conectando — repita a tarefa em instantes.`,
      status: "working", stage: 0, parentId: null,
    });
    return;
  }

  // Não existe → cria o OmniAgent ACP. A 1ª task vai na persona (entregue no ready).
  store.addAgent({
    provider,
    label: `Constructor (${engine})`,
    persona: `${await constructorContext()}\n\nPrimeira tarefa do usuário:\n${input}`,
    cwd: store.currentCwd ?? undefined,
  });
  await invoke("orchestrator_log", {
    source: "conductor", target: "user",
    payload: `Criando agente ${engine} (ACP) e despachando a tarefa…`,
    status: "dispatched", stage: 0, parentId: null,
  });
}

/** Despacho via Conductor LLM/Agent — precisa interpretar/decompor. */
async function dispatchViaConductor(
  input: string,
  _parsed: ParsedCommand,
  engine: ConstructorEngine,
): Promise<void> {
  if (engine === "llm") {
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

    try {
      const jsonMatch = response.match(/```json?\s*([\s\S]*?)```/) ?? response.match(/(\{[\s\S]*\})/);
      const jsonStr = jsonMatch ? jsonMatch[1] : response;
      const plan = JSON.parse(jsonStr);
      if (plan.dispatches) {
        for (const d of plan.dispatches) {
          const parsed = parseConstructorInput(d.target + " " + d.task);
          await dispatchDirect(parsed);
        }
      }
    } catch {
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: response.slice(0, 500),
        status: "done",
        stage: 0,
        parentId: null,
      });
    }
  } else if (ACP_CONDUCTOR_ENGINES.includes(engine)) {
    // Engine ACP-only (ex: hermes): não tem CLI de terminal, então o modo PTY abaixo
    // nunca cria (não há entry no ROLE_CLIS). Cria um OmniAgent ACP e entrega a task
    // via acpPrompt (não ptyWrite). Ver dispatchViaAcpAgent.
    await dispatchViaAcpAgent(input, engine);
  } else {
    // Modo Agent PTY (claude/codex) — encontra ou cria o Conductor terminal
    let conductorSid = useCanvasStore.getState().orchestratorSid;

    // Verifica se o conductorSid atual é do tipo certo
    if (conductorSid) {
      const activeFloor = useCanvasStore.getState().parallels.find((p) => p.id === useCanvasStore.getState().activeParallelId);
      const node = activeFloor?.nodes.find((n) => (n as TerminalNode).session_id === conductorSid) as TerminalNode | undefined;
      const cliDef = ROLE_CLIS.find((c) => c.id === engine);
      if (node && cliDef && node.command !== cliDef.command) {
        conductorSid = null; // tipo errado, precisa criar novo
      }
    }

    if (!conductorSid) {
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: `Procurando agente ${engine}…`,
        status: "working",
        stage: 0,
        parentId: null,
      });
      conductorSid = await findOrCreateConductor(engine);
    }

    if (!conductorSid) {
      await invoke("orchestrator_log", {
        source: "conductor",
        target: "user",
        payload: `Não consegui encontrar ou criar um agente ${engine}. Crie um terminal ${engine} no canvas e tente de novo.`,
        status: "error",
        stage: 0,
        parentId: null,
      });
      return;
    }

    // Agente ocupado: o PTY ENFILEIRA a mensagem (Claude Code mostra "press up to
    // edit queued messages") — sem este aviso o usuário vê "despachado" e nada acontece.
    const busyStatus = useCanvasStore.getState().terminalStatuses[conductorSid];
    const isBusy = busyStatus === "working" || busyStatus === "blocked";

    // Injeta input como user-message no PTY do Conductor
    await ptyWrite(conductorSid, input);
    await new Promise((r) => setTimeout(r, 150));
    await ptyWrite(conductorSid, "\r");

    await invoke("orchestrator_log", {
      source: "conductor",
      target: "user",
      payload: isBusy
        ? `Agente ${engine} está ocupado (${busyStatus}) — mensagem entrou na FILA dele e será processada quando o turno atual terminar.`
        : `Despachado pro agente ${engine}.`,
      status: "dispatched",
      stage: 0,
      parentId: null,
    });
  }
}

/** Carrega a config do Conductor (persistida em localStorage). */
export function loadConstructorConfig(): ConstructorConfig {
  try {
    const raw = localStorage.getItem("omnirift-conductor-config");
    if (raw) return JSON.parse(raw);
  } catch { /* ignore */ }
  return { engine: "claude", model: null };
}

/** Salva a config do Conductor. */
export function saveConstructorConfig(cfg: ConstructorConfig): void {
  localStorage.setItem("omnirift-conductor-config", JSON.stringify(cfg));
}

/** Carrega o histórico da stream de orquestração. */
export async function loadOrchestratorStream(): Promise<OrchestratorEntry[]> {
  return invoke("orchestrator_stream_load");
}
