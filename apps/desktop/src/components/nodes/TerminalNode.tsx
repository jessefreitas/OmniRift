import { memo, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  Handle,
  NodeResizer,
  Position,
  useStore as useRfStore,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import { Terminal as TerminalIcon, X, Maximize2, Minimize2, RefreshCw, Crown, UserRoundPlus, RotateCw } from "lucide-react";

import { useTerminalSession } from "@/hooks/useTerminalSession";
import { ErrorBoundary } from "@/components/ErrorBoundary";
import { useT } from "@/lib/i18n";
import { useCanvasStore } from "@/store/canvas-store";
import { NodeHelp } from "@/components/NodeHelp";
import { getOrchestratorMount, subscribeOrchestratorMount } from "@/lib/orchestrator-dock-mount";
import { TerminalContextMenu } from "@/components/TerminalContextMenu";
import { StatusDot } from "@/components/StatusDot";
import { useProcInfo } from "@/hooks/useProcInfo";
import { ptyWrite } from "@/lib/pty-client";
import { copyText, pasteText, readClipboardPng, savePastePng, MAX_PASTE_BYTES, utf8ByteLength } from "@/lib/clipboard";
import { compressorSavings, isCompressorEnabled, type SavingsReport } from "@/lib/compress-client";
import { CLI_CATALOG } from "@/lib/clis-client";
import { cn } from "@/lib/cn";
import type { TerminalNode as TerminalNodeData } from "@/types/canvas";

import "@xterm/xterm/css/xterm.css";

// Nó React Flow tipado para terminal. A interseção com Record<string, unknown>
// satisfaz a constraint do React Flow v12 (Node<data extends Record<...>>) sem
// perder os campos tipados de TerminalNodeData.
type TerminalRfNode = Node<TerminalNodeData & Record<string, unknown>, "terminal">;

type TerminalNodeProps = NodeProps<TerminalRfNode>;

/** Formata contagem de tokens compacta: 4321 → "4.3k", 1_200_000 → "1.2M". */
function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

/** Identidade do CLI (emoji + nome do catálogo) inferida pelo comando spawnado
 *  (claude/codex/gemini…). `null` = comando desconhecido → ícone genérico no header. */
function cliMeta(command: string): { emoji: string; label: string } | null {
  const c = command.toLowerCase();
  const hit = CLI_CATALOG.find((x) => new RegExp(`\\b${x.id}\\b`).test(c));
  return hit ? { emoji: hit.emoji, label: hit.label } : null;
}

/** Tempo de sessão compacto: "agora", "12min", "2h5min". */
function formatAge(ms: number): string {
  const min = Math.floor(ms / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `${min}min`;
  const h = Math.floor(min / 60);
  const rem = min % 60;
  return rem ? `${h}h${rem}min` : `${h}h`;
}

function TerminalNodeBase({ id, data, selected }: TerminalNodeProps) {
  const t = useT();
  const removeNode = useCanvasStore((s) => s.removeNode);
  const renameNode = useCanvasStore((s) => s.renameNode);
  const openConnectMenu = useCanvasStore((s) => s.openConnectMenu);
  const addToClipboard = useCanvasStore((s) => s.addToClipboard);
  // Subagentes plugados NESTE terminal (canvas: subagent-nodes com parentAgentId = seu id).
  const mySubagentLabels = useCanvasStore((s) => {
    const f = s.parallels.find((p) => p.id === s.activeParallelId);
    return (f?.nodes ?? [])
      .filter((n) => n.kind === "subagent" && n.parentAgentId === id)
      .map((n) => (n.kind === "subagent" ? n.label : ""))
      .join(", ");
  });
  const termStatus = useCanvasStore((s) => s.terminalStatuses[data.session_id] ?? "idle");
  const proc = useProcInfo(data.session_id, termStatus !== "dead");
  const orchestratorSid = useCanvasStore((s) => s.orchestratorSid);
  const isOrch = orchestratorSid === data.session_id;
  // Orquestrador no floor ATIVO → terminal vive no próprio node; noutro floor → dock.
  // Selector devolve boolean → só re-renderiza quando o estado realmente vira.
  const orchOnActiveFloor = useCanvasStore((s) => {
    if (s.orchestratorSid !== data.session_id) return true;
    const f = s.parallels.find((fl) => fl.nodes.some((n) => n.kind === "terminal" && n.session_id === s.orchestratorSid));
    return !f || f.id === s.activeParallelId;
  });

  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(data.label ?? data.command);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  // handles de resize aparecem ao selecionar OU passar o mouse (descobribilidade)
  const [hovered, setHovered] = useState(false);
  const [inViewport, setInViewport] = useState(true);
  // LOD por zoom: abaixo de 35% o conteúdo do xterm é ilegível — esconde o paint (o PTY e o
  // buffer seguem vivos) e mostra o label grande pra navegação. Selector BOOLEANO: o nó só
  // re-renderiza ao cruzar o limiar, não a cada tick de zoom.
  const lodOut = useRfStore((s) => s.transform[2] < 0.35);
  const [dragOver, setDragOver] = useState(false);
  // Economia do OmniCompress (badge "▼ X% · Yk tok"). Só quando o nativo está ligado.
  const [savings, setSavings] = useState<SavingsReport | null>(null);
  // Identidade do CLI (emoji + nome do catálogo) pro header + tick do tempo de sessão.
  const meta = cliMeta(data.command);
  const [, setAgeTick] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const homeSlotRef = useRef<HTMLDivElement | null>(null);
  const fullscreenSlotRef = useRef<HTMLDivElement | null>(null);
  const nodeWrapRef = useRef<HTMLDivElement>(null);

  const { containerRef, ready, error, fit, getSelection, writeNotice, reconnect, setActive } =
    useTerminalSession({
      sessionId: data.session_id,
      config: {
        command: data.command,
        args: data.args,
        cwd: data.cwd,
        env: data.env,
        // Onde executa (ref §3.1). undefined = local; "ssh:<host>" → o backend
        // embrulha em ssh. snake_case: é o que o Rust desserializa.
        execution_host: data.executionHost,
        // Attach (Fase 2 do #8): true quando o PTY já nasceu no backend (CLI
        // `omnirift spawn` → `rpc://agent-spawned`). O hook anexa em vez de spawnar.
        attach: data.attach,
      },
      // Ctrl+V no terminal reutiliza o MESMO handler do menu de contexto (texto →
      // senão imagem→caminho). Antes o Ctrl+V só colava texto; imagem (print) sumia.
      onPaste: handlePaste,
    });

  // Fit quando o nó é redimensionado externamente
  useEffect(() => {
    const tid = window.setTimeout(fit, 50);
    return () => window.clearTimeout(tid);
  }, [data.size?.width, data.size?.height, fit]);

  // Wake do Orquestrador (tool agent_wake → canvas://agent-wake → CustomEvent, task #10):
  // o reconnect() do useTerminalSession não é acessível de fora do node, então o
  // orchestration-client repassa via window e ESTE node re-spawna quando o sessionId
  // bate (mesmo command/args/env — a persona do role vive nos args). Padrão igual ao
  // listener de omnirift:mcp-remapped no Sidebar.
  useEffect(() => {
    const onWake = (e: Event) => {
      const sid = (e as CustomEvent<{ sessionId?: string }>).detail?.sessionId;
      if (sid === data.session_id) void reconnect();
    };
    window.addEventListener("omnirift:agent-wake", onWake);
    return () => window.removeEventListener("omnirift:agent-wake", onWake);
  }, [data.session_id, reconnect]);

  // Tempo de sessão: re-render leve a cada 30s só pra atualizar o "há Xmin".
  useEffect(() => {
    if (!data.createdAt) return;
    const iv = window.setInterval(() => setAgeTick((n) => n + 1), 30000);
    return () => window.clearInterval(iv);
  }, [data.createdAt]);

  // Foca o input quando entra em modo de edição
  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  // IntersectionObserver: esconde o canvas xterm quando o nó sai do viewport
  // (visibility:hidden preserva layout e para GPU compositing sem desmontar o xterm)
  useEffect(() => {
    const el = nodeWrapRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => {
        const visible = entry.isIntersecting;
        setInViewport(visible);
        if (visible) setTimeout(fit, 50);
      },
      { rootMargin: "200px" }, // pré-carrega 200px antes de entrar
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [fit]);

  // Scheduler de saída backend-owned (ref P0 #2): foreground (escreve ao vivo) quando
  // o terminal está realmente visível — no viewport, OU em fullscreen, OU é o
  // Orquestrador (que fica visível no dock mesmo fora do viewport). Caso contrário,
  // background → a saída é enfileirada/dropada e re-hidratada via snapshot no retorno.
  // Espelha a mesma condição do `visibility` do container do xterm abaixo.
  useEffect(() => {
    setActive(isFullscreen || isOrch || inViewport);
  }, [isFullscreen, isOrch, inViewport, setActive]);

  // ESC fecha o fullscreen + context menu via DOM nativo no canvas movido
  useEffect(() => {
    if (!isFullscreen) return;
    function handleKey(e: KeyboardEvent) {
      if (e.key === "Escape") setIsFullscreen(false);
    }
    function handleCtxMenu(e: MouseEvent) {
      e.preventDefault();
      setContextMenu({ x: e.clientX, y: e.clientY });
    }
    window.addEventListener("keydown", handleKey);
    // containerRef foi movido via appendChild para fora do React tree —
    // precisa de listener DOM nativo para capturar contextmenu
    containerRef.current?.addEventListener("contextmenu", handleCtxMenu);
    return () => {
      window.removeEventListener("keydown", handleKey);
      containerRef.current?.removeEventListener("contextmenu", handleCtxMenu);
    };
  }, [isFullscreen, containerRef]);

  // Badge de economia do OmniCompress: poll leve (18s) do /stats do proxy, só
  // quando o nativo está ligado e o node está vivo + visível (não desperdiça em
  // node oculto/morto). `null` (proxy fora do ar / sem /stats) → badge some.
  useEffect(() => {
    if (!isCompressorEnabled("omnicompress") || termStatus === "dead" || !inViewport) {
      setSavings(null);
      return;
    }
    let alive = true;
    const tick = () => {
      void compressorSavings().then((r) => {
        if (alive) setSavings(r);
      });
    };
    tick(); // fetch imediato ao montar/focar
    const iv = window.setInterval(tick, 18_000);
    return () => {
      alive = false;
      window.clearInterval(iv);
    };
  }, [termStatus, inViewport]);

  function commitRename() {
    const label = draft.trim() || data.command;
    renameNode(id, label);
    setDraft(label);
    setEditing(false);
  }

  // Coloca o xterm no destino certo, por prioridade: fullscreen > dock (se for o
  // Orquestrador) > slot do próprio nó. Move o ELEMENTO (appendChild) — nunca
  // re-cria nem re-spawna: mesmo xterm, mesma sessão, pixel-perfect.
  const place = useCallback(() => {
    const host = containerRef.current;
    if (!host) return;
    let target: HTMLElement | null = null;
    if (isFullscreen) target = fullscreenSlotRef.current;
    else if (isOrch && !orchOnActiveFloor) target = getOrchestratorMount();
    if (!target) target = homeSlotRef.current;
    if (target && host.parentElement !== target) {
      target.appendChild(host);
      setTimeout(fit, 50);
    }
  }, [isFullscreen, isOrch, orchOnActiveFloor, fit, containerRef]);

  useEffect(() => { place(); }, [place]);
  useEffect(() => subscribeOrchestratorMount(place), [place]);

  // Antes do unmount, devolve o xterm pro slot do nó — senão o React tenta
  // remover uma subtree cujo elemento está relocado (dock/fullscreen) e quebra.
  useEffect(() => {
    return () => {
      const host = containerRef.current;
      if (host && homeSlotRef.current && host.parentElement !== homeSlotRef.current) {
        homeSlotRef.current.appendChild(host);
      }
    };
  }, [containerRef]);

  // --- Context menu handlers -------------------------------------------

  function handleContextMenu(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setContextMenu({ x: e.clientX, y: e.clientY });
  }

  async function handleCopy() {
    const sel = getSelection();
    if (sel) await copyText(sel);
  }

  async function handlePaste() {
    const text = await pasteText();
    if (text) {
      // Guard: texto acima do teto do IPC estouraria o invoke do pty_write. Avisa
      // no terminal em vez de crashar (o usuário cola menos / via arquivo).
      const bytes = utf8ByteLength(text);
      if (bytes > MAX_PASTE_BYTES) {
        writeNotice(`[colar cancelado] texto ~${Math.round(bytes / 1024 / 1024)} MB excede o limite de ${Math.round(MAX_PASTE_BYTES / 1024 / 1024)} MB do IPC.`);
        return;
      }
      await ptyWrite(data.session_id, text);
      return;
    }
    // Sem texto no clipboard → tenta imagem (Ctrl+V de print): salva em PNG temp e
    // insere o caminho no stdin, igual ao file-drop (claude-code recebe `@caminho`).
    const png = await readClipboardPng();
    if (!png) return;
    // Os bytes viram array JSON no invoke (~4× inflado) → barra o que estouraria o
    // IPC. Salve e arraste o arquivo pro terminal nesse caso.
    if (png.byteLength * 4 > MAX_PASTE_BYTES) {
      writeNotice(`[colar cancelado] imagem ~${Math.round(png.byteLength / 1024 / 1024)} MB grande demais pro IPC. Salve e arraste o arquivo pro terminal.`);
      return;
    }
    const path = await savePastePng(png);
    let rel = path;
    if (data.cwd && path.startsWith(data.cwd + "/")) rel = path.slice(data.cwd.length + 1);
    const insert = data.role === "claude-code" ? `@${rel}` : /\s/.test(rel) ? `"${rel}"` : rel;
    await ptyWrite(data.session_id, insert + " ");
  }

  async function handleCopyAndSave() {
    const sel = getSelection();
    if (sel) {
      await copyText(sel);
      addToClipboard(sel);
    }
  }

  // Solta um arquivo da árvore (ou do SO) → insere o caminho no stdin do agente.
  // claude-code recebe como referência `@caminho`; os demais, o caminho cru.
  function handleFileDrop(e: React.DragEvent) {
    e.preventDefault();
    setDragOver(false);
    const path =
      e.dataTransfer.getData("application/x-omnirift-path") || e.dataTransfer.getData("text/plain");
    if (!path) return;
    let rel = path;
    if (data.cwd && path.startsWith(data.cwd + "/")) rel = path.slice(data.cwd.length + 1);
    const insert = data.role === "claude-code" ? `@${rel}` : /\s/.test(rel) ? `"${rel}"` : rel;
    ptyWrite(data.session_id, insert + " ").catch(() => {});
  }

  // --- Fullscreen portal -----------------------------------------------

  const fullscreenPortal = isFullscreen
    ? createPortal(
        <div
          className="fixed inset-0 z-[9999] bg-surface1 flex flex-col"
          onContextMenu={handleContextMenu}
        >
          {/* Header fullscreen — mesmos badges do header normal (chip do CLI,
              ⏱ sessão, ⚡compressor, ▼savings, 💾 RSS); sumir tudo na tela cheia
              era regressão visual reportada ("pq isso some"). */}
          <header className="flex items-center gap-2 px-4 py-2 bg-surface2 border-b border-border text-textMuted shrink-0">
            {meta ? (
              <span className="text-sm leading-none shrink-0" title={meta.label}>
                {meta.emoji}
              </span>
            ) : (
              <TerminalIcon size={14} className="text-brand shrink-0" />
            )}
            <span className="text-xs font-medium truncate flex-1">
              {data.label ?? data.command}
            </span>

            {/* Identidade do CLI (nome do catálogo); cai pro role cru se desconhecido. */}
            <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/10 text-brand/90 truncate shrink-0 max-w-[120px]">
              {meta?.label ?? data.role}
            </span>

            {/* Tempo de sessão — fail-soft: some sem createdAt (nodes antigos). */}
            {data.createdAt && (
              <span
                className="text-[9px] font-mono tabular-nums px-1 rounded bg-green-500/10 text-green-400/90 shrink-0"
                title={t("terminal.sessionTime", "Tempo de sessão")}
              >
                ⏱ {formatAge(Date.now() - data.createdAt)}
              </span>
            )}

            {data.compressor && (
              <span
                title={`Compressor de token ativo: ${data.compressor.toUpperCase()} (decora só env no spawn)`}
                className="text-[8px] uppercase tracking-wide px-1 rounded bg-brand/15 text-brand shrink-0"
              >
                ⚡{data.compressor}
              </span>
            )}

            {/* Economia REAL do OmniCompress — some quando o proxy não responde (fail-open). */}
            {savings && savings.tokensBefore > 0 && (
              <span
                title={`OmniCompress: ${savings.tokensBefore.toLocaleString()} → ${savings.tokensAfter.toLocaleString()} tokens (${(savings.tokensBefore - savings.tokensAfter).toLocaleString()} economizados)`}
                className="text-[9px] font-mono tabular-nums px-1 rounded bg-green-500/15 text-green-400 shrink-0"
              >
                ▼{savings.pct.toFixed(0)}% · {formatTokens(savings.tokensBefore - savings.tokensAfter)} tok
              </span>
            )}

            {/* RSS do processo (PID no tooltip). */}
            {proc?.alive && (
              <span
                className="text-[9px] font-mono tabular-nums px-1 rounded bg-textMuted/10 text-textMuted shrink-0"
                title={`PID ${proc.pid} · ${(proc.rssKb / 1024).toFixed(1)} MB RSS`}
              >
                💾 {(proc.rssKb / 1024).toFixed(0)}M
              </span>
            )}

            <button
              onClick={() => setIsFullscreen(false)}
              className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
              aria-label={t("terminal.exitFullscreen", "Sair da tela cheia")}
            >
              <Minimize2 size={14} />
            </button>
          </header>

          {/* Container do xterm em fullscreen */}
          <div className="relative flex-1 bg-bg">
            <div
              ref={fullscreenSlotRef}
              className="terminal nowheel absolute inset-0"
              onPointerDown={(e) => e.stopPropagation()}
            />
          </div>
        </div>,
        document.body,
      )
    : null;

  // --- Render principal -------------------------------------------------

  return (
    <>
      <div
        ref={nodeWrapRef}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
        className={cn(
          "flex flex-col rounded-lg border bg-surface1 overflow-hidden shadow-lg",
          "transition-colors",
          selected ? "border-brand" : "border-border",
        )}
        style={{
          width: data.size?.width ?? 520,
          height: data.size?.height ?? 320,
        }}
      >
        <NodeResizer
          isVisible={selected || hovered}
          minWidth={320}
          minHeight={200}
          color="rgb(41 162 167)"
          handleStyle={{ width: 8, height: 8, borderRadius: 2 }}
        />

        <Handle
          type="target"
          position={Position.Left}
          className="!bg-brand !border-surface1"
        />
        <Handle
          type="source"
          position={Position.Right}
          className="!bg-brand !border-surface1"
        />
        {/* Alça de baixo = SUBAGENTE privado (.claude/agents); a da direita = time/par. */}
        <Handle
          type="source"
          id="subagent"
          position={Position.Bottom}
          className="!bg-amber-400 !border-surface1"
        />

        <header
          className={cn(
            "node-drag-handle flex items-center gap-2 px-3 py-2",
            "bg-surface2 border-b border-border text-textMuted cursor-grab",
            "active:cursor-grabbing select-none",
          )}
          onDoubleClick={(e) => {
            const el = e.target as HTMLElement;
            if (el.closest("button,input,textarea,select,a")) return;
            setIsFullscreen(true);
          }}
        >
          {meta ? (
            <span className="text-sm leading-none shrink-0" title={meta.label}>
              {meta.emoji}
            </span>
          ) : (
            <TerminalIcon size={14} className="text-brand shrink-0" />
          )}
          <StatusDot status={termStatus} />

          {editing ? (
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === "Enter") commitRename();
                if (e.key === "Escape") {
                  setDraft(data.label ?? data.command);
                  setEditing(false);
                }
                e.stopPropagation();
              }}
              onClick={(e) => e.stopPropagation()}
              className="flex-1 bg-bg border border-brand rounded px-1 text-xs text-text focus:outline-none"
            />
          ) : (
            <span
              className="text-xs font-medium truncate flex-1 cursor-text"
              onDoubleClick={(e) => {
                e.stopPropagation();
                setEditing(true);
              }}
              title={t("terminal.doubleClickRename", "Duplo-clique para renomear")}
            >
              {data.label ?? data.command}
            </span>
          )}

          {/* Identidade do CLI (nome do catálogo) como badge; cai pro role cru se desconhecido. */}
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-brand/10 text-brand/90 truncate shrink-0 max-w-[120px]">
            {meta?.label ?? data.role}
          </span>

          {/* Tempo de sessão — fail-soft: some sem createdAt (nodes antigos). */}
          {data.createdAt && (
            <span
              className="text-[9px] font-mono tabular-nums px-1 rounded bg-green-500/10 text-green-400/90 shrink-0"
              title={t("terminal.sessionTime", "Tempo de sessão")}
            >
              ⏱ {formatAge(Date.now() - data.createdAt)}
            </span>
          )}

          {data.compressor && (
            <span
              title={`Compressor de token ativo: ${data.compressor.toUpperCase()} (decora só env no spawn)`}
              className="text-[8px] uppercase tracking-wide px-1 rounded bg-brand/15 text-brand shrink-0"
            >
              ⚡{data.compressor}
            </span>
          )}

          {/* Economia REAL do OmniCompress (vinda do /stats do proxy). Some quando
              o proxy não responde (savings === null) — fail-open, não quebra a UI. */}
          {savings && savings.tokensBefore > 0 && (
            <span
              title={`OmniCompress: ${savings.tokensBefore.toLocaleString()} → ${savings.tokensAfter.toLocaleString()} tokens (${(savings.tokensBefore - savings.tokensAfter).toLocaleString()} economizados)`}
              className="text-[9px] font-mono tabular-nums px-1 rounded bg-green-500/15 text-green-400 shrink-0"
            >
              ▼{savings.pct.toFixed(0)}% · {formatTokens(savings.tokensBefore - savings.tokensAfter)} tok
            </span>
          )}

          {/* Process mgmt: RSS do processo (PID no tooltip). */}
          {proc?.alive && (
            <span
              className="text-[9px] font-mono tabular-nums px-1 rounded bg-textMuted/10 text-textMuted shrink-0"
              title={`PID ${proc.pid} · ${(proc.rssKb / 1024).toFixed(1)} MB RSS`}
            >
              💾 {(proc.rssKb / 1024).toFixed(0)}M
            </span>
          )}

          {/* Reload SEMPRE visível: re-spawna o CLI com o MESMO command/args/env — a persona
              do role vive nos args (--append-system-prompt), então o papel sobrevive por
              construção. Morto = verde chamativo; vivo = discreto (mata e sobe de novo). */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              reconnect();
            }}
            className={cn(
              "p-1 rounded hover:bg-bg transition-colors",
              termStatus === "dead" ? "text-green-400 hover:text-green-300" : "text-text/50 hover:text-green-400",
            )}
            aria-label={t("terminal.reconnectTerminal", "Reconectar terminal")}
            title={t("terminal.reloadKeepPersona", "Reload do agente (re-spawn; mantém a persona do role — ela vai nos args)")}
          >
            <RefreshCw size={12} />
          </button>

          {/* Recarregar subagentes MANTENDO a conversa: reinicia o claude com --continue
              (resume a sessão) → relê ~/.claude/agents no boot, pega subagentes criados
              DEPOIS, e retoma a conversa de onde estava. */}
          {data.role === "claude-code" && mySubagentLabels && (
            <button
              onClick={(e) => { e.stopPropagation(); void reconnect(["--continue"]); }}
              className="p-1 rounded hover:bg-bg hover:text-amber-300 transition-colors"
              title={t("terminal.reloadSubagents", "Recarregar subagentes ({list}) mantendo a conversa (claude --continue: relê .claude/agents e retoma a sessão)").replace("{list}", mySubagentLabels)}
              aria-label={t("terminal.reloadSubagentsShort", "Recarregar subagentes")}
            >
              <RotateCw size={12} />
            </button>
          )}
          {/* Plugar subagente nativo (só Claude Code: o .claude/agents é dele). */}
          {data.role === "claude-code" && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                openConnectMenu({
                  fromNodeId: id,
                  flow: { x: (data.position?.x ?? 0) + 24, y: (data.position?.y ?? 0) + (data.size?.height ?? 320) + 48 },
                  screen: { x: e.clientX, y: e.clientY },
                  mode: "subagent",
                });
              }}
              className="p-1 rounded hover:bg-bg hover:text-amber-300 transition-colors"
              title={t("terminal.addSubagent", "Plugar subagente (privado deste agente)")}
              aria-label={t("terminal.addSubagent", "Plugar subagente")}
            >
              <UserRoundPlus size={12} />
            </button>
          )}
          <NodeHelp text={t("terminal.help", "Terminal/agente: digite normalmente. Duplo-clique no nome pra renomear; no resto do header, abre em tela cheia. Ligue a saída deste node na entrada de outro pelas alças laterais (pipe A→B). ⤢ abre em tela cheia; ⟳ reconecta se o processo morrer. A alça de baixo (ou +) pluga um SUBAGENTE privado.")} />
          {/* Botão maximizar */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              setIsFullscreen(true);
            }}
            className="p-1 rounded hover:bg-bg hover:text-text transition-colors"
            aria-label={t("terminal.fullscreen", "Tela cheia")}
          >
            <Maximize2 size={12} />
          </button>

          {/* Botão fechar */}
          <button
            onClick={(e) => {
              e.stopPropagation();
              removeNode(id);
            }}
            className="p-1 rounded hover:bg-bg hover:text-danger transition-colors"
            aria-label={t("terminal.closeTerminal", "Fechar terminal")}
          >
            <X size={12} />
          </button>
        </header>

        <div
          ref={homeSlotRef}
          className={cn("relative flex-1 bg-bg", dragOver && "ring-2 ring-brand ring-inset")}
          onContextMenu={handleContextMenu}
          onDragOver={(e) => { e.preventDefault(); e.dataTransfer.dropEffect = "copy"; if (!dragOver) setDragOver(true); }}
          onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as globalThis.Node | null)) setDragOver(false); }}
          onDrop={handleFileDrop}
        >
          <div
            ref={containerRef}
            className="terminal nowheel absolute inset-0"
            style={{ visibility: isOrch || isFullscreen || (inViewport && !lodOut) ? "visible" : "hidden" }}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={fit}
          />
          {/* LOD: em zoom baixo o xterm some (paint caro à toa) e o label grande orienta. */}
          {lodOut && !isFullscreen && !isOrch && (
            <div className="absolute inset-0 flex items-center justify-center bg-bg pointer-events-none select-none">
              <span className="max-w-full truncate px-4 text-2xl font-semibold text-text/40">{data.label ?? data.command}</span>
            </div>
          )}

          {!ready && !error && (
            <div className="absolute inset-0 flex items-center justify-center text-textMuted text-xs pointer-events-none">
              {t("terminal.starting", "iniciando")} {data.command}...
            </div>
          )}
          {error && (
            <div className="absolute inset-0 flex items-center justify-center text-danger text-xs px-4 text-center pointer-events-none">
              {t("terminal.startFailed", "falha ao iniciar")}: {error}
            </div>
          )}
          {/* Orquestrador num OUTRO floor: o xterm está no dock — aqui mostra o aviso.
              No floor dele, o terminal vive aqui no node (sem dock). */}
          {isOrch && !isFullscreen && !orchOnActiveFloor && (
            <div className="absolute inset-0 flex items-center justify-center gap-1.5 bg-bg text-textMuted text-xs pointer-events-none">
              <Crown size={13} className="text-yellow-500" /> {t("terminal.runningInDock", "rodando no dock (você está em outro paralelo) ↗")}
            </div>
          )}
          {/* Feedback ao arrastar um arquivo da árvore por cima. */}
          {dragOver && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-brand/10 text-brand text-xs font-medium pointer-events-none">
              {t("terminal.dropToInsertPath", "soltar para inserir o caminho")}
            </div>
          )}
        </div>
      </div>

      {/* Portal fullscreen */}
      {fullscreenPortal}

      {/* Context menu customizado */}
      {contextMenu && (
        <TerminalContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          onClose={() => setContextMenu(null)}
          onCopy={handleCopy}
          onPaste={handlePaste}
          onCopyAndSave={handleCopyAndSave}
          onFullscreen={() => setIsFullscreen(true)}
          onSendToTurbo={() => {
            // Seleção do terminal → semeia o objetivo do TURBO (vazio = abre p/ preencher).
            const goal = getSelection().trim();
            window.dispatchEvent(new CustomEvent("omnirift:turbo-seed", { detail: { goal } }));
          }}
          onCloseTerminal={() => removeNode(id)}
        />
      )}
    </>
  );
}

// memo: o terminal é o node mais pesado — evita re-render quando outro node muda.
/** Card LEVE do terminal DORMENTE (restaurado, processo não religado). NÃO monta
 *  `useTerminalSession` → nenhum PTY/claude nasce. Mantém os Handles pras conexões e o
 *  header arrastável; o botão central religa sob demanda (`wakeTerminal` limpa `dormant`,
 *  o wrapper passa a renderizar o `TerminalNodeBase`, que aí sim spawna). É o que faz abrir
 *  um projeto com N agentes NÃO acordar N processos de uma vez. */
function DormantTerminalCard({ id, data, selected }: TerminalNodeProps) {
  const wakeTerminal = useCanvasStore((s) => s.wakeTerminal);
  const removeNode = useCanvasStore((s) => s.removeNode);
  return (
    <div
      className={cn(
        "flex h-full w-full flex-col overflow-hidden rounded-lg border bg-bg",
        selected ? "border-brand" : "border-border/60",
      )}
    >
      <Handle type="target" position={Position.Left} className="!bg-brand !border-surface1" />
      <Handle type="source" position={Position.Right} className="!bg-brand !border-surface1" />
      <Handle type="source" id="subagent" position={Position.Bottom} className="!bg-amber-400 !border-surface1" />
      <header className="node-drag-handle flex items-center gap-2 px-3 py-2 bg-surface2 border-b border-border text-textMuted cursor-grab active:cursor-grabbing select-none">
        <span className="text-sm leading-none shrink-0">💤</span>
        <span className="flex-1 truncate text-sm font-medium">{data.label ?? data.command}</span>
        {/* Deletar o agente SUSPENSO: dormant não tem processo vivo (nunca spawnou o PTY),
            então remove só o node — direto, sem confirmação. Faltava o X aqui. */}
        <button
          onClick={(e) => { e.stopPropagation(); removeNode(id); }}
          className="p-1 rounded hover:bg-bg hover:text-danger transition-colors shrink-0"
          aria-label="Deletar agente suspenso"
          title="Deletar (o agente está suspenso — nada está rodando)"
        >
          <X size={12} />
        </button>
      </header>
      <button
        onClick={() => wakeTerminal(id)}
        title="Religar o agente (sobe o processo sob demanda)"
        className="flex flex-1 flex-col items-center justify-center gap-1.5 text-textMuted hover:text-brand transition-colors"
      >
        <span className="text-3xl">💤</span>
        <span className="text-xs font-medium">Dormindo — clique pra acordar</span>
        <span className="text-[10px] opacity-60">{data.role}</span>
      </button>
    </div>
  );
}

/** Fallback quando o TerminalNodeBase estoura no render (ex.: race do addon-webgl no
 *  dispose → `_core._store._isDisposed`). ISOLADO por node: o app/canvas fica de pé; só
 *  ESTE terminal mostra o aviso. "Recarregar" remonta o boundary (novo resetKey) → o
 *  terminal tenta de novo. A causa já foi gravada em ~/.omnirift/debug.log. */
function TerminalCrashCard({ label, onReload }: { label: string; onReload: () => void }) {
  return (
    <div className="flex h-full w-full flex-col items-center justify-center gap-2 rounded-lg border border-danger/40 bg-bg p-4 text-center">
      <span className="text-2xl">⚠️</span>
      <span className="text-xs font-medium text-danger">Este terminal travou ao renderizar</span>
      <span className="max-w-full truncate text-[10px] text-textMuted">{label}</span>
      <span className="text-[10px] text-textMuted opacity-70">Causa gravada em ~/.omnirift/debug.log</span>
      <button
        onClick={onReload}
        className="mt-1 flex items-center gap-1 rounded border border-border px-3 py-1 text-xs text-text hover:border-brand hover:text-brand"
      >
        <RefreshCw size={12} /> Recarregar
      </button>
    </div>
  );
}

/** Restaurado DORMENTE → card leve (sem sessão); senão o terminal vivo (num ErrorBoundary
 *  próprio pra a falha ficar contida no node, nunca derrubar o canvas). O split garante que
 *  o `useTerminalSession` (e o spawn do PTY) só monta quando o nó NÃO está dormente. */
export const TerminalNode = memo(function TerminalNode(props: TerminalNodeProps) {
  const [resetKey, setResetKey] = useState(0);
  if (props.data.dormant) return <DormantTerminalCard {...props} />;
  return (
    <ErrorBoundary
      key={resetKey}
      label="TerminalNode"
      fallback={
        <TerminalCrashCard
          label={props.data.label ?? props.data.command}
          onReload={() => setResetKey((k) => k + 1)}
        />
      }
    >
      <TerminalNodeBase {...props} />
    </ErrorBoundary>
  );
});
