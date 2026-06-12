// src/hooks/useTerminalSession.ts
//
// Hook que orquestra o ciclo de vida de um terminal:
//   1. Cria a sessão PTY no Rust (pty_spawn)
//   2. Conecta xterm.js: stdin (keystrokes) → pty_write
//   3. Conecta xterm.js: pty://output → terminal.write
//   4. Cleanup quando o componente desmonta
//
// Idempotente: chama spawn apenas uma vez por sessionId.
// Trata corretamente Strict Mode do React (double-mount em dev).

import { useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import type { UnlistenFn } from "@tauri-apps/api/event";

import {
  listenAgentStatus,
  listenPtyExit,
  listenPtyOutput,
  ptyKill,
  ptyResize,
  ptySpawn,
  ptyWrite,
} from "@/lib/pty-client";
import { useCanvasStore } from "@/store/canvas-store";
import type { PtySpawnConfig, SessionId } from "@/types/pty";

interface UseTerminalSessionOptions {
  sessionId: SessionId;
  config: PtySpawnConfig;
  onExit?: (code: number | null) => void;
}

interface UseTerminalSessionReturn {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  ready: boolean;
  error: string | null;
  fit: () => void;
  getSelection: () => string;
  /** Mata o PTY atual e re-spawna com a mesma config, sem recriar o xterm.js. */
  reconnect: () => Promise<void>;
}

export function useTerminalSession({
  sessionId,
  config,
  onExit,
}: UseTerminalSessionOptions): UseTerminalSessionReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const setTerminalStatus = useCanvasStore((s) => s.setTerminalStatus);

  useEffect(() => {
    if (!containerRef.current) return;
    if (spawnedRef.current) return; // Strict Mode guard
    spawnedRef.current = true;

    // --- Cria o xterm visual --------------------------------------------
    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.25,
      cursorBlink: true,
      allowProposedApi: true,
      theme: {
        background: "#0a1014",
        foreground: "#edeef0",
        cursor: "#29a2a7",
        cursorAccent: "#0a1014",
        selectionBackground: "#29a2a766",
        black: "#1c1e22",
        red: "#e5484d",
        green: "#46a758",
        yellow: "#f5a623",
        blue: "#3b8bd4",
        magenta: "#9a6dd7",
        cyan: "#29a2a7",
        white: "#b0b4ba",
        brightBlack: "#43464d",
        brightRed: "#ff6369",
        brightGreen: "#5cc173",
        brightYellow: "#ffba38",
        brightBlue: "#5aa0e0",
        brightMagenta: "#b389e4",
        brightCyan: "#36b9bf",
        brightWhite: "#edeef0",
      },
    });

    const fitAddon = new FitAddon();
    const webLinks = new WebLinksAddon();
    term.loadAddon(fitAddon);
    term.loadAddon(webLinks);

    term.open(containerRef.current);
    terminalRef.current = term;
    fitAddonRef.current = fitAddon;
    term.focus();

    // ResizeObserver → fit() sempre que o container mudar de tamanho
    const ro = new ResizeObserver(() => {
      try { fitAddon.fit(); } catch { /* layout ainda não estabilizado */ }
    });
    ro.observe(containerRef.current);

    // --- Listeners cleanup pendentes ------------------------------------
    let unlistenOutput: UnlistenFn | null = null;
    let unlistenStatus: UnlistenFn | null = null;
    let unlistenExit: UnlistenFn | null = null;
    let disposed = false;
    let dataDisposable: { dispose: () => void } | null = null;

    // --- Pipeline assíncrono: fit → spawn → listeners → stdin -----------
    // IMPORTANTE: fit() ANTES do spawn garante que o PTY nasce com as
    // dimensões corretas. Dois rAF deixam o browser pintar o canvas do
    // xterm (cell.width > 0) antes de medirmos cols/rows.
    (async () => {
      try {
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        if (disposed) return;
        try { fitAddon.fit(); } catch { /* container ainda sem dimensões */ }

        const { cols, rows } = term;
        await ptySpawn(sessionId, {
          ...config,
          cols: config.cols ?? cols,
          rows: config.rows ?? rows,
        });

        unlistenOutput = await listenPtyOutput(sessionId, (data) => {
          term.write(data);
        });

        unlistenStatus = await listenAgentStatus(sessionId, (state) => {
          setTerminalStatus(sessionId, state);
        });

        unlistenExit = await listenPtyExit(sessionId, (code) => {
          term.write(
            `\r\n\x1b[2;37m[processo encerrou — código ${code ?? "?"}]\x1b[0m\r\n`,
          );
          setTerminalStatus(sessionId, "dead");
          onExit?.(code);
        });

        // Teclas do usuário → stdin do PTY
        dataDisposable = term.onData((data) => {
          // Não aguardamos: a UI deve ser imediata; erros aparecem nos logs.
          ptyWrite(sessionId, data).catch((e) => {
            console.error("[omni-canvas] pty_write falhou:", e);
          });
        });

        // Reage a resize do xterm
        term.onResize(({ cols: c, rows: r }) => {
          ptyResize(sessionId, c, r).catch((e) => {
            console.error("[omni-canvas] pty_resize falhou:", e);
          });
        });

        if (!disposed) setReady(true);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error("[omni-canvas] falha no spawn:", msg);
        if (!disposed) setError(msg);
      }
    })();

    // --- Cleanup --------------------------------------------------------
    return () => {
      ro.disconnect();
      disposed = true;
      spawnedRef.current = false; // Permite remount (React StrictMode faz double-mount em dev)
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenStatus?.();
      unlistenExit?.();
      // Mata o PTY no Rust — mas não bloqueia o cleanup
      ptyKill(sessionId).catch(() => {
        /* sessão pode já ter morrido */
      });
      term.dispose();
      terminalRef.current = null;
      fitAddonRef.current = null;
    };
    // Spawn é one-shot por sessionId; deps intencionalmente vazias.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  const fit = useCallback(() => {
    try {
      fitAddonRef.current?.fit();
      terminalRef.current?.focus();
    } catch {
      // ResizeObserver pode chamar antes do layout estabilizar; ignorar.
    }
  }, []);

  const getSelection = useCallback(() => {
    return terminalRef.current?.getSelection() ?? "";
  }, []);

  const reconnect = useCallback(async () => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term) return;

    setReady(false);
    setError(null);
    setTerminalStatus(sessionId, "idle");

    term.reset();
    term.write("\r\n\x1b[2;37m[reconectando…]\x1b[0m\r\n");

    try { await ptyKill(sessionId); } catch { /* já morreu */ }

    // Pequeno delay para o Rust liberar a sessão antes de re-spawnar
    await new Promise<void>((r) => setTimeout(r, 200));

    try {
      fitAddon?.fit();
      const { cols, rows } = term;
      await ptySpawn(sessionId, { ...config, cols, rows });
      // Os listeners de output/exit do useEffect continuam ativos
      // e vão capturar os eventos do novo PTY (mesmo sessionId)
      setReady(true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, [sessionId, config, setTerminalStatus]);

  return { containerRef, ready, error, fit, getSelection, reconnect };
}
