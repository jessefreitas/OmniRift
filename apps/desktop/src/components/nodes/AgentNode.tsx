// src/components/nodes/AgentNode.tsx
//
// Nó de AGENTE ESTRUTURADO (ACP) no canvas — coexiste com o TerminalNode (PTY).
// F2 backend-owned sessions: a sessão ACP pertence ao AcpManager (Rust) e é keyada pelo
// id ESTÁVEL do nó (data.id) — o nó é uma VIEW DESCARTÁVEL que ANEXA (acp_attach
// re-hidrata msgs/badges/permission pendente) e só spawna se a sessão não existe.
// O unmount NÃO mata nada (só unlisten); o kill explícito vive no removeNode/fechar
// floor/projeto (canvas-store) e no reload/troca de provider (mesmo id reusado).
// Pós-restart do app, o `data.acpSessionId` persistido vira session/load (resume).
// Mesmo contrato do TerminalNode/PtyManager (useTerminalSession + pty_snapshot).

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Handle,
  NodeResizer,
  Position,
  useStore as useRfStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Brain, Maximize2, Minimize2, Repeat, RotateCw, ScrollText, Send, Target, UserRoundPlus, X } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { useCanvasStore } from "@/store/canvas-store";
import { kanbanList } from "@/lib/kanban-client";
import { buildRecitation } from "@/lib/recitation";
import { agentsMdInstruction, agentsMdRelPath, agentsMdSlug } from "@/lib/agent-contract";
import { NodeHelp } from "@/components/NodeHelp";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import { useFleetUsage } from "@/lib/fleet-usage";
import { useAgentMetrics } from "@/lib/agent-metrics";
import {
  acpSpawn,
  acpAttach,
  acpPrompt,
  acpPermissionRespond,
  acpCancel,
  acpAuthenticate,
  acpSetModel,
  acpSetConfigOption,
  acpAgentRegister,
  runCheck,
  listenAcpReady,
  listenAcpUpdate,
  listenAcpPermission,
  listenAcpTurnDone,
  listenAcpExit,
  listenAcpAuthRequired,
  listenAcpAuthFailed,
  listenAcpModelRejected,
  type AcpAuthMethod,
  type AcpAttachSnapshot,
} from "@/lib/acp-client";
import { scheduleReindex, omnifsIsManagedCwd, omnifsSnapshotNow } from "@/lib/omnifs-client";
import { getFlag, useFlag } from "@/lib/feature-flags";
import { scheduleGraphRebuild } from "@/lib/omnigraph-client";
import { communityForPath } from "@/lib/omnigraph-graph";
import { useAgentCheckpoints } from "@/lib/agent-checkpoints";
import { AgentCheckpointsMenu } from "@/components/AgentCheckpointsMenu";
import type { AgentNode as AgentNodeData } from "@/types/canvas";
import { HermesWizard, type HermesProviderConfig } from "./HermesWizard";
import { pasteText } from "@/lib/clipboard";

type AgentRfNode = Node<AgentNodeData & Record<string, unknown>, "agent">;
type AgentNodeProps = NodeProps<AgentRfNode>;

type Status = "starting" | "ready" | "thinking" | "dead" | "auth" | "config";
interface Msg {
  role: "user" | "assistant" | "tool" | "system";
  text: string;
  toolCallId?: string;
  toolKind?: string;
  status?: string;
}
interface Perm {
  reqId: unknown;
  options: { optionId: string; name: string }[];
}
interface Usage {
  model?: string;
  used?: number;
  size?: number;
  costUsd?: number;
}

function fmtTokens(n?: number): string {
  if (n == null) return "?";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Monta um patch unificado cru (sem lib) do old/new do ACP → renderiza no DiffLines.
 *  Cru de propósito (v1): old inteiro como `-`, new inteiro como `+`, capado a 200 linhas. */
function buildPatch(path: string | undefined, oldText: string, newText: string): string {
  const cap = (s: string) => s.split("\n").slice(0, 200);
  const p = path ?? "arquivo";
  const head = `--- a/${p}\n+++ b/${p}\n@@ @@`;
  const minus = oldText ? cap(oldText).map((l) => `-${l}`).join("\n") : "";
  const plus = newText ? cap(newText).map((l) => `+${l}`).join("\n") : "";
  return [head, minus, plus].filter(Boolean).join("\n");
}

// ── 🧹 Compactação sob demanda (context management — steal #2 do deepagents) ──────

/** Serializa a conversa visível em markdown (`## papel` + texto) — vira o histórico
 *  completo em `<cwd>/.omnirift/history/<slug>-<n>.md` antes do resumo substituir as msgs. */
function serializeConversation(label: string, msgs: Msg[]): string {
  const head = `# Histórico — ${label}\n\n> Compactado em ${new Date().toISOString()}\n`;
  const body = msgs
    .map((m) =>
      m.role === "tool"
        ? `## tool\n\n[${m.toolKind ?? "tool"}] ${m.text}${m.status ? ` · ${m.status}` : ""}`
        : `## ${m.role}\n\n${m.text}`,
    )
    .join("\n\n");
  return `${head}\n${body}\n`;
}

/** Próximo índice livre `<slug>-<n>.md` em `histDir` (lista via list_dir; dir ausente → 1). */
async function nextHistoryIndex(histDir: string, slug: string): Promise<number> {
  try {
    const entries = await invoke<{ name: string }[]>("list_dir", { path: histDir });
    const re = new RegExp(`^${slug}-(\\d+)\\.md$`); // slug é [a-z0-9-] — seguro em regex
    let n = 1;
    for (const e of entries) {
      const m = re.exec(e.name);
      if (m) n = Math.max(n, Number(m[1]) + 1);
    }
    return n;
  } catch {
    return 1; // dir ainda não existe → 1º arquivo
  }
}

/** Grava o histórico via write_file; se falhar (write_file NÃO cria dir pai), cria
 *  `.omnirift/history` pelo shell do run_check (sh -c / cmd /C) e tenta de novo. */
async function writeHistoryFile(cwd: string, path: string, content: string): Promise<void> {
  try {
    await invoke("write_file", { path, content });
  } catch {
    const win = cwd.includes("\\");
    await runCheck(cwd, win ? "mkdir .omnirift\\history" : "mkdir -p .omnirift/history");
    await invoke("write_file", { path, content });
  }
}

// Contrato injetado (invisível) no 1º prompt → faz o OmniAgent agir como orquestrador,
// usando as tools MCP do OmniRift (injetadas no session/new pelo backend).
const ORCHESTRATOR_PROMPT = `Você é o ORQUESTRADOR do OmniRift: você COORDENA agentes em vez de executar tudo sozinho. Você tem ferramentas MCP do OmniRift disponíveis: terminal_list (ver os agentes ativos), terminal_spawn_on_floor (criar um agente num worktree git isolado), terminal_run e terminal_send_text (comandar um agente), terminal_wait_status (esperar um agente concluir), memory_remember e memory_recall (blackboard compartilhado), claim_acquire e claim_release (evitar conflito de edição). Ao receber uma tarefa: decomponha em subtarefas, delegue a agentes (listando os existentes ou criando novos), acompanhe a conclusão e sintetize o resultado. Prefira DELEGAR a executar você mesmo.`;

function AgentNodeImpl({ data, selected }: AgentNodeProps) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const patchNode = useCanvasStore((s) => s.patchNode);
  const emitAgentOutput = useCanvasStore((s) => s.emitAgentOutput);
  const nodeInput = useCanvasStore((s) => s.nodeInputs[data.id]);
  const teamBriefing = useCanvasStore((s) => s.teamBriefing);
  const openConnectMenu = useCanvasStore((s) => s.openConnectMenu);
  // Subagentes plugados NESTE agente (derivado do canvas: subagent-nodes com parentAgentId =
  // este id). String → compara por valor (sem re-render infinito de selector que devolve array).
  const mySubagentLabels = useCanvasStore((s) => {
    const f = s.parallels.find((p) => p.id === s.activeParallelId);
    return (f?.nodes ?? [])
      .filter((n) => n.kind === "subagent" && n.parentAgentId === data.id)
      .map((n) => (n.kind === "subagent" ? n.label : ""))
      .join(", ");
  });
  // Fase 3 — nome do floor/time deste agente: vira o `scope` do blackboard (mural só do time).
  // Com 1 floor o scope é igual pra todos (= global); com vários, isola o mural por time.
  const myFloorName = useCanvasStore((s) => s.parallels.find((p) => p.nodes.some((n) => n.id === data.id))?.name ?? "");
  const t = useT();

  // Abre o menu de SUBAGENTE (só roles) posicionado abaixo deste agente. O subagente
  // nasce como nó-filho privado e materializa um .claude/agents/<role>.md na pasta do pai.
  function addSubagentHere(e: React.MouseEvent) {
    e.stopPropagation();
    openConnectMenu({
      fromNodeId: data.id,
      flow: { x: (data.position?.x ?? 0) + 24, y: (data.position?.y ?? 0) + (data.size?.height ?? 480) + 48 },
      screen: { x: e.clientX, y: e.clientY },
      mode: "subagent",
    });
  }

  const [status, setStatus] = useState<Status>("starting");
  const [model, setModel] = useState<string | null>(null);
  const [availableModels, setAvailableModels] = useState<{ modelId: string; name?: string }[]>([]);
  const [usage, setUsage] = useState<Usage>({});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [perm, setPerm] = useState<Perm | null>(null);
  const [authMethods, setAuthMethods] = useState<AcpAuthMethod[]>([]);
  const [input, setInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [reloadKey, setReloadKey] = useState(0); // bumpar → re-spawna a sessão ACP (carrega .claude/agents novos)

  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastReplyRef = useRef(""); // acumula a resposta do turno → vira "saída" no turn-done
  // Insights (latência/erro por turno): t0 do turno em voo (null = ocioso). Ref, não state
  // — o turn-done/exit lê o valor ATUAL sem stale state (mesmo padrão de goalRef/compactRef).
  // Marcado onde o prompt sai (setStatus("thinking")); consumido em finishTurn no fim do turno.
  const turnStartRef = useRef<number | null>(null);
  // 📸 Contador de turnos concluídos deste nó — vira o "turno N" na mensagem do checkpoint
  // OmniFS. Ref (não state): não re-renderiza e sobrevive ao reload/troca-de-provider (que só
  // bumpam reloadKey, sem desmontar) → o nº do snapshot fica monotônico com o histórico do drive.
  const turnCounterRef = useRef(0);
  // 📿 Recitação (Manus): turnos concluídos desde a última reinjeção de foco. Ao passar de
  // RECITE_EVERY_TURNS, o PRÓXIMO prompt leva o bloco de FOCO de carona (sem gastar um turno
  // à toa). Agentes em 🎯 Goal já recitam a cada iteração → o contador só serve aos demais.
  const RECITE_EVERY_TURNS = 6;
  const turnsSinceReciteRef = useRef(0);
  const firstSentRef = useRef(false); // prefixa o contrato de orquestrador só no 1º prompt
  const teamRef = useRef<string | null>(null); // roster pendente p/ injetar no próximo prompt
  const subagentsSentRef = useRef(false); // a lista de subagentes já foi injetada num prompt?
  const acpSessionIdRef = useRef<string | null>(null); // sessionId do ADAPTER (p/ session/load)
  const resumeRef = useRef<string | null>(null); // pendente: resumir esta sessão no próximo spawn
  const spawnedResumeRef = useRef(false); // o spawn atual usou resume? (pra fallback se o resume morrer 129)
  // Config BYOK do Hermes escolhida no wizard (com a key) — em memória só (a key NUNCA vai pro
  // store/disco). data.providerConfig persiste só {provider,model}; a key mora no keychain do SO.
  const hermesCfgRef = useRef<HermesProviderConfig | null>(null);
  // Claude expõe o modelo como configOption (não `models`). Quando é o caso, guardamos o configId
  // ("model") aqui → o dropdown troca via session/set_config_option em vez de session/set_model.
  const modelConfigIdRef = useRef<string | null>(null);
  const personaSentRef = useRef(false); // persona injetada 1x quando ready (não re-injeta no reload)
  // Último modelo CONFIRMADO pelo adapter (ready) — se o set_model for recusado, o badge volta
  // pra cá em vez de mentir o modelo pedido (Task #6: Hermes preso no default ministral).
  const confirmedModelRef = useRef<string | null>(null);
  // 🧹 compactação em curso: path do histórico já gravado (null = nenhuma). Ref, não state —
  // o closure do turn-done lê o valor ATUAL sem stale state (padrão goalRef/personaSentRef).
  const compactRef = useRef<string | null>(null);
  // 🎯 Goal (loop autônomo por-agente) + 🔁 Loop (timer). Os refs guardam o run ATIVO (estáveis
  // no closure do turn-done, sem stale state); goalRun alimenta o badge no header.
  const goalRef = useRef<{ objective: string; condition: string; maxIter: number } | null>(null);
  const goalStatusRef = useRef<"running" | "done" | "stopped" | "fail" | null>(null);
  const goalIterRef = useRef(0);
  // Saída da condição na iteração anterior — se repetir idêntica, o agente está preso num
  // raciocínio circular (aplicou o mesmo fix que não muda nada) → aborta (detecção de estagnação).
  const goalLastOutRef = useRef<string | null>(null);
  const statusRef = useRef<Status>("starting");
  const [goalRun, setGoalRun] = useState<{ iter: number; status: "running" | "done" | "stopped" | "fail" } | null>(null);
  const [panel, setPanel] = useState<"none" | "goal" | "loop">("none");
  const reciteFlag = useFlag("recitation"); // 📿 gate global da recitação (reativo p/ o botão)
  // LOD por zoom: abaixo de 35% a conversa é ilegível — o corpo vira label grande (ver render).
  // Selector booleano → re-render só ao cruzar o limiar.
  const lodOut = useRfStore((s) => s.transform[2] < 0.35);
  // Espelha o status num ref (o timer do 🔁 Loop e o turn-done do 🎯 Goal leem sem stale state).
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // Persona: quando fica ready pela 1ª vez, injeta o papel como prompt de priming. Trocar o modelo
  // depois NÃO re-spawna → a persona (já na conversa) permanece. "Sai do Sonnet, vai pro Kimi,
  // continua Arquiteto." (No reload/resume, personaSentRef já é true e não re-injeta.)
  // Steal #1 do deepagents — a persona APRENDE: antes de enviar, lê o AGENTS.md do papel
  // (<cwd>/.omnirift/agents-md/<slug>.md, mantido pelo PRÓPRIO agente) e anexa ao priming;
  // a instrução de manutenção (criar on-demand + guidelines) vai junto sempre.
  useEffect(() => {
    if (status === "ready" && data.persona && !personaSentRef.current) {
      personaSentRef.current = true;
      const persona = data.persona;
      const label = data.label ?? "OmniAgent";
      void (async () => {
        let memory = "";
        const cwd = data.cwd || useCanvasStore.getState().currentCwd || "";
        if (cwd) {
          try {
            const raw = await invoke<string>("read_file", { path: `${cwd}/${agentsMdRelPath(label)}` });
            // Cap defensivo: a memória não pode engolir o priming (o agente é instruído a mantê-la curta).
            memory = raw.trim().slice(0, 8000);
          } catch {
            // arquivo ainda não existe — o agente o cria on-demand (instrução abaixo)
          }
        }
        const parts = [
          `A partir de agora você atua com este papel/persona (mantenha-o independente do modelo):\n\n${persona}`,
          agentsMdInstruction(label),
        ];
        if (memory) parts.push(`MEMÓRIA PERSISTENTE DESTE PAPEL (AGENTS.md — você mantém):\n${memory}`);
        await sendText(
          parts.join("\n\n"),
          `🎭 ${t("agent.personaSet", "persona definida")}: ${persona.slice(0, 48)}${memory ? ` ${t("agent.personaMemory", "(+ memória do papel)")}` : ""}`,
        );
      })();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, data.persona]);

  // 🔁 Loop: re-manda o prompt a cada N min (só se ready e ocioso). Reusa acpPrompt. Persistido
  // em data.loop; ligar/desligar via o painel Loop. Não dispara no meio de um turno (thinking).
  useEffect(() => {
    const lp = data.loop;
    if (!lp?.active || !lp.prompt.trim()) return;
    const ms = Math.max(1, lp.everyMin) * 60_000;
    const timer = window.setInterval(() => {
      if (statusRef.current === "ready" && sessionRef.current) {
        turnStartRef.current = performance.now(); // Insights: t0 do turno disparado pelo loop
        void acpPrompt(sessionRef.current, lp.prompt);
        setMsgs((m) => [...m, { role: "system", text: `🔁 loop — disparando (a cada ${lp.everyMin} min)` }]);
      }
    }, ms);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loop?.active, data.loop?.everyMin, data.loop?.prompt]);
  const lastDiffRef = useRef<{ diff: string; path?: string } | null>(null); // diff do turno (Fase 2a)

  // FleetBar (#12): nó removido do canvas → sai da soma de tokens do lote.
  useEffect(() => () => useFleetUsage.getState().clearTokens(data.id), [data.id]);

  // Insights: métricas de turno (latência/erro) do nó saem quando ele é REMOVIDO.
  // Floor inativo fica display:none (não desmonta — sessão não vive no mount) → unmount
  // ≈ remoção real. Espelha o clearTokens acima; o CAP do store já limita a memória viva.
  useEffect(() => () => useAgentMetrics.getState().clearNode(data.id), [data.id]);

  // 📸 Checkpoints do drive (OmniFS): idem — saem quando o nó é REMOVIDO de vez (unmount ≈
  // remoção real; floor inativo é display:none, não desmonta). NÃO limpamos no reload/troca
  // de provider: os commits do drive sobrevivem à conversa (são pontos de restauração válidos
  // mesmo com contexto novo) — só a remoção do nó zera o histórico local.
  useEffect(() => () => useAgentCheckpoints.getState().clearNode(data.id), [data.id]);

  // Fecha o turno em voo: mede a duração (t0 marcado no envio) e registra {durationMs, ok}.
  // No-op se não há turno aberto (turnStartRef null) — seguro chamar em qualquer fim (done/dead/erro).
  // `ok=false` = turno morreu/lançou; `ok=true` = turn-done normal. Inclui espera por permissão
  // na latência (v1 — é a latência ponta-a-ponta do turno, não só a geração).
  const finishTurn = (ok: boolean) => {
    const t0 = turnStartRef.current;
    if (t0 === null) return;
    turnStartRef.current = null;
    useAgentMetrics.getState().recordTurn(data.id, {
      durationMs: Math.max(0, Math.round(performance.now() - t0)),
      ok,
      at: Date.now(),
    });
  };

  // D2-v2 — reload re-spawna a sessão ACP pra carregar os `.claude/agents` plugados DEPOIS do
  // boot (o adapter não faz hot-reload). Se já temos o sessionId do adapter, faz `session/load`
  // → MANTÉM a conversa; senão `session/new` (perde). Avisa via system line.
  function reloadSession() {
    const resume = acpSessionIdRef.current;
    resumeRef.current = resume;
    if (resume) {
      setMsgs((m) => [...m, { role: "system", text: t("agent.reloadingKeep", "↻ Recarregando subagentes (mantendo a conversa)…") }]);
    } else {
      setMsgs([{ role: "system", text: t("agent.reloaded", "↻ Sessão recarregada — subagentes atualizados.") }]);
      setModel(null);
      setUsage({});
      useFleetUsage.getState().clearTokens(data.id); // sessão nova = contagem zera (FleetBar)
      useAgentMetrics.getState().clearNode(data.id); // Insights: latência/erro zeram com a sessão
      turnStartRef.current = null;
      // Sessão NOVA (sem resume) = conversa perdida → re-injeta a persona no próximo ready
      // (senão o reload apagava o papel do agente junto com a conversa).
      personaSentRef.current = false;
    }
    setStatus("starting");
    setPerm(null);
    setAuthMethods([]);
    firstSentRef.current = false;
    teamRef.current = null;
    subagentsSentRef.current = false;
    // F2 (id estável + unmount não mata): o kill EXPLÍCITO aqui é o que impede a próxima
    // montagem de re-anexar à sessão velha (attach falha → spawn, com resume se houver).
    // Kill intencional não emite acp://exit (flag `killed` no backend) — sem stale-exit.
    void (async () => {
      try { await acpCancel(data.id); } catch { /* já morta */ }
      setReloadKey((k) => k + 1);
    })();
  }

  // Troca o modelo do agente (ACP session/set_model). Útil pra rodar um agente barato
  // (ex: validador) num modelo leve, e o autor num modelo forte.
  function changeModel(modelId: string) {
    const sid = sessionRef.current; // id do FRONT (chave do AcpManager), não o sessionId ACP
    if (!sid || !modelId || modelId === model) return;
    setModel(modelId);
    setUsage((u) => ({ ...u, model: modelId }));
    // Claude: modelo é configOption → set_config_option; Hermes/Zed: models → set_model.
    if (modelConfigIdRef.current) void acpSetConfigOption(sid, modelConfigIdRef.current, modelId);
    else void acpSetModel(sid, modelId);
    setMsgs((m) => [...m, { role: "system", text: `⚙️ ${t("agent.modelChanged", "modelo")} → ${availableModels.find((x) => x.modelId === modelId)?.name ?? modelId}` }]);
  }

  // Persona ≠ engine parte 2: troca o PROVIDER (adapter ACP) mantendo a persona. Adapters não
  // compartilham sessão (session/load é por-adapter) → força session/new e RE-INJETA a persona
  // no novo ready (personaSentRef=false). A conversa anterior se perde — mesmo custo do reload
  // sem resume. É o escape-hatch de contexto: "Sonnet cheio → Kimi 1M, continua Arquiteto."
  function changeProvider(next: "claude" | "codex" | "hermes") {
    if (next === (data.provider ?? "claude")) return;
    // F2: limpa também o acpSessionId PERSISTIDO — session/load é por-adapter; deixar o id
    // velho faria o próximo spawn tentar resumir uma sessão de OUTRO motor.
    patchNode(data.id, { provider: next, acpSessionId: undefined });
    acpSessionIdRef.current = null;
    resumeRef.current = null;
    spawnedResumeRef.current = false;
    personaSentRef.current = false;
    modelConfigIdRef.current = null;
    firstSentRef.current = false;
    teamRef.current = null;
    subagentsSentRef.current = false;
    setModel(null);
    setAvailableModels([]);
    setUsage({});
    useFleetUsage.getState().clearTokens(data.id); // motor novo = sessão nova → contagem zera (FleetBar)
    useAgentMetrics.getState().clearNode(data.id); // Insights: motor novo → latência/erro zeram
    turnStartRef.current = null;
    setPerm(null);
    setAuthMethods([]);
    setMsgs((m) => [
      ...m,
      { role: "system", text: `⇄ ${t("agent.providerChanged", "trocando o motor")} → ${next}${data.persona ? ` — ${t("agent.personaKept", "mantendo a persona (nova conversa)")}` : ""}` },
    ]);
    setStatus("starting");
    // F2: mata a sessão do motor antigo ANTES do re-mount (senão o attach re-anexaria a ela).
    void (async () => {
      try { await acpCancel(data.id); } catch { /* já morta */ }
      setReloadKey((k) => k + 1);
    })();
  }

  // Autoscroll pro fim a cada novo conteúdo.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, perm, status]);

  // Subagente plugado/desplugado: o agente fica CIENTE (lista vai no próximo prompt), mas
  // pra INVOCAR precisa recarregar (Claude Code lê .claude/agents no boot). Avisa via ↻.
  useEffect(() => {
    subagentsSentRef.current = false; // reinjeta a lista atualizada no próximo prompt
    if (mySubagentLabels && (status === "ready" || status === "thinking")) {
      setMsgs((m) => [...m, { role: "system", text: `🔌 ${t("agent.subagentPlugged", "Subagentes plugados: {list}. Clique ↻ pra carregar e invocá-los (Task tool).").replace("{list}", mySubagentLabels)}` }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mySubagentLabels]);

  // F2 backend-owned: ATTACH-primeiro + listeners no mount; cleanup SÓ desliga listeners.
  // A sessão é keyada pelo id ESTÁVEL do nó (data.id): re-mount/troca de floor RE-ANEXA
  // (acp_attach re-hidrata) em vez de re-spawnar. Kill explícito: removeNode / fechar
  // floor/projeto (canvas-store) / reload / troca de provider (que matam ANTES do bump).
  useEffect(() => {
    const id = data.id;
    sessionRef.current = id;
    const cmdLabel = data.label ?? "OmniAgent"; // label sob o qual o Orquestrador o comanda
    let unsubs: UnlistenFn[] = [];
    let alive = true;
    // Corrida attach × eventos ao vivo (padrão replayFromSnapshot do PTY): enquanto o
    // snapshot está em voo, evento ao vivo vai pro buffer; depois drena dedupado por seq
    // (evento com seq ≤ lastSeq do snapshot já veio DENTRO do snapshot → dropa).
    let attaching = true;
    let lastSeq = 0;
    const pending: Array<{ seq?: number; fn: () => void }> = [];
    const gated = (seq: number | undefined, fn: () => void) => {
      if (attaching) {
        pending.push({ seq, fn });
        return;
      }
      if (seq !== undefined) {
        if (seq <= lastSeq) return;
        lastSeq = seq;
      }
      fn();
    };

    // Hermes BYOK: sem provider+modelo escolhidos ainda → abre o wizard em vez de spawnar cego.
    // hermesCfgRef (com a key, em memória) tem precedência; senão data.providerConfig (persistido,
    // key vazia → o backend resolve do keychain no spawn). Outros providers: sempre null (spawn direto).
    const hermesCfg: HermesProviderConfig | null =
      data.provider === "hermes"
        ? hermesCfgRef.current ?? (data.providerConfig ? { ...data.providerConfig, key: "" } : null)
        : null;
    if (data.provider === "hermes" && !hermesCfg) {
      setStatus("config");
      return () => {
        alive = false;
      };
    }

    const pushSys = (text: string) => setMsgs((m) => [...m, { role: "system", text }]);

    const applyUpdate = (up: Record<string, unknown>) => {
      const kind = up.sessionUpdate as string | undefined;
      if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
        const text = ((up.content as { text?: string } | undefined)?.text) ?? "";
        if (!text) return;
        lastReplyRef.current += text;
        setMsgs((m) => {
          const last = m[m.length - 1];
          if (last && last.role === "assistant") {
            return [...m.slice(0, -1), { ...last, text: last.text + text }];
          }
          // Cap do histórico visível: sessões longas acumulavam milhares de bolhas no DOM
          // (peso de render por nó). Mantém as últimas 400 quando passa de 600.
          const next = [...m, { role: "assistant" as const, text }];
          return next.length > 600 ? next.slice(-400) : next;
        });
      } else if (kind === "tool_call" || kind === "tool_call_update") {
        const tcId = up.toolCallId as string | undefined;
        const title = up.title as string | undefined;
        const tk = up.kind as string | undefined;
        const st = up.status as string | undefined;
        // Fase 2a — captura o DIFF do tool_call (content[].type === "diff") pra virar payload
        // estruturado na linha. ACP dá {path, oldText, newText} (ou um patch pronto).
        const content = up.content as Array<Record<string, unknown>> | undefined;
        if (Array.isArray(content)) {
          const d = content.find((c) => c?.type === "diff") as
            | { path?: string; oldText?: string; newText?: string; diff?: string }
            | undefined;
          if (d) {
            const patch = d.diff ?? buildPatch(d.path, d.oldText ?? "", d.newText ?? "");
            lastDiffRef.current = { diff: patch, path: d.path };
          }
        }
        setMsgs((m) => {
          const idx = tcId ? m.findIndex((x) => x.role === "tool" && x.toolCallId === tcId) : -1;
          if (idx >= 0) {
            const cp = [...m];
            const prev = cp[idx];
            cp[idx] = {
              ...prev,
              text: title ?? prev.text,
              toolKind: tk ?? prev.toolKind,
              status: st ?? prev.status,
            };
            return cp;
          }
          return [
            ...m,
            { role: "tool", toolCallId: tcId, text: title ?? tcId ?? "tool", toolKind: tk ?? "tool", status: st ?? "pending" },
          ];
        });
      } else if (kind === "usage_update") {
        const used = up.used as number | undefined;
        const size = up.size as number | undefined;
        const cost = (up.cost as { amount?: number } | undefined)?.amount;
        setUsage((u) => ({
          ...u,
          used: used ?? u.used,
          size: size ?? u.size,
          costUsd: cost ?? u.costUsd,
        }));
        // FleetBar (#12): publica os tokens usados no registro compartilhado (soma do lote).
        if (used != null) useFleetUsage.getState().reportTokens(data.id, used);
      }
    };

    // session/new|load respondeu — OU lastReady do attach (a re-hidratação F2 passa pelo
    // MESMO caminho): modelos/badges, sessionId do adapter e registro de comando.
    const handleReady = (info: Record<string, unknown>) => {
      const models = info.models as
        | { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string }
        | undefined;
      let avail = models?.availableModels ?? [];
      let cur = models?.currentModelId ?? avail[0]?.modelId ?? null;
      // Claude não usa `models`: expõe o modelo como um configOption (id="model"). Se `models`
      // veio vazio, procura o configOption de modelo → vira o dropdown (troca via set_config_option).
      if (avail.length === 0) {
        const cfgOpts = (info.configOptions as
          | { id?: string; category?: string; currentValue?: string; options?: { value: string; name?: string }[] }[]
          | undefined) ?? [];
        const modelOpt = cfgOpts.find((o) => o.id === "model" || o.category === "model");
        if (modelOpt?.options?.length) {
          modelConfigIdRef.current = modelOpt.id ?? "model";
          avail = modelOpt.options.map((o) => ({ modelId: o.value, name: o.name ?? o.value }));
          cur = modelOpt.currentValue ?? avail[0]?.modelId ?? null;
        }
      }
      if (avail.length) setAvailableModels(avail);
      confirmedModelRef.current = cur; // verdade do adapter, ANTES do otimismo abaixo
      // BYOK Hermes: o HERMES_INFERENCE_MODEL não pega no ACP (inicia no default do provider) →
      // aplica o modelo escolhido no wizard via session/set_model, com o formato `provider/model`
      // (com BARRA — com `:` o Hermes misrouteia "kimi" pro provider kimi-coding). hermesCfgRef
      // (sessão atual, tem a escolha) ou data.providerConfig (persistido) trazem o modelo.
      const wantModel = hermesCfgRef.current?.model ?? data.providerConfig?.model;
      const wantProvider = hermesCfgRef.current?.provider ?? data.providerConfig?.provider ?? data.provider;
      if (data.provider === "hermes" && wantModel) {
        const fullId = wantModel.includes("/") ? wantModel : `${wantProvider}/${wantModel}`;
        if (fullId !== cur) void acpSetModel(id, fullId);
        cur = fullId;
        // reflete no dropdown (o availableModels curado do Hermes pode não conter este modelo)
        setAvailableModels((prev) =>
          prev.some((m) => m.modelId === fullId) ? prev : [{ modelId: fullId, name: wantModel }, ...prev],
        );
      } else if (wantModel && modelConfigIdRef.current) {
        // Claude: o modelo sugerido pelo plano (Montar) vem como "haiku|sonnet|opus" — casa com
        // o configOption real por substring e aplica via set_config_option (mesmo cano do dropdown).
        const want = wantModel.toLowerCase();
        const hit = avail.find(
          (m) => m.modelId.toLowerCase().includes(want) || (m.name ?? "").toLowerCase().includes(want),
        );
        if (hit && hit.modelId !== cur) {
          void acpSetConfigOption(id, modelConfigIdRef.current, hit.modelId);
          cur = hit.modelId;
        }
      }
      if (cur) setModel(cur);
      if (cur) setUsage((u) => ({ ...u, model: cur }));
      // Guarda + PERSISTE o sessionId do ADAPTER (session/new traz; session/load não →
      // mantém o anterior). É a chave do resume: reload na mesma execução (ref) e
      // pós-restart do app (acpSessionId no workspace → session/load).
      const sessId = (info as { sessionId?: string }).sessionId;
      if (sessId) {
        acpSessionIdRef.current = sessId;
        patchNode(data.id, { acpSessionId: sessId });
      }
      spawnedResumeRef.current = false; // ficou ready → uma morte futura é morte real, não resume-fail
      setStatus("ready");
      // Torna-se COMANDÁVEL pelo Orquestrador-terminal (entra no terminal_list).
      // Idempotente: o re-attach re-registra o mesmo par label→id.
      void acpAgentRegister(cmdLabel, id);
    };

    // F2: re-hidrata a view a partir do snapshot do backend (a sessão sobreviveu ao
    // unmount / troca de floor / virtualização) — espelho do replayFromSnapshot do PTY.
    const rehydrate = (snap: AcpAttachSnapshot) => {
      acpSessionIdRef.current = snap.acpSessionId ?? null;
      if (snap.acpSessionId && snap.acpSessionId !== data.acpSessionId) {
        patchNode(data.id, { acpSessionId: snap.acpSessionId });
      }
      if (snap.truncated) {
        pushSys(t("agent.historyTruncated", "… histórico truncado — a conversa completa segue viva no agente"));
      }
      if (snap.state === "dead") setStatus("dead");
      else if (snap.lastReady) handleReady(snap.lastReady as Record<string, unknown>);
      else setStatus("starting");
      // Replay do log coalescido → bolhas/tool-calls/usage (o MESMO applyUpdate do ao-vivo).
      for (const ev of snap.events) {
        if (ev.event === "update") applyUpdate(ev.payload as Record<string, unknown>);
      }
      // Permission pendente sobreviveu no backend → re-exibe (o turno segue em voo no
      // adapter até a resposta; por isso o status volta pra thinking).
      if (snap.pendingPermission) {
        const pp = snap.pendingPermission.params as { options?: Perm["options"] } | undefined;
        setPerm({ reqId: snap.pendingPermission.reqId, options: pp?.options ?? [] });
        if (snap.state === "running") setStatus("thinking");
      }
      // Conversa já em andamento → contrato de orquestrador + persona NÃO re-injetam.
      if (snap.events.some((e) => e.event === "update" || e.event === "turn-done")) {
        firstSentRef.current = true;
        personaSentRef.current = true;
      }
      lastSeq = snap.lastSeq;
    };

    (async () => {
      unsubs = await Promise.all([
        listenAcpReady(id, (info, seq) => gated(seq, () => handleReady(info))),
        listenAcpUpdate(id, (up, seq) => gated(seq, () => applyUpdate(up))),
        listenAcpPermission(id, (reqId, params, seq) =>
          gated(seq, () => setPerm({ reqId, options: (params.options as Perm["options"]) ?? [] })),
        ),
        listenAcpTurnDone(id, (_d, seq) => gated(seq, async () => {
          setStatus("ready");
          // Insights: turno concluiu sem erro → registra latência (t0..agora) + ok. Vem ANTES
          // da re-iteração do Goal (que abre um turno novo com t0 novo mais abaixo).
          finishTurn(true);
          turnCounterRef.current += 1; // 📸 nº do turno concluído (rótulo do checkpoint OmniFS)
          turnsSinceReciteRef.current += 1; // 📿 recitação: +1 turno desde a última reinjeção de foco
          // F3 item 2: agente terminou um turno → se o cwd é mount OmniFS vivo, agenda
          // re-index debounced (~60s) do drive. Fire-and-forget + gate no backend: busca
          // fresca sem o agente gastar um turno rodando omnifs_index.
          const turnCwd = data.cwd || useCanvasStore.getState().currentCwd || "";
          scheduleReindex(turnCwd);
          // F4a: mesmo turn-done → agenda o rebuild debounced (~90s) do grafo de código.
          // Gêmeo estrutural do reindex temporal; gate barato + no-op no backend se não há grafo.
          scheduleGraphRebuild(turnCwd);
          const reply = lastReplyRef.current.trim();
          // 🧹 turno de COMPACTAÇÃO: a resposta É o resumo → substitui a conversa por
          // [system marcador + assistant resumo]. Turno interno de manutenção: não emite
          // saída na linha nem roda o Goal.
          const compactPath = compactRef.current;
          if (compactPath) {
            compactRef.current = null;
            lastDiffRef.current = null;
            setMsgs([
              { role: "system", text: `🧹 ${t("agent.compacted", "conversa compactada — histórico completo em")} ${compactPath}` },
              { role: "assistant", text: reply || "(sem resumo)" },
            ]);
            return;
          }
          const diff = lastDiffRef.current;
          lastDiffRef.current = null;
          // 📸 CHECKPOINT POR TURNO (feature-assinatura): se este turno EDITOU o drive (diff) E
          // o cwd é um mount OmniFS VIVO, tira um snapshot do drive e registra pro menu de
          // rollback do nó. Gate duplo (managed + edited): snapshot sem edição é lixo. Roda numa
          // IIFE async best-effort — o omnifsIsManagedCwd é async e NÃO pode travar o turn-done
          // (Goal/reindex seguem); qualquer falha só é engolida (nunca quebra o turno).
          if (diff && getFlag("omnifs-auto-checkpoint")) {
            const cpLabel = data.label ?? "OmniAgent";
            const cpTurn = turnCounterRef.current;
            const cpCwd = turnCwd;
            void (async () => {
              try {
                if (!cpCwd || !(await omnifsIsManagedCwd(cpCwd))) return;
                const cpMessage = `🤖 ${cpLabel} · turno ${cpTurn}`;
                const commit = await omnifsSnapshotNow(cpMessage);
                if (commit) {
                  useAgentCheckpoints.getState().recordCheckpoint(data.id, {
                    commit,
                    message: cpMessage,
                    at: Date.now(),
                    turn: cpTurn,
                    ok: true,
                  });
                }
              } catch {
                /* checkpoint é best-effort — nunca trava/quebra o turno */
              }
            })();
          }
          if (diff) {
            // Fase 2a: um diff produzido no turno vira payload "diff" na linha (não só texto).
            emitAgentOutput(data.id, reply || `diff em ${diff.path ?? "arquivo"}`, { kind: "diff", diff: diff.diff, path: diff.path });
          } else if (reply) {
            emitAgentOutput(data.id, reply);
          }
          // GRAFO INTEGRADO (#30): o turno editou um arquivo → LIGA o agente à COMUNIDADE dona
          // desse arquivo (edge "works-on", idempotente via addEdge) e ACENDE a comunidade (~4s).
          // Resolve o floor DO AGENTE (não só o ativo) — o agente pode viver num floor de fundo.
          // Degrada byte-idêntico: sem CommunityNodes no floor (ou path sem dona), no-op.
          if (diff?.path) {
            const st = useCanvasStore.getState();
            const myFloor = st.parallels.find((p) => p.nodes.some((n) => n.id === data.id));
            if (myFloor) {
              const community = communityForPath(myFloor.nodes, diff.path);
              if (community) {
                st.addEdge(data.id, community.id, "works-on", { targetFloorId: myFloor.id });
                st.igniteCommunity(community.id);
              }
            }
          }
          // 🎯 Goal: o turno acabou → roda a condição (exit 0 = pronto) e decide. Continua até
          // passar ou estourar maxIter. Reusa o motor do TURBO (run_check). Sem commit automático.
          const g = goalRef.current;
          if (g && goalStatusRef.current === "running") {
            const cwd = data.cwd || useCanvasStore.getState().currentCwd || "";
            if (!cwd) {
              goalStatusRef.current = "stopped";
              setGoalRun((r) => (r ? { ...r, status: "stopped" } : r));
              pushSys("🎯 Goal parou — sem pasta de projeto pra rodar a condição.");
              return;
            }
            let res: { exit: number | null; output: string };
            try {
              res = await runCheck(cwd, g.condition);
            } catch (e) {
              pushSys(`🎯 erro ao rodar a condição: ${e}`);
              return;
            }
            if (res.exit === 0) {
              goalStatusRef.current = "done";
              goalLastOutRef.current = null;
              setGoalRun((r) => (r ? { ...r, status: "done" } : r));
              pushSys(`🎯 Goal concluído — \`${g.condition}\` passou (exit 0). Revise o diff e commite.`);
            } else {
              const out = res.output.slice(0, 2000);
              // Detecção de estagnação (ponto do Jessé): a condição falhou EXATAMENTE igual à
              // iteração anterior → o agente está preso (mesmo fix que não muda nada). Aborta —
              // é mais barato que rodar até maxIter num loop circular.
              if (goalLastOutRef.current !== null && out === goalLastOutRef.current) {
                goalStatusRef.current = "stopped";
                setGoalRun((r) => (r ? { ...r, status: "stopped" } : r));
                pushSys(`🎯 Goal parou — estagnado: a condição falhou idêntica 2× (raciocínio circular). Revise manualmente.`);
                return;
              }
              goalLastOutRef.current = out;
              const it = goalIterRef.current + 1;
              if (it > g.maxIter) {
                goalStatusRef.current = "fail";
                setGoalRun((r) => (r ? { ...r, status: "fail" } : r));
                pushSys(`🎯 Goal parou — ${g.maxIter} iterações sem passar a condição.`);
              } else {
                goalIterRef.current = it;
                setGoalRun({ iter: it, status: "running" });
                pushSys(`🎯 iteração ${it}/${g.maxIter} — condição falhou (exit ${res.exit}), corrigindo…`);
                setStatus("thinking");
                turnStartRef.current = performance.now(); // Insights: t0 do turno da nova iteração
                // Reinjeta o OBJETIVO a cada iteração (ponto #4 do Jessé): o goal vive no goalRef
                // (estado separado), mas o Claude Code compacta o contexto → o objetivo original
                // some. Reinjetar mantém o norte + exige VERIFICAÇÃO articulada (adapta finish_task).
                // 📿 Recitação LIGADA → FOCO completo (objetivo + card do Kanban + progresso do
                // projeto). DESLIGADA (nó/flag) → collectFocus=null → objetivo puro (comportamento antigo).
                const focus = (await collectFocus(true)) ?? `OBJETIVO (não perca de vista):\n${g.objective}`;
                turnsSinceReciteRef.current = 0;
                await acpPrompt(
                  id,
                  `${focus}\n\n` +
                    `A condição de PRONTO \`${g.condition}\` ainda FALHA (exit ${res.exit}). Saída:\n${out}\n\n` +
                    `Corrija a causa raiz e continue até \`${g.condition}\` sair com exit 0. ` +
                    `NÃO diga que terminou sem rodar a condição você mesmo; relate COMO verificou.`,
                );
              }
            }
          }
        })),
        // acp://exit agora é só morte REAL (kill intencional — cancel/gc/reload — não emite).
        listenAcpExit(id, (seq) => gated(seq, () => {
          // Resume falhou rápido: o spawn pediu session/load mas o processo morreu ANTES de ficar
          // ready (ex: `claude --resume` sai 129/SIGHUP quando o adapter não retoma a sessão). Em vez
          // de deixar o agente MORTO, sobe uma sessão NOVA (perde a conversa, mas o agente volta).
          if (spawnedResumeRef.current && statusRef.current === "starting") {
            spawnedResumeRef.current = false;
            acpSessionIdRef.current = null;
            resumeRef.current = null;
            // F2: limpa TAMBÉM o acpSessionId persistido — senão todo spawn futuro
            // re-tentaria o mesmo resume falho pra sempre.
            patchNode(data.id, { acpSessionId: undefined });
            personaSentRef.current = false; // sessão nova → persona volta no ready
            pushSys(t("agent.resumeFellBack", "↻ o resume falhou (o adapter não retomou a sessão) — subindo uma sessão nova…"));
            // F2: a entry Dead segue ocupando o id no AcpManager → kill limpa ANTES do
            // re-mount (senão o acp_spawn recusa "sessão já existe").
            void (async () => {
              try { await acpCancel(data.id); } catch { /* já saiu */ }
              setReloadKey((k) => k + 1);
            })();
            return;
          }
          // Insights: morte REAL com um turno em voo → turno de erro (no-op se estava ocioso).
          finishTurn(false);
          setStatus("dead");
        })),
        listenAcpAuthRequired(id, (methods, seq) => gated(seq, () => {
          setAuthMethods(methods);
          setStatus("auth");
        })),
        listenAcpAuthFailed(id, (err, seq) => gated(seq, () => {
          pushSys(`falha no login: ${typeof err === "string" ? err : JSON.stringify(err)}`);
          setStatus("auth");
        })),
        // O adapter RECUSOU o modelo pedido (set_model/set_config_option) → badge volta pro
        // modelo confirmado e avisa, em vez de mentir. (Task #6: Hermes voltando pro ministral.)
        listenAcpModelRejected(id, (err, seq) => gated(seq, () => {
          const fallback = confirmedModelRef.current;
          if (fallback) {
            setModel(fallback);
            setUsage((u) => ({ ...u, model: fallback }));
          }
          pushSys(
            `⚠️ ${t("agent.modelRejected", "o adapter recusou a troca de modelo")}${fallback ? ` — ${t("agent.modelStayed", "segue em")} ${fallback}` : ""}: ${typeof err === "string" ? err : JSON.stringify(err)}`,
          );
        })),
      ]);
      if (!alive) {
        unsubs.forEach((u) => u());
        return;
      }

      // 1) ANEXA: a sessão pode já existir no backend (re-mount, troca de floor, F3
      //    virtualização). Sucesso = re-hidrata SEM re-spawnar — nada morre.
      let attached = false;
      try {
        const snap = await acpAttach(id);
        if (!alive) return;
        rehydrate(snap);
        attached = true;
      } catch {
        // sessão não existe → spawn abaixo (criação, pós-kill explícito ou boot novo)
      }

      // 2) SPAWN: reload na mesma execução usa o resumeRef; pós-restart do app usa o
      //    data.acpSessionId PERSISTIDO → session/load retoma a conversa.
      if (!attached && alive) {
        try {
          const resume = resumeRef.current ?? data.acpSessionId ?? undefined;
          spawnedResumeRef.current = !!resume; // este spawn é um resume? (pro fallback do exit)
          await acpSpawn(id, {
            provider: data.provider,
            cwd: data.cwd,
            resumeSessionId: resume,
            providerConfig: hermesCfg ?? undefined,
          });
          resumeRef.current = null; // consumido
        } catch (e) {
          pushSys(`erro ao iniciar: ${e}`);
          setStatus("dead");
        }
      }

      // 3) Drena o que chegou ao vivo DURANTE o attach/spawn, dedupado por seq (padrão
      //    buffer-durante-snapshot do PTY). Sem awaits daqui pro fim → nenhum evento
      //    novo intercala entre soltar o gate e drenar.
      attaching = false;
      for (const p of pending.splice(0)) {
        if (p.seq !== undefined) {
          if (p.seq <= lastSeq) continue;
          lastSeq = p.seq;
        }
        p.fn();
      }
    })();

    return () => {
      // F2: unmount = SÓ desligar listeners. A sessão (e o registro label→id no backend)
      // SOBREVIVE — o nó é uma view descartável que re-anexa no próximo mount. O kill
      // explícito vive no removeNode/fechar floor/projeto (canvas-store), no reload e
      // na troca de provider.
      alive = false;
      unsubs.forEach((u) => u());
    };
    // reloadKey: bumpar re-monta a sessão (reload de subagentes / troca de provider) —
    // o caller MATA a sessão antes do bump, senão o attach re-anexaria à antiga.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // `systemNote` → mostra uma linha de sistema em vez da bolha de usuário (ex: reação
  // automática a mudança de equipe), mas ainda envia `text` como o turno real.
  // 📿 Colhe o bloco de FOCO deste agente (objetivo do 🎯 Goal + card ativo do Kanban) pra
  // reinjeção. Async (lê o Kanban do projeto); tolerante a falha (sem projeto/erro → null).
  async function collectFocus(includeGoal: boolean): Promise<string | null> {
    if (data.recite === false || !getFlag("recitation")) return null; // 📿 desligado (nó ou flag global)
    const project = data.cwd || useCanvasStore.getState().currentCwd || "";
    if (!project) return null;
    const cards = await kanbanList(project).catch(() => []);
    const g = includeGoal ? goalRef.current : null;
    return buildRecitation({
      goal: g ? { objective: g.objective, condition: g.condition } : null,
      cards,
      nodeId: data.id,
    });
  }

  async function sendText(text: string, systemNote?: string) {
    const sid = sessionRef.current;
    if (!sid || status !== "ready" || !text.trim()) return;
    lastReplyRef.current = "";
    setMsgs((m) => [...m, systemNote ? { role: "system", text: systemNote } : { role: "user", text }]);
    setStatus("thinking");
    turnStartRef.current = performance.now(); // Insights: t0 do turno (fecha no turn-done/erro)
    // Prefixos invisíveis: contrato de orquestrador (só no 1º prompt) + roster pendente da
    // equipe (T2 — sempre que a equipe muda, o próximo prompt já leva a lista atualizada).
    const prefixes: string[] = [];
    if (!firstSentRef.current) {
      prefixes.push(ORCHESTRATOR_PROMPT);
      // Fase 3 — blackboard namespaceado por time (floor). Usa o param `scope` que o
      // memory_* já tem → o mural é só do seu time; com 1 floor vira o mural geral.
      if (myFloorName) {
        prefixes.push(`Mural do seu time: use SEMPRE scope='${myFloorName}' em memory_remember/memory_recall — é o blackboard compartilhado SÓ do seu time (floor "${myFloorName}"). Membros leem/escrevem nesse scope pra coordenar de forma assíncrona, sem falar direto.`);
      }
    }
    if (teamRef.current) { prefixes.push(teamRef.current); teamRef.current = null; }
    if (!subagentsSentRef.current && mySubagentLabels) {
      prefixes.push(`No canvas você plugou: ${mySubagentLabels} — MAS isso NÃO é a lista completa: liste seus subagentes REAIS pelo que está carregado em .claude/agents (pode haver globais em ~/.claude/agents). Pra invocar um plugado DEPOIS do boot, recarregue (↻).`);
      subagentsSentRef.current = true;
    }
    // 📿 Recitação periódica: agente FORA do 🎯 Goal e já com ≥RECITE_EVERY_TURNS turnos sem
    // reinjeção → o foco (objetivo/card do Kanban) viaja de carona NESTE prompt. Não dispara
    // turno extra: reforça o norte no fim do contexto quando o usuário já ia falar de qualquer jeito.
    if (!goalRef.current && turnsSinceReciteRef.current >= RECITE_EVERY_TURNS) {
      const focus = await collectFocus(false);
      if (focus) prefixes.push(focus);
      turnsSinceReciteRef.current = 0;
    }
    const payload = prefixes.length
      ? `${prefixes.join("\n\n")}\n\n---\nTarefa do usuário: ${text}`
      : text;
    firstSentRef.current = true;
    try {
      await acpPrompt(sid, payload);
    } catch (e) {
      finishTurn(false); // Insights: o prompt não saiu → turno de erro
      setMsgs((m) => [...m, { role: "system", text: `erro: ${e}` }]);
      setStatus("ready");
    }
  }

  async function send() {
    if (!input.trim()) return;
    const text = input.trim();
    setInput("");
    await sendText(text);
  }

  // 🧹 Compactar conversa (sob demanda): (a) serializa as msgs em markdown; (b) grava em
  // <cwd>/.omnirift/history/<slug>-<n>.md; (c) pede ao agente um resumo ≤20 linhas apontando
  // o path; (d) no turn-done seguinte, substitui as msgs por [system + resumo] (via compactRef).
  // O prompt vai DIRETO por acpPrompt (sem prefixos de orquestrador, sem bolha de usuário).
  async function compactConversation() {
    const sid = sessionRef.current;
    if (!sid || status !== "ready" || compactRef.current || msgs.length === 0) return;
    const cwd = data.cwd || useCanvasStore.getState().currentCwd || "";
    if (!cwd) {
      setMsgs((m) => [...m, { role: "system", text: `🧹 ${t("agent.compactNoCwd", "sem pasta de projeto — não dá pra gravar o histórico.")}` }]);
      return;
    }
    const label = data.label ?? "OmniAgent";
    const slug = agentsMdSlug(label) || "agente";
    const histDir = `${cwd}/.omnirift/history`;
    const n = await nextHistoryIndex(histDir, slug);
    const path = `${histDir}/${slug}-${n}.md`;
    try {
      await writeHistoryFile(cwd, path, serializeConversation(label, msgs));
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: `🧹 ${t("agent.compactWriteFail", "falha ao gravar o histórico")}: ${e}` }]);
      return;
    }
    compactRef.current = path;
    lastReplyRef.current = "";
    setMsgs((m) => [...m, { role: "system", text: `🧹 ${t("agent.compacting", "compactando… histórico completo salvo em")} ${path}` }]);
    setStatus("thinking");
    turnStartRef.current = performance.now(); // Insights: t0 do turno de compactação
    try {
      await acpPrompt(
        sid,
        `COMPACTAÇÃO: resuma nosso trabalho até aqui em NO MÁXIMO 20 linhas (decisões tomadas, estado atual, próximos passos). ` +
          `O histórico completo está salvo em ${path} — se precisar de algum detalhe, releia com read_file (paginado, offset/limit; NÃO o arquivo inteiro). ` +
          `Responda SÓ com o resumo.`,
      );
    } catch (e) {
      finishTurn(false); // Insights: o prompt de compactação não saiu → turno de erro
      compactRef.current = null;
      setMsgs((m) => [...m, { role: "system", text: `erro: ${e}` }]);
      setStatus("ready");
    }
  }

  // 🎯 Inicia um Goal: persiste a config, arma os refs e manda o 1º prompt (objetivo + condição).
  function startGoal(cfg: { objective: string; condition: string; maxIter: number }) {
    patchNode(data.id, { goal: cfg });
    goalRef.current = cfg;
    goalStatusRef.current = "running";
    goalIterRef.current = 1;
    goalLastOutRef.current = null;
    setGoalRun({ iter: 1, status: "running" });
    setPanel("none");
    void sendText(
      `OBJETIVO:\n${cfg.objective}\n\n` +
        `CONDIÇÃO DE PRONTO (comando que DEVE sair com exit 0):\n${cfg.condition}\n\n` +
        `Implemente. Ao terminar, a condição roda automaticamente; se falhar, você recebe o erro e continua até passar. ` +
        `NÃO declare pronto sem rodar a condição você mesmo — relate COMO verificou (teste rodou, diff aplicado, build passou).`,
      `🎯 Goal iniciado (iter 1/${cfg.maxIter})`,
    );
  }

  function stopGoal() {
    goalRef.current = null;
    goalStatusRef.current = null;
    goalLastOutRef.current = null;
    setGoalRun(null);
  }

  async function respond(optionId: string | null) {
    const sid = sessionRef.current;
    if (!sid || !perm) return;
    await acpPermissionRespond(sid, perm.reqId, optionId).catch((e) =>
      setMsgs((m) => [...m, { role: "system", text: `erro: ${e}` }]),
    );
    setPerm(null);
  }

  // Auth (Codex/ChatGPT): escolhe um authMethod → backend faz session/new → vem acp://ready.
  async function authenticate(methodId: string) {
    const sid = sessionRef.current;
    if (!sid) return;
    setStatus("starting");
    setAuthMethods([]);
    try {
      await acpAuthenticate(sid, methodId);
    } catch (e) {
      setMsgs((m) => [...m, { role: "system", text: `erro no login: ${e}` }]);
      setStatus("auth");
    }
  }

  // Wizard Hermes concluído: guarda a config (com a key, em memória) + persiste só {provider,model}
  // no nó, e re-spawna (o backend injeta as env vars → sessão nasce autenticada, sem login travado).
  function configureHermes(cfg: HermesProviderConfig) {
    hermesCfgRef.current = cfg;
    patchNode(data.id, { providerConfig: { provider: cfg.provider, model: cfg.model } });
    setStatus("starting");
    setReloadKey((k) => k + 1);
  }

  // Input roteado de upstream (conexão A→este nó): manda como prompt automaticamente.
  useEffect(() => {
    if (nodeInput?.text && status === "ready") void sendText(nodeInput.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeInput?.seq]);

  // O OmniAgent fica SEMPRE antenado: o roster atualizado entra no PRÓXIMO prompt dele
  // (lazy, de graça) e ele tem terminal_list/memory pra consultar tudo. O AUTO-DISPARO de
  // um turno (que gasta token) é opt-in via `proactiveTeamReact` (default OFF).
  useEffect(() => {
    if (!teamBriefing) return;
    teamRef.current = teamBriefing.text; // antenado: vai no próximo prompt, sempre
    const proactive = useCanvasStore.getState().proactiveTeamReact;
    if (proactive && status === "ready") {
      teamRef.current = null; // consome agora (já vai no turno disparado)
      void sendText(
        `${teamBriefing.text}\n\n[Atualização automática de equipe] Reavalie rapidamente se a equipe cobre a tarefa atual. Se faltar um papel (ex: code review, testes), diga objetivamente o que falta — não execute nada ainda.`,
        `📋 ${t("agent.teamUpdated", "Equipe atualizada — reavaliando a cobertura…")}`,
      );
    } else {
      // Token-safe: só registra que está ciente; usa no próximo passo sem gastar.
      setMsgs((m) => [...m, { role: "system", text: `📋 ${t("agent.teamUpdatedAware", "Equipe atualizada — ciente (considero no próximo passo).")}` }]);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teamBriefing?.seq]);

  // ESC fecha o fullscreen.
  useEffect(() => {
    if (!isFullscreen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") setIsFullscreen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [isFullscreen]);

  const inner = (
    <>
      {/* header */}
      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <Brain size={13} className="text-brand" />
        <span className="font-semibold text-text">{data.label ?? "OmniAgent"}</span>
        <select
          value={data.provider ?? "claude"}
          onChange={(e) => changeProvider(e.target.value as "claude" | "codex" | "hermes")}
          onPointerDown={(e) => e.stopPropagation()}
          title={t("agent.pickProvider", "Trocar o MOTOR (adapter ACP) mantendo a persona — abre uma conversa nova")}
          className="nodrag rounded bg-transparent px-0.5 text-[10px] uppercase text-text/40 outline-none hover:bg-white/5 focus:bg-black/40"
        >
          <option value="claude">claude</option>
          <option value="codex">codex</option>
          <option value="hermes">hermes</option>
        </select>
        <StatusBadge status={status} />
        <div className="flex-1" />
        {availableModels.length > 1 ? (
          <select
            value={model ?? ""}
            onChange={(e) => changeModel(e.target.value)}
            onPointerDown={(e) => e.stopPropagation()}
            title={t("agent.pickModel", "Trocar o modelo do agente (ex: um mais barato pra validar)")}
            className="nodrag max-w-[130px] truncate rounded bg-white/5 px-1 py-0.5 text-[10px] text-text/80 outline-none focus:bg-black/40"
          >
            {availableModels.map((m) => (
              <option key={m.modelId} value={m.modelId}>{m.name ?? m.modelId}</option>
            ))}
          </select>
        ) : model ? (
          <Badge>{model}</Badge>
        ) : null}
        {/* 🧹 compactar conversa — resumo ≤20 linhas; histórico completo vai pra .omnirift/history */}
        <button
          onClick={(e) => { e.stopPropagation(); void compactConversation(); }}
          disabled={status !== "ready" || msgs.length === 0}
          className="nodrag p-0.5 rounded text-[11px] leading-none text-text/50 hover:bg-white/10 hover:text-text transition-colors disabled:opacity-40"
          title={t("agent.compact", "Compactar conversa — o agente resume em ≤20 linhas e libera contexto; o histórico completo fica em .omnirift/history")}
          aria-label={t("agent.compactShort", "Compactar conversa")}
        >
          🧹
        </button>
        {usage.used != null && (
          <Badge title={t("agent.context", "contexto usado")}>
            {fmtTokens(usage.used)}
            {usage.size ? `/${fmtTokens(usage.size)}` : ""}
          </Badge>
        )}
        {usage.costUsd != null && (
          <Badge title={t("agent.cost", "custo da sessão")}>${usage.costUsd.toFixed(3)}</Badge>
        )}
        <NodeHelp text={t("agent.help", "OmniAgent (ACP): peça uma tarefa e tecle Enter. As ações dele aparecem como tool-calls. ⤢ abre em tela cheia; ligue a saída dele em outro nó pelas alças. Ligar uma linha num terminal já o adiciona ao time MCP. A alça de baixo (ou +) pluga um SUBAGENTE privado.")} />
        {/* Recarregar subagentes (re-spawna a sessão pra carregar os .claude/agents novos) */}
        {mySubagentLabels && (
          <button
            onClick={(e) => { e.stopPropagation(); reloadSession(); }}
            className="p-0.5 rounded text-text/50 hover:bg-white/10 hover:text-amber-300 transition-colors"
            title={t("agent.reloadSubagents", "Recarregar subagentes ({list}) — re-spawna a sessão; perde a conversa atual").replace("{list}", mySubagentLabels)}
            aria-label={t("agent.reloadSubagentsShort", "Recarregar subagentes")}
          >
            <RotateCw size={13} />
          </button>
        )}
        {/* 📸 Checkpoints do drive OmniFS — só aparece se o nó tem ≥1 snapshot; abre o menu de rollback */}
        <AgentCheckpointsMenu nodeId={data.id} label={data.label} />
        {/* 🎯 Goal — loop autônomo até a condição passar */}
        <button
          onClick={(e) => { e.stopPropagation(); setPanel((p) => (p === "goal" ? "none" : "goal")); }}
          className={cn(
            "p-0.5 rounded hover:bg-white/10 transition-colors",
            goalRun?.status === "running" ? "text-cyan-400" : "text-text/50 hover:text-cyan-300",
          )}
          title={t("agent.goal", "Goal — roda até a condição passar (exit 0)")}
          aria-label={t("agent.goal", "Goal")}
        >
          <Target size={13} />
        </button>
        {/* 🔁 Loop — re-dispara um prompt num timer */}
        <button
          onClick={(e) => { e.stopPropagation(); setPanel((p) => (p === "loop" ? "none" : "loop")); }}
          className={cn(
            "p-0.5 rounded hover:bg-white/10 transition-colors",
            data.loop?.active ? "text-emerald-400" : "text-text/50 hover:text-emerald-300",
          )}
          title={t("agent.loop", "Loop — re-dispara um prompt a cada N min")}
          aria-label={t("agent.loop", "Loop")}
        >
          <Repeat size={13} />
        </button>
        {/* 📿 Recitação — reinjeta o foco (objetivo + Kanban + progresso) no loop longo (Manus) */}
        <button
          onClick={(e) => { e.stopPropagation(); patchNode(data.id, { recite: data.recite === false ? true : false }); }}
          disabled={!reciteFlag}
          className={cn(
            "p-0.5 rounded hover:bg-white/10 transition-colors disabled:opacity-30 disabled:hover:bg-transparent",
            data.recite !== false && reciteFlag ? "text-violet-400" : "text-text/50 hover:text-violet-300",
          )}
          title={reciteFlag
            ? (data.recite === false
                ? t("agent.reciteOff", "Recitação desligada neste agente — clique pra ligar")
                : t("agent.reciteOn", "Recitação ligada — reinjeta o foco (objetivo + Kanban) no loop"))
            : t("agent.reciteFlagOff", "Recitação desligada nas flags (kill-switch global)")}
          aria-label={t("agent.recite", "Recitação")}
        >
          <ScrollText size={13} />
        </button>
        {/* Plugar subagente (privado deste agente) */}
        <button
          onClick={addSubagentHere}
          className="p-0.5 rounded text-text/50 hover:bg-white/10 hover:text-amber-300 transition-colors"
          title={t("agent.addSubagent", "Plugar subagente (privado deste agente)")}
          aria-label={t("agent.addSubagent", "Plugar subagente")}
        >
          <UserRoundPlus size={13} />
        </button>
        {/* Maximizar / restaurar */}
        <button
          onClick={(e) => { e.stopPropagation(); setIsFullscreen((v) => !v); }}
          className="p-0.5 rounded text-text/50 hover:bg-white/10 hover:text-text transition-colors"
          title={isFullscreen ? t("agent.restore", "Restaurar") : t("agent.fullscreen", "Tela cheia")}
          aria-label={isFullscreen ? t("agent.restore", "Restaurar") : t("agent.fullscreen", "Tela cheia")}
        >
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(data.id); }}
          className="p-0.5 rounded text-text/50 hover:bg-white/10 hover:text-text transition-colors"
          title={t("common.close", "Fechar")}
        >
          <X size={13} />
        </button>
      </div>

      {/* LOD: em zoom baixo a conversa é ilegível — corpo some (display:none, estado intacto)
          e o label grande orienta a navegação no canvas. */}
      {lodOut && !isFullscreen && (
        <div className="flex flex-1 items-center justify-center select-none">
          <span className="max-w-full truncate px-4 text-2xl font-semibold text-text/40">{data.label ?? "OmniAgent"}</span>
        </div>
      )}
      {/* corpo — nowheel: scroll dentro não dá zoom no canvas; nodrag: não arrasta o nó */}
      <div
        ref={bodyRef}
        className={cn("nodrag nowheel flex-1 space-y-1.5 overflow-auto p-2", lodOut && !isFullscreen && "hidden")}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {/* 🎯 chip de status do Goal em execução */}
        {goalRun && (
          <div className="flex items-center gap-2 rounded border border-cyan-500/30 bg-cyan-500/5 px-2 py-1 text-[11px]">
            <Target size={12} className={goalRun.status === "running" ? "text-cyan-400 animate-pulse" : "text-cyan-300"} />
            <span className="text-cyan-200">
              {t("agent.goalIter", "iter")} {goalRun.iter}/{data.goal?.maxIter ?? "?"} ·{" "}
              {goalRun.status === "running" ? t("agent.goalRunning", "rodando…")
                : goalRun.status === "done" ? t("agent.goalDone", "✅ pronto")
                : t("agent.goalStopped", "⏹ parado")}
            </span>
            <button onClick={stopGoal} className="ml-auto rounded px-1.5 py-0.5 text-text/60 hover:bg-white/10 hover:text-text">
              {t("common.stop", "parar")}
            </button>
          </div>
        )}
        {panel === "goal" && (
          <GoalForm initial={data.goal} onStart={startGoal} onCancel={() => setPanel("none")} />
        )}
        {panel === "loop" && (
          <LoopForm
            initial={data.loop}
            onSave={(cfg) => { patchNode(data.id, { loop: cfg }); setPanel("none"); }}
            onStop={() => { patchNode(data.id, { loop: { prompt: data.loop?.prompt ?? "", everyMin: data.loop?.everyMin ?? 10, active: false } }); }}
            onCancel={() => setPanel("none")}
          />
        )}
        {status === "starting" && (
          <div className="text-text/50">{t("agent.starting", "iniciando agente (1ª vez baixa o adapter, ~30s)…")}</div>
        )}
        {status === "config" && (
          <div className="space-y-1.5">
            <p className="text-[11px] text-text/60">
              {t("agent.hermesConfig", "Escolha o provider de inferência e o modelo (BYOK). Depois a sessão inicia sozinha.")}
            </p>
            <HermesWizard onDone={configureHermes} />
          </div>
        )}
        {status === "auth" && (
          <div className="rounded border border-orange-500/30 bg-orange-500/5 p-2.5">
            <div className="mb-1 font-semibold text-orange-300">
              {t("agent.authNeeded", "Este provider precisa de login")}
            </div>
            <p className="mb-2 text-[11px] text-text/60">
              {t("agent.authHint", "Escolha como entrar. O login abre no provider; ao concluir, a sessão inicia sozinha.")}
            </p>
            <div className="flex flex-wrap gap-1.5">
              {authMethods.map((mth) => (
                <button
                  key={mth.id}
                  onClick={() => authenticate(mth.id)}
                  title={mth.description}
                  className="rounded bg-orange-500/15 px-2.5 py-1 text-orange-200 hover:bg-orange-500/25"
                >
                  {t("agent.loginWith", "Entrar com {name}").replace("{name}", mth.name ?? mth.id)}
                </button>
              ))}
              {authMethods.length === 0 && (
                <span className="text-[11px] text-text/40">{t("agent.noAuthMethods", "Nenhum método de login ofertado pelo adapter.")}</span>
              )}
            </div>
          </div>
        )}
        {status === "ready" && msgs.length === 0 && !perm && <AgentHelp provider={data.provider ?? "claude"} />}
        {msgs.map((m, i) => (
          <MsgRow key={i} m={m} />
        ))}
        {perm && (
          <div className="rounded border border-yellow-500/20 bg-yellow-500/5 p-2">
            <div className="mb-1 text-yellow-300">{t("agent.permission", "permissão pedida:")}</div>
            <div className="flex flex-wrap gap-1">
              {perm.options.map((o) => (
                <button
                  key={o.optionId}
                  onClick={() => respond(o.optionId)}
                  // truncate: opção com nome longo (ex: "Always Allow all mcp__omnirift-agents__x")
                  // estourava o card em node estreito e escondia Allow/Reject — nome completo no title.
                  className="max-w-full truncate rounded bg-white/5 px-2 py-1 text-text hover:bg-white/10"
                  title={o.name}
                >
                  {o.name}
                </button>
              ))}
              <button
                onClick={() => respond(null)}
                className="rounded bg-red-500/10 px-2 py-1 text-red-300 hover:bg-red-500/20"
              >
                {t("agent.deny", "negar")}
              </button>
            </div>
          </div>
        )}
      </div>

      {/* input */}
      <div className="flex gap-1 border-t border-white/10 p-1.5">
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
              return;
            }
            // WebKitGTK/Linux: Ctrl/Cmd+V nativo não cola em <input> → lê o clipboard pelo plugin
            // (mesmo workaround do terminal) e insere no cursor.
            if ((e.ctrlKey || e.metaKey) && (e.key === "v" || e.key === "V")) {
              e.preventDefault();
              const el = e.currentTarget;
              const start = el.selectionStart ?? el.value.length;
              const end = el.selectionEnd ?? el.value.length;
              const before = el.value;
              void pasteText().then((clip) => {
                if (clip) setInput(before.slice(0, start) + clip + before.slice(end));
              });
            }
          }}
          disabled={status !== "ready"}
          placeholder={
            status === "ready"
              ? t("agent.ask", "Pergunte ao agente…")
              : status === "thinking"
                ? t("agent.thinking", "pensando…")
                : t("agent.wait", "aguarde…")
          }
          className="nodrag flex-1 rounded bg-black/20 px-2 py-1 text-text outline-none disabled:opacity-50"
        />
        <button
          onClick={send}
          disabled={status !== "ready"}
          className="rounded bg-brand/20 px-2 py-1 text-brand hover:bg-brand/30 disabled:opacity-40"
          title={t("agent.send", "Enviar")}
        >
          <Send size={13} />
        </button>
      </div>
    </>
  );

  // Fullscreen: renderiza o mesmo conteúdo num overlay (igual ao terminal). Portal no
  // body p/ escapar do transform do canvas; ESC fecha. Reusa o MESMO estado/handlers.
  if (isFullscreen) {
    return createPortal(
      <div
        className="fixed inset-0 z-[60] flex flex-col bg-bg text-xs"
        onPointerDown={(e) => e.stopPropagation()}
      >
        {inner}
      </div>,
      document.body,
    );
  }

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-bg text-xs",
        selected ? "border-brand" : "border-white/10",
      )}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onDoubleClick={(e) => {
        // Duplo-clique abre em tela cheia — menos nos controles (botões/input/select) e no corpo
        // rolável (pra não atrapalhar seleção de texto). Basicamente: duplo-clique no header/vazio.
        const el = e.target as HTMLElement;
        if (el.closest("button,input,textarea,select,a")) return;
        setIsFullscreen(true);
      }}
    >
      <NodeResizer
        minWidth={320}
        minHeight={260}
        isVisible={selected || hovered}
        color="rgb(167, 139, 250)"
        handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
      />
      <Handle type="target" position={Position.Left} className="!bg-brand !border-surface1" />
      <Handle type="source" position={Position.Right} className="!bg-brand !border-surface1" />
      {/* Alça de baixo = SUBAGENTE (privado); a da direita = time/par. */}
      <Handle type="source" id="subagent" position={Position.Bottom} className="!bg-amber-400 !border-surface1" />
      {inner}
    </div>
  );
}

function Badge({ children, title }: { children: ReactNode; title?: string }) {
  return (
    <span title={title} className="rounded bg-white/5 px-1.5 py-0.5 text-[10px] text-text/70">
      {children}
    </span>
  );
}

function StatusBadge({ status }: { status: Status }) {
  const map: Record<Status, [string, string]> = {
    starting: ["bg-yellow-400", "iniciando"],
    ready: ["bg-green-400", "pronto"],
    thinking: ["bg-brand animate-pulse", "pensando"],
    dead: ["bg-red-400", "encerrado"],
    auth: ["bg-orange-400", "login"],
    config: ["bg-orange-400", "configurar"],
  };
  const [color, label] = map[status];
  return (
    <span className="flex items-center gap-1 text-[10px] text-text/60">
      <span className={cn("h-1.5 w-1.5 rounded-full", color)} />
      {label}
    </span>
  );
}

function MsgRow({ m }: { m: Msg }) {
  if (m.role === "tool") {
    return (
      <div className="rounded bg-white/5 px-2 py-1 text-text/80">
        <span className="text-brand/70">[{m.toolKind}]</span> {m.text}{" "}
        <span className="text-text/40">· {m.status}</span>
      </div>
    );
  }
  if (m.role === "system") return <div className="text-red-300/80">{m.text}</div>;
  const isUser = m.role === "user";
  return (
    <div className={cn("whitespace-pre-wrap rounded px-2 py-1", isUser ? "bg-brand/10 text-text" : "text-text/90")}>
      {!isUser && <span className="mr-1 text-brand/50">▸</span>}
      {m.text}
    </div>
  );
}

/** Empty-state do nó: explica o que é o OmniAgent e como operar (aparece quando não há conversa). */
function AgentHelp({ provider }: { provider: string }) {
  return (
    <div className="space-y-2 text-[11px] leading-relaxed text-text/60">
      <div className="font-semibold text-text/80">O que é o OmniAgent</div>
      <p>
        Um agente de IA estruturado via <span className="text-brand">ACP</span> (Agent Client
        Protocol). Diferente do terminal, o app <strong className="text-text/80">entende</strong> o
        que o agente faz — não só repassa texto.
      </p>
      <div className="font-semibold text-text/80">Como opera</div>
      <ul className="list-disc space-y-0.5 pl-4">
        <li>Peça uma tarefa no campo abaixo e tecle Enter.</li>
        <li>
          As ações dele aparecem como <span className="text-brand">tool-calls</span> (ler · executar
          · editar) com status ao vivo.
        </li>
        <li>
          O topo mostra <strong className="text-text/80">modelo</strong>,{" "}
          <strong className="text-text/80">contexto</strong> usado e{" "}
          <strong className="text-text/80">custo</strong> da sessão.
        </li>
        <li>Se ele pedir permissão pra uma ação, você aprova ou nega aqui mesmo.</li>
      </ul>
      <p className="text-text/40">
        Provider: {provider} · roda o mesmo Claude/Codex, mas como sessão estruturada — não é um terminal PTY.
      </p>
    </div>
  );
}

/** Form do 🎯 Goal: objetivo + condição de parada (comando exit 0) + máx iterações. */
function GoalForm({
  initial,
  onStart,
  onCancel,
}: {
  initial?: { objective: string; condition: string; maxIter: number };
  onStart: (cfg: { objective: string; condition: string; maxIter: number }) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [objective, setObjective] = useState(initial?.objective ?? "");
  const [condition, setCondition] = useState(initial?.condition ?? "");
  const [maxIter, setMaxIter] = useState(initial?.maxIter ?? 8);
  const ok = objective.trim() !== "" && condition.trim() !== "";
  return (
    <div className="space-y-1.5 rounded border border-cyan-500/30 bg-cyan-500/5 p-2.5">
      <div className="font-semibold text-cyan-300">🎯 {t("agent.goalTitle", "Goal — roda até passar")}</div>
      <textarea
        value={objective}
        onChange={(e) => setObjective(e.target.value)}
        placeholder={t("agent.goalObjective", "objetivo — o que o agente deve fazer")}
        rows={2}
        className="w-full resize-none rounded bg-white/5 px-2 py-1 text-text outline-none"
      />
      <input
        value={condition}
        onChange={(e) => setCondition(e.target.value)}
        placeholder={t("agent.goalCondition", "condição: comando que sai exit 0 (ex: cargo test)")}
        className="w-full rounded bg-white/5 px-2 py-1 font-mono text-[11px] text-text outline-none"
      />
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-text/60">{t("agent.goalMaxIter", "máx iter")}</label>
        <input
          type="number"
          min={1}
          max={50}
          value={maxIter}
          onChange={(e) => setMaxIter(Math.max(1, Math.min(50, Number(e.target.value) || 1)))}
          className="w-14 rounded bg-white/5 px-2 py-1 text-text outline-none"
        />
        <div className="ml-auto flex gap-1.5">
          <button onClick={onCancel} className="rounded bg-white/5 px-2 py-1 text-text/70 hover:bg-white/10">
            {t("common.cancel", "Cancelar")}
          </button>
          <button
            disabled={!ok}
            onClick={() => onStart({ objective: objective.trim(), condition: condition.trim(), maxIter })}
            className="rounded bg-cyan-500/20 px-2.5 py-1 text-cyan-200 hover:bg-cyan-500/30 disabled:opacity-50"
          >
            {t("agent.goalStart", "Iniciar")}
          </button>
        </div>
      </div>
      <p className="text-[10px] text-text/40">
        {t("agent.goalHint", "o agente tenta, roda a condição e corrige até exit 0. Sem commit automático — você revisa.")}
      </p>
    </div>
  );
}

/** Form do 🔁 Loop: prompt recorrente a cada N min. */
function LoopForm({
  initial,
  onSave,
  onStop,
  onCancel,
}: {
  initial?: { prompt: string; everyMin: number; active: boolean };
  onSave: (cfg: { prompt: string; everyMin: number; active: boolean }) => void;
  onStop: () => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  const [everyMin, setEveryMin] = useState(initial?.everyMin ?? 10);
  const active = initial?.active ?? false;
  const ok = prompt.trim() !== "";
  return (
    <div className="space-y-1.5 rounded border border-emerald-500/30 bg-emerald-500/5 p-2.5">
      <div className="font-semibold text-emerald-300">🔁 {t("agent.loopTitle", "Loop — a cada N min")}</div>
      <textarea
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder={t("agent.loopPrompt", "prompt a re-enviar (ex: rode os testes e me avise se quebrar)")}
        rows={2}
        className="w-full resize-none rounded bg-white/5 px-2 py-1 text-text outline-none"
      />
      <div className="flex items-center gap-2">
        <label className="text-[11px] text-text/60">{t("agent.loopEvery", "a cada (min)")}</label>
        <input
          type="number"
          min={1}
          value={everyMin}
          onChange={(e) => setEveryMin(Math.max(1, Number(e.target.value) || 1))}
          className="w-16 rounded bg-white/5 px-2 py-1 text-text outline-none"
        />
        <div className="ml-auto flex gap-1.5">
          <button onClick={onCancel} className="rounded bg-white/5 px-2 py-1 text-text/70 hover:bg-white/10">
            {t("common.cancel", "Cancelar")}
          </button>
          {active && (
            <button onClick={onStop} className="rounded bg-white/10 px-2 py-1 text-text/80 hover:bg-white/20">
              {t("agent.loopStop", "Desativar")}
            </button>
          )}
          <button
            disabled={!ok}
            onClick={() => onSave({ prompt: prompt.trim(), everyMin, active: true })}
            className="rounded bg-emerald-500/20 px-2.5 py-1 text-emerald-200 hover:bg-emerald-500/30 disabled:opacity-50"
          >
            {active ? t("agent.loopUpdate", "Atualizar") : t("agent.loopActivate", "Ativar")}
          </button>
        </div>
      </div>
    </div>
  );
}

export const AgentNode = memo(AgentNodeImpl);
