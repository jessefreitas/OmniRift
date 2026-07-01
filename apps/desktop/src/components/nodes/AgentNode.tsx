// src/components/nodes/AgentNode.tsx
//
// Nó de AGENTE ESTRUTURADO (ACP) no canvas — coexiste com o TerminalNode (PTY).
// Ao montar, spawna uma sessão ACP (Claude Code via adapter) e renderiza o stream
// ESTRUTURADO: mensagens, tool-calls e badges de modelo/contexto/custo (do usage_update).
// Sucessor do AcpDebugPanel (spike). A sessão ACP é efêmera: re-spawna a cada montagem;
// o nó só persiste config leve (label/cwd) no workspace.

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Handle,
  NodeResizer,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Brain, Maximize2, Minimize2, Repeat, RotateCw, Send, Target, UserRoundPlus, X } from "lucide-react";
import { nanoid } from "nanoid";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { useCanvasStore } from "@/store/canvas-store";
import { NodeHelp } from "@/components/NodeHelp";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  acpSpawn,
  acpPrompt,
  acpPermissionRespond,
  acpCancel,
  acpAuthenticate,
  acpSetModel,
  acpAgentRegister,
  acpAgentUnregister,
  runCheck,
  listenAcpReady,
  listenAcpUpdate,
  listenAcpPermission,
  listenAcpTurnDone,
  listenAcpExit,
  listenAcpAuthRequired,
  listenAcpAuthFailed,
  type AcpAuthMethod,
} from "@/lib/acp-client";
import type { AgentNode as AgentNodeData } from "@/types/canvas";
import { HermesWizard, type HermesProviderConfig } from "./HermesWizard";

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
  const firstSentRef = useRef(false); // prefixa o contrato de orquestrador só no 1º prompt
  const teamRef = useRef<string | null>(null); // roster pendente p/ injetar no próximo prompt
  const subagentsSentRef = useRef(false); // a lista de subagentes já foi injetada num prompt?
  const acpSessionIdRef = useRef<string | null>(null); // sessionId do ADAPTER (p/ session/load)
  const resumeRef = useRef<string | null>(null); // pendente: resumir esta sessão no próximo spawn
  // Config BYOK do Hermes escolhida no wizard (com a key) — em memória só (a key NUNCA vai pro
  // store/disco). data.providerConfig persiste só {provider,model}; a key mora no keychain do SO.
  const hermesCfgRef = useRef<HermesProviderConfig | null>(null);
  // 🎯 Goal (loop autônomo por-agente) + 🔁 Loop (timer). Os refs guardam o run ATIVO (estáveis
  // no closure do turn-done, sem stale state); goalRun alimenta o badge no header.
  const goalRef = useRef<{ objective: string; condition: string; maxIter: number } | null>(null);
  const goalStatusRef = useRef<"running" | "done" | "stopped" | "fail" | null>(null);
  const goalIterRef = useRef(0);
  const statusRef = useRef<Status>("starting");
  const [goalRun, setGoalRun] = useState<{ iter: number; status: "running" | "done" | "stopped" | "fail" } | null>(null);
  const [panel, setPanel] = useState<"none" | "goal" | "loop">("none");
  // Espelha o status num ref (o timer do 🔁 Loop e o turn-done do 🎯 Goal leem sem stale state).
  useEffect(() => {
    statusRef.current = status;
  }, [status]);

  // 🔁 Loop: re-manda o prompt a cada N min (só se ready e ocioso). Reusa acpPrompt. Persistido
  // em data.loop; ligar/desligar via o painel Loop. Não dispara no meio de um turno (thinking).
  useEffect(() => {
    const lp = data.loop;
    if (!lp?.active || !lp.prompt.trim()) return;
    const ms = Math.max(1, lp.everyMin) * 60_000;
    const timer = window.setInterval(() => {
      if (statusRef.current === "ready" && sessionRef.current) {
        void acpPrompt(sessionRef.current, lp.prompt);
        setMsgs((m) => [...m, { role: "system", text: `🔁 loop — disparando (a cada ${lp.everyMin} min)` }]);
      }
    }, ms);
    return () => window.clearInterval(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.loop?.active, data.loop?.everyMin, data.loop?.prompt]);
  const lastDiffRef = useRef<{ diff: string; path?: string } | null>(null); // diff do turno (Fase 2a)

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
    }
    setStatus("starting");
    setPerm(null);
    setAuthMethods([]);
    firstSentRef.current = false;
    teamRef.current = null;
    subagentsSentRef.current = false;
    setReloadKey((k) => k + 1);
  }

  // Troca o modelo do agente (ACP session/set_model). Útil pra rodar um agente barato
  // (ex: validador) num modelo leve, e o autor num modelo forte.
  function changeModel(modelId: string) {
    const sid = acpSessionIdRef.current;
    if (!sid || !modelId || modelId === model) return;
    setModel(modelId);
    setUsage((u) => ({ ...u, model: modelId }));
    void acpSetModel(sid, modelId);
    setMsgs((m) => [...m, { role: "system", text: `⚙️ ${t("agent.modelChanged", "modelo")} → ${availableModels.find((x) => x.modelId === modelId)?.name ?? modelId}` }]);
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

  // Spawn + listeners no mount; cleanup no unmount.
  useEffect(() => {
    const id = nanoid();
    sessionRef.current = id;
    const cmdLabel = data.label ?? "OmniAgent"; // label sob o qual o Orquestrador o comanda
    let unsubs: UnlistenFn[] = [];
    let alive = true;

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
          return [...m, { role: "assistant", text }];
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
      }
    };

    (async () => {
      unsubs = await Promise.all([
        listenAcpReady(id, (info) => {
          const models = info.models as
            | { availableModels?: { modelId: string; name?: string }[]; currentModelId?: string }
            | undefined;
          const avail = models?.availableModels ?? [];
          if (avail.length) setAvailableModels(avail);
          let cur = models?.currentModelId ?? avail[0]?.modelId ?? null;
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
          }
          if (cur) setModel(cur);
          if (cur) setUsage((u) => ({ ...u, model: cur }));
          // Guarda o sessionId do ADAPTER (session/new traz; session/load não → mantém o anterior)
          // pra poder dar session/load num reload futuro (mantém a conversa).
          const sessId = (info as { sessionId?: string }).sessionId;
          if (sessId) acpSessionIdRef.current = sessId;
          setStatus("ready");
          // Torna-se COMANDÁVEL pelo Orquestrador-terminal (entra no terminal_list).
          void acpAgentRegister(cmdLabel, id);
        }),
        listenAcpUpdate(id, applyUpdate),
        listenAcpPermission(id, (reqId, params) =>
          setPerm({ reqId, options: (params.options as Perm["options"]) ?? [] }),
        ),
        listenAcpTurnDone(id, async () => {
          setStatus("ready");
          const reply = lastReplyRef.current.trim();
          const diff = lastDiffRef.current;
          lastDiffRef.current = null;
          if (diff) {
            // Fase 2a: um diff produzido no turno vira payload "diff" na linha (não só texto).
            emitAgentOutput(data.id, reply || `diff em ${diff.path ?? "arquivo"}`, { kind: "diff", diff: diff.diff, path: diff.path });
          } else if (reply) {
            emitAgentOutput(data.id, reply);
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
              setGoalRun((r) => (r ? { ...r, status: "done" } : r));
              pushSys(`🎯 Goal concluído — \`${g.condition}\` passou (exit 0). Revise o diff e commite.`);
            } else {
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
                const out = res.output.slice(0, 2000);
                await acpPrompt(
                  id,
                  `A condição \`${g.condition}\` ainda FALHA (exit ${res.exit}). Saída:\n${out}\n\nCorrija a causa e continue até ela sair com exit 0. Não pare antes disso.`,
                );
              }
            }
          }
        }),
        listenAcpExit(id, () => setStatus("dead")),
        listenAcpAuthRequired(id, (methods) => {
          setAuthMethods(methods);
          setStatus("auth");
        }),
        listenAcpAuthFailed(id, (err) => {
          pushSys(`falha no login: ${typeof err === "string" ? err : JSON.stringify(err)}`);
          setStatus("auth");
        }),
      ]);
      if (!alive) {
        unsubs.forEach((u) => u());
        return;
      }
      try {
        await acpSpawn(id, {
          provider: data.provider,
          cwd: data.cwd,
          resumeSessionId: resumeRef.current ?? undefined,
          providerConfig: hermesCfg ?? undefined,
        });
        resumeRef.current = null; // consumido
      } catch (e) {
        pushSys(`erro ao iniciar: ${e}`);
        setStatus("dead");
      }
    })();

    return () => {
      alive = false;
      unsubs.forEach((u) => u());
      acpAgentUnregister(cmdLabel).catch(() => {});
      acpCancel(id).catch(() => {});
    };
    // reloadKey: bumpar re-spawna a sessão (carrega .claude/agents plugados depois do boot).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reloadKey]);

  // `systemNote` → mostra uma linha de sistema em vez da bolha de usuário (ex: reação
  // automática a mudança de equipe), mas ainda envia `text` como o turno real.
  async function sendText(text: string, systemNote?: string) {
    const sid = sessionRef.current;
    if (!sid || status !== "ready" || !text.trim()) return;
    lastReplyRef.current = "";
    setMsgs((m) => [...m, systemNote ? { role: "system", text: systemNote } : { role: "user", text }]);
    setStatus("thinking");
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
    const payload = prefixes.length
      ? `${prefixes.join("\n\n")}\n\n---\nTarefa do usuário: ${text}`
      : text;
    firstSentRef.current = true;
    try {
      await acpPrompt(sid, payload);
    } catch (e) {
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

  // 🎯 Inicia um Goal: persiste a config, arma os refs e manda o 1º prompt (objetivo + condição).
  function startGoal(cfg: { objective: string; condition: string; maxIter: number }) {
    patchNode(data.id, { goal: cfg });
    goalRef.current = cfg;
    goalStatusRef.current = "running";
    goalIterRef.current = 1;
    setGoalRun({ iter: 1, status: "running" });
    setPanel("none");
    void sendText(
      `OBJETIVO:\n${cfg.objective}\n\nCONDIÇÃO DE PRONTO (comando que DEVE sair com exit 0):\n${cfg.condition}\n\nImplemente. Ao terminar, a condição roda automaticamente; se falhar, você recebe o erro e continua até passar.`,
      `🎯 Goal iniciado (iter 1/${cfg.maxIter})`,
    );
  }

  function stopGoal() {
    goalRef.current = null;
    goalStatusRef.current = null;
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
        <span className="text-[10px] uppercase text-text/40">{data.provider ?? "claude"}</span>
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

      {/* corpo — nowheel: scroll dentro não dá zoom no canvas; nodrag: não arrasta o nó */}
      <div
        ref={bodyRef}
        className="nodrag nowheel flex-1 space-y-1.5 overflow-auto p-2"
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
                  className="rounded bg-white/5 px-2 py-1 text-text hover:bg-white/10"
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
