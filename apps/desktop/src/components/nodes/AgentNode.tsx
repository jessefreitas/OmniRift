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
import { Brain, Maximize2, Minimize2, Send, X } from "lucide-react";
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
  acpAgentRegister,
  acpAgentUnregister,
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

type AgentRfNode = Node<AgentNodeData & Record<string, unknown>, "agent">;
type AgentNodeProps = NodeProps<AgentRfNode>;

type Status = "starting" | "ready" | "thinking" | "dead" | "auth";
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
  const teamBriefing = useCanvasStore((s) => s.teamBriefing);
  const t = useT();

  const [status, setStatus] = useState<Status>("starting");
  const [model, setModel] = useState<string | null>(null);
  const [usage, setUsage] = useState<Usage>({});
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [perm, setPerm] = useState<Perm | null>(null);
  const [authMethods, setAuthMethods] = useState<AcpAuthMethod[]>([]);
  const [input, setInput] = useState("");
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hovered, setHovered] = useState(false);

  const sessionRef = useRef<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const lastReplyRef = useRef(""); // acumula a resposta do turno → vira "saída" no turn-done
  const firstSentRef = useRef(false); // prefixa o contrato de orquestrador só no 1º prompt
  const teamRef = useRef<string | null>(null); // roster pendente p/ injetar no próximo prompt

  // Autoscroll pro fim a cada novo conteúdo.
  useEffect(() => {
    bodyRef.current?.scrollTo({ top: bodyRef.current.scrollHeight });
  }, [msgs, perm, status]);

  // Spawn + listeners no mount; cleanup no unmount.
  useEffect(() => {
    const id = nanoid();
    sessionRef.current = id;
    const cmdLabel = data.label ?? "OmniAgent"; // label sob o qual o Orquestrador o comanda
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
          // Torna-se COMANDÁVEL pelo Orquestrador-terminal (entra no terminal_list).
          void acpAgentRegister(cmdLabel, id);
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
        await acpSpawn(id, { provider: data.provider, cwd: data.cwd });
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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
    if (!firstSentRef.current) prefixes.push(ORCHESTRATOR_PROMPT);
    if (teamRef.current) { prefixes.push(teamRef.current); teamRef.current = null; }
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

  // Input roteado de upstream (conexão A→este nó): manda como prompt automaticamente.
  useEffect(() => {
    if (nodeInput?.text && status === "ready") void sendText(nodeInput.text);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodeInput?.seq]);

  // T2 — o "principal" sabe na hora que a equipe mudou. Ocioso (ready) → REAGE na hora:
  // manda um turno curto de reavaliação (ex: "entrou o 4º agente, falta code review?").
  // Ocupado/iniciando → guarda o roster pro próximo prompt (lazy) pra não atropelar o turno.
  useEffect(() => {
    if (!teamBriefing) return;
    if (status === "ready") {
      teamRef.current = null;
      void sendText(
        `${teamBriefing.text}\n\n[Atualização automática de equipe] Reavalie rapidamente se a equipe cobre a tarefa atual. Se faltar um papel (ex: code review, testes), diga objetivamente o que falta — não execute nada ainda.`,
        `📋 ${t("agent.teamUpdated", "Equipe atualizada — reavaliando a cobertura…")}`,
      );
    } else {
      teamRef.current = teamBriefing.text;
      if (status === "thinking") {
        setMsgs((m) => [...m, { role: "system", text: `📋 ${t("agent.teamUpdatedQueued", "Equipe atualizada — considero no próximo passo.")}` }]);
      }
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
        <NodeHelp text={t("agent.help", "OmniAgent (ACP): peça uma tarefa e tecle Enter. As ações dele aparecem como tool-calls. ⤢ abre em tela cheia; ligue a saída dele em outro nó pelas alças. Ligar uma linha num terminal já o adiciona ao time MCP.")} />
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
        {status === "starting" && (
          <div className="text-text/50">{t("agent.starting", "iniciando agente (1ª vez baixa o adapter, ~30s)…")}</div>
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
        "flex h-full w-full flex-col rounded-lg border bg-bg text-xs",
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
