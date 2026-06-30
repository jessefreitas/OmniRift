// src/components/AcpDebugPanel.tsx
//
// Spike ACP — painel cru de debug. FAB no canto + painel que spawna uma sessão
// ACP (Claude Code via adapter), manda prompt e mostra o stream ESTRUTURADO
// (tool_call / agent_message_chunk) + aprova/nega permissões. NÃO é a UI final
// (que será o AgentNode no canvas) — é a prova do canal estruturado end-to-end.

import { useEffect, useRef, useState } from "react";
import { nanoid } from "nanoid";
import type { UnlistenFn } from "@tauri-apps/api/event";
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

interface LogItem {
  kind: string;
  text: string;
}
interface PermReq {
  reqId: unknown;
  options: { optionId: string; name: string }[];
}

function summarize(up: Record<string, unknown>): string {
  const kind = up?.sessionUpdate as string | undefined;
  if (kind === "agent_message_chunk" || kind === "agent_thought_chunk") {
    const content = up.content as { text?: string } | undefined;
    return content?.text ?? JSON.stringify(up.content);
  }
  if (kind && kind.startsWith("tool_call")) {
    const k = (up.kind as string) ?? "tool";
    const title = (up.title as string) ?? (up.toolCallId as string);
    return `[${k}] ${title} · ${(up.status as string) ?? "?"}`;
  }
  return JSON.stringify(up).slice(0, 240);
}

export function AcpDebugPanel() {
  const [open, setOpen] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [ready, setReady] = useState<string | null>(null);
  const [items, setItems] = useState<LogItem[]>([]);
  const [perm, setPerm] = useState<PermReq | null>(null);
  const [input, setInput] = useState("Responda apenas a palavra OK, sem usar ferramentas.");
  const [busy, setBusy] = useState(false);
  const unsubs = useRef<UnlistenFn[]>([]);

  const log = (kind: string, text: string) => setItems((p) => [...p, { kind, text }]);

  async function start() {
    const id = nanoid();
    setSessionId(id);
    log("spawn", "iniciando adapter (1ª vez baixa o pacote, ~30s)…");
    unsubs.current = await Promise.all([
      listenAcpReady(id, (info) => {
        const models =
          (info.models as { availableModels?: { modelId: string }[] } | undefined)?.availableModels ?? [];
        const mode = (info.modes as { currentModeId?: string } | undefined)?.currentModeId;
        setReady(`models: ${models.map((m) => m.modelId).join(", ")} · mode: ${mode}`);
        log("ready", "session/new OK — agente pronto");
      }),
      listenAcpUpdate(id, (up) => log((up.sessionUpdate as string) ?? "update", summarize(up))),
      listenAcpPermission(id, (reqId, params) => {
        const options = (params.options as { optionId: string; name: string }[]) ?? [];
        setPerm({ reqId, options });
        log("permission", "agente pediu permissão");
      }),
      listenAcpTurnDone(id, () => {
        setBusy(false);
        log("turn-done", "fim do turno");
      }),
      listenAcpExit(id, () => log("exit", "adapter encerrou")),
    ]);
    try {
      await acpSpawn(id);
    } catch (e) {
      log("erro", String(e));
    }
  }

  async function send() {
    if (!sessionId || busy) return;
    setBusy(true);
    log("prompt", input);
    try {
      await acpPrompt(sessionId, input);
    } catch (e) {
      setBusy(false);
      log("erro", String(e));
    }
  }

  async function respond(optionId: string | null) {
    if (!sessionId || !perm) return;
    try {
      await acpPermissionRespond(sessionId, perm.reqId, optionId);
      log("permission", optionId ? `→ ${optionId}` : "→ cancelado");
    } catch (e) {
      log("erro", String(e));
    }
    setPerm(null);
  }

  useEffect(() => {
    return () => {
      unsubs.current.forEach((u) => u());
      if (sessionId) acpCancel(sessionId).catch(() => {});
    };
  }, [sessionId]);

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="fixed bottom-3 left-3 z-50 rounded-md border border-white/10 bg-bg px-3 py-1.5 text-xs text-text hover:text-brand"
        title="Spike ACP (agente estruturado)"
      >
        ACP
      </button>
    );
  }

  return (
    <div className="fixed bottom-3 left-3 z-50 flex h-[520px] w-[420px] flex-col rounded-lg border border-white/10 bg-bg text-xs shadow-xl">
      <div className="flex items-center gap-2 border-b border-white/10 px-3 py-2">
        <span className="font-semibold text-brand">ACP spike</span>
        <span className="flex-1 truncate text-text/60">
          {ready ?? (sessionId ? "aguardando ready…" : "não iniciado")}
        </span>
        <button onClick={() => setOpen(false)} className="text-text/60 hover:text-text">
          ✕
        </button>
      </div>

      {!sessionId ? (
        <div className="flex flex-1 items-center justify-center">
          <button
            onClick={start}
            className="rounded-md bg-brand/20 px-4 py-2 text-brand hover:bg-brand/30"
          >
            Iniciar agente (Claude Code via ACP)
          </button>
        </div>
      ) : (
        <>
          <div className="flex-1 space-y-1 overflow-auto p-2 font-mono">
            {items.map((it, i) => (
              <div key={i} className="whitespace-pre-wrap">
                <span className="text-brand/70">{it.kind}</span>{" "}
                <span className="text-text/90">{it.text}</span>
              </div>
            ))}
          </div>

          {perm && (
            <div className="border-t border-white/10 bg-yellow-500/5 px-2 py-2">
              <div className="mb-1 text-yellow-300">Permissão pedida:</div>
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
                  cancelar
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-1 border-t border-white/10 p-2">
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") send();
              }}
              placeholder="prompt…"
              className="flex-1 rounded bg-black/20 px-2 py-1 text-text outline-none"
            />
            <button
              onClick={send}
              disabled={busy}
              className="rounded bg-brand/20 px-3 py-1 text-brand hover:bg-brand/30 disabled:opacity-40"
            >
              {busy ? "…" : "enviar"}
            </button>
          </div>
        </>
      )}
    </div>
  );
}
