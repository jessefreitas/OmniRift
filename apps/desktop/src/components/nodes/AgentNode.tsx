// src/components/nodes/AgentNode.tsx
//
// Nó de AGENTE ESTRUTURADO (ACP) no canvas — coexiste com o TerminalNode (PTY).
// Ao montar, spawna uma sessão ACP (Claude Code via adapter) e renderiza o stream
// ESTRUTURADO: mensagens, tool-calls e badges de modelo/contexto/custo (do usage_update).
// Sucessor do AcpDebugPanel (spike). A sessão ACP é efêmera: re-spawna a cada montagem;
// o nó só persiste config leve (label/cwd) no workspace.

import { memo, useEffect, useRef, useState, type ReactNode } from "react";
import {
  Handle,
  NodeResizer,
  Position,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Brain, Send, X } from "lucide-react";
import { nanoid } from "nanoid";
import type { UnlistenFn } from "@tauri-apps/api/event";

import { useCanvasStore } from "@/store/canvas-store";
import { useT } from "@/lib/i18n";
import { cn } from "@/lib/cn";
import {
  acpSpawn,
  acpPrompt,
  acpPermissionRespond,
  acpCancel,
  listenAcpReady,
  listenAcpUpdate,
  listenAcpPermission,
  listenAcpTurnDone,
  listenAcpExit,
} from "@/lib/acp-client";
import type { AgentNode as AgentNodeData } from "@/types/canvas";

type AgentRfNode = Node<AgentNodeData & Record<string, unknown>, "agent">;
type AgentNodeProps = NodeProps<AgentRfNode>;

type Status = "starting" | "ready" | "thinking" | "dead";
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

// Contrato injetado (invisível) no 1º prompt → faz o OmniAgent agir como orquestrador,
// usando as tools MCP do OmniRift (injetadas no session/new pelo backend).
const ORCHESTRATOR_PROMPT = `Você é o ORQUESTRADOR do OmniRift: você COORDENA agentes em vez de executar tudo sozinho. Você tem ferramentas MCP do OmniRift disponíveis: terminal_list (ver os agentes ativos), terminal_spawn_on_floor (criar um agente num worktree git isolado), terminal_run e terminal_send_text (comandar um agente), terminal_wait_status (esperar um agente concluir), memory_remember e memory_recall (blackboard compartilhado), claim_acquire e claim_release (evitar conflito de edição). Ao receber uma tarefa: decomponha em subtarefas, delegue a agentes (listando os existentes ou criando novos), acompanhe a conclusão e sintetize o resultado. Prefira DELEGAR a executar você mesmo.`;

function AgentNodeImpl({ data, selected }: AgentNodeProps) {
  const removeNode = useCanvasStore((s) => s.removeNode);
  const emitAgentOutput = useCanvasStore((s) => s.emitAgentOutput);
  const nodeInput = useCanvasStore((s) => s.nodeInputs[data.id]);
  const t = useT();

  const [status, setStatus] = useState<Status>("starting");
  const [model, setModel] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage>({});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [perm, setPerm] = useState<Perm | null>(null);
  const [input, setInput] = useState("");

  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastReplyRef = useRef(""); // acumula a resposta do turno → vira "saída" no turn-done
  const firstSentRef = useRef(false); // prefixa o contrato de orquestrador só no 1º prompt

  // Autoscroll pro fim a cada novo conteúdo.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, perm, status]);

  // Spawn + listeners no mount; cleanup no unmount.
  useEffect(() => {
    const id = nanoid();
    sessionRef.current = id;
    let unsubs: UnlistenFn[] = [];
    let alive = true;

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
            | { availableModels?: { modelId: string }[]; currentModelId?: string }
            | undefined;
          const cur = models?.currentModelId ?? models?.availableModels?.[0]?.modelId ?? null;
          setModel(cur);
          setUsage((u) => ({ ...u, model: cur ?? undefined }));
          setStatus("ready");
        }),
        listenAcpUpdate(id, applyUpdate),
        listenAcpPermission(id, (reqId, params) =>
          setPerm({ reqId, options: (params.options as Perm["options"]) ?? [] }),
        ),
        listenAcpTurnDone(id, () => {
          setStatus("ready");
          const reply = lastReplyRef.current.trim();
          if (reply) emitAgentOutput(data.id, reply);
        }),
        listenAcpExit(id, () => setStatus("dead")),
      ]);
      if (!alive) {
        unsubs.forEach((u) => u());
        return;
      }
      try {
        await acpSpawn(id, { provider: data.provider, cwd: data.cwd });
      } catch (e) {
        pushSys(`erro ao iniciar: ${e}`);
        setStatus("dead");
      }
    })();

    return () => {
      alive = false;
      unsubs.forEach((u) => u());
      acpCancel(id).catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function sendText(text: string) {
    const sid = sessionRef.current;
    if (!sid || status !== "ready" || !text.trim()) return;
    lastReplyRef.current = "";
    setMsgs((m) => [...m, { role: "user", text }]);
    setStatus("thinking");
    // 1º prompt: prefixa o contrato de orquestrador (invisível pro user) → estabelece papel + tools.
    const payload = firstSentRef.current ? text : `${ORCHESTRATOR_PROMPT}\n\n---\nTarefa do usuário: ${text}`;
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

  async function respond(optionId: string | null) {
    const sid = sessionRef.current;
    if (!sid || !perm) return;
    await acpPermissionRespond(sid, perm.reqId, optionId).catch((e) =>
      setMsgs((m) => [...m, { role: "system", text: `erro: ${e}` }]),
    );
    setPerm(null);
  }

  // Input roteado de upstream (conexão A→este nó): manda como prompt automaticamente.
  useEffect(() => {
    if (nodeInput?.text && status === "ready") void sendText(nodeInput.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeInput?.seq]);

  return (
    <div
      className={cn(
        "flex h-full w-full flex-col rounded-lg border bg-bg text-xs",
        selected ? "border-brand" : "border-white/10",
      )}
    >
      <NodeResizer minWidth={320} minHeight={260} isVisible={selected} />
      <Handle type="target" position={Position.Left} className="!bg-brand !border-surface1" />
      <Handle type="source" position={Position.Right} className="!bg-brand !border-surface1" />

      {/* header */}
      <div className="node-drag-handle flex items-center gap-1.5 border-b border-white/10 px-2 py-1.5">
        <Brain size={13} className="text-brand" />
        <span className="font-semibold text-text">{data.label ?? "OmniAgent"}</span>
        <span className="text-[10px] uppercase text-text/40">{data.provider ?? "claude"}</span>
        <StatusBadge status={status} />
        <div className="flex-1" />
        {model && <Badge>{model}</Badge>}
        {usage.used != null && (
          <Badge title={t("agent.context", "contexto usado")}>
            {fmtTokens(usage.used)}
            {usage.size ? `/${fmtTokens(usage.size)}` : ""}
          </Badge>
        )}
        {usage.costUsd != null && (
          <Badge title={t("agent.cost", "custo da sessão")}>${usage.costUsd.toFixed(3)}</Badge>
        )}
        <button
          onClick={() => removeNode(data.id)}
          className="text-text/50 hover:text-text"
          title={t("common.close", "Fechar")}
        >
          <X size={13} />
        </button>
      </div>

      {/* corpo */}
      <div ref={bodyRef} className="flex-1 space-y-1.5 overflow-auto p-2">
        {status === "starting" && (
          <div className="text-text/50">{t("agent.starting", "iniciando agente (1ª vez baixa o adapter, ~30s)…")}</div>
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

export const AgentNode = memo(AgentNodeImpl);
