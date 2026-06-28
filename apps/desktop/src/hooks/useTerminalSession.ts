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
import { emit } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import {
  listenAgentStatus,
  listenPtyExit,
  listenPtyOutput,
  ptyKill,
  ptyResize,
  ptySnapshot,
  ptySpawn,
  ptyWrite,
} from "@/lib/pty-client";
import { useCanvasStore } from "@/store/canvas-store";
import { sessionStart, sessionEvent, sessionEnd } from "@/lib/session-client";
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
  /**
   * Liga (foreground) / desliga (background) a escrita ao vivo no xterm (ref P0 #2).
   * O `TerminalNode` chama com o `inViewport`/visibilidade. Em background a saída é
   * enfileirada com cap; estourando o cap, dropa a fila + marca stale → no retorno a
   * foreground re-hidrata via `pty_snapshot` (em vez de reter MB que crashariam).
   */
  setActive: (visible: boolean) => void;
}

/**
 * Cap do buffer de saída em background (chars). Acima disso, o backlog é DESCARTADO e
 * a view marcada stale — o snapshot do backend re-hidrata no retorno. É o que mata o
 * crash: um agente barulhento + nó oculto não pode mais reter MB no renderer.
 */
const MAX_BG_CHARS = 2 * 1024 * 1024;

export function useTerminalSession({
  sessionId,
  config,
  onExit,
}: UseTerminalSessionOptions): UseTerminalSessionReturn {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const spawnedRef = useRef(false);
  // Session recorder: último estado logado + guarda pra encerrar só uma vez.
  const lastStateRef = useRef<string | null>(null);
  const sessionEndedRef = useRef(false);

  // --- Output scheduler (ref P0 #2) -----------------------------------
  // foreground (visível) escreve ao vivo; background enfileira com cap.
  const activeRef = useRef(true);
  // Backlog de background: chunks pendentes + contagem de chars (pro cap).
  const bgQueueRef = useRef<string[]>([]);
  const bgQueueCharsRef = useRef(0);
  // View "stale": o backlog estourou o cap e foi descartado → precisa re-hidratar
  // via snapshot no próximo retorno a foreground.
  const staleRef = useRef(false);
  // Dedup por seq: último seq aplicado (do snapshot OU do último write ao vivo). Live
  // com `seq <= lastSeqRef` é descartado (mata o scrollback dobrado). -1 = nada aplicado
  // ainda (antes de qualquer snapshot, nada é dropado).
  const lastSeqRef = useRef(-1);
  // Durante o await do `pty_snapshot`, os chunks ao vivo que chegarem são bufferizados
  // aqui e reaplicados (com o mesmo filtro de seq) quando o snapshot resolver.
  const snapshotInFlightRef = useRef(false);
  const pendingDuringSnapshotRef = useRef<Array<{ data: string; seq: number | undefined }>>([]);
  // [GLM-audit] reconnect: ignora o exit do PTY morto no reconnect; aborta o re-spawn se desmontou.
  const reconnectingRef = useRef(false);
  const disposedRef = useRef(false);
  // Ponte pro `applyChunk` (definido dentro do effect, onde o `term` está em escopo):
  // o `setActive`/replay (fora do effect) reutilizam o MESMO caminho de aplicação.
  const applyChunkRef = useRef<((data: string, seq: number | undefined) => void) | null>(null);

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
    // Links clicáveis: handler abre no SO via plugin-shell (window.open não
    // funciona no WebKitGTK) + regex que inclui file:// além de http(s) — o
    // default do addon só pega http(s). O addon acrescenta a flag 'g' sozinho.
    const webLinks = new WebLinksAddon(
      (_event, uri) => {
        // Defense-in-depth: o scope do plugin-shell já valida, mas aqui barramos
        // URIs longas ou de esquema inesperado antes de pedir abertura ao SO.
        if (uri.length > 2048 || !/^(https?:\/\/|file:\/\/\/)/.test(uri)) return;
        void openExternal(uri).catch((e) => console.warn("[terminal] abrir link falhou:", e));
      },
      // Classe negada + quantificador LIMITADO ({1,2048}) — tempo linear, sem
      // backtracking catastrófico. Inclui file:// além do http(s) do default.
      { urlRegex: /(https?:\/\/|file:\/\/)[^\s"'<>)\]]{1,2048}/ },
    );
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
    disposedRef.current = false; // reset no (re)mount [GLM-audit #3]
    let dataDisposable: { dispose: () => void } | null = null;
    let disposeImeGuard: (() => void) | null = null;

    // --- Pipeline assíncrono: fit → spawn → listeners → stdin -----------
    // IMPORTANTE: fit() ANTES do spawn garante que o PTY nasce com as
    // dimensões corretas. Dois rAF deixam o browser pintar o canvas do
    // xterm (cell.width > 0) antes de medirmos cols/rows.
    (async () => {
      try {
        await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
        if (disposed) return;
        try { fitAddon.fit(); } catch { /* container ainda sem dimensões */ }

        const { cols, rows } = term;
        // Attach (Fase 2 do #8): o PTY desta sessão JÁ nasceu no backend (CLI
        // `omnirift spawn` → `agent.spawn`). PULAMOS o `ptySpawn` — re-spawnar
        // criaria um 2º processo e mataria o estado vivo. O resto (session
        // recorder, listeners, stdin, resize) é IDÊNTICO ao spawn normal; a view é
        // re-hidratada via `replayFromSnapshot` (mesmo caminho do retorno-de-oculto
        // do #6) logo após os listeners estarem montados. Sem attach → spawn normal
        // intocado.
        if (!config.attach) {
          await ptySpawn(sessionId, {
            ...config,
            cols: config.cols ?? cols,
            rows: config.rows ?? rows,
          });
        } else {
          // Ajusta o PTY existente às dimensões reais deste xterm (o backend nasceu
          // em 80×24 no agent.spawn). Fire-and-forget — falha não bloqueia o attach.
          ptyResize(sessionId, cols, rows).catch(() => {});
        }

        // Session recorder — registra a sessão no SQLite (durável). Pega o
        // contexto de floor/role do store; fire-and-forget (nunca quebra o PTY).
        {
          const { floors } = useCanvasStore.getState();
          const floor = floors.find((f) =>
            f.nodes.some((n) => n.kind === "terminal" && n.session_id === sessionId),
          );
          const node = floor?.nodes.find(
            (n) => n.kind === "terminal" && n.session_id === sessionId,
          ) as { role?: string; label?: string } | undefined;
          sessionEndedRef.current = false;
          lastStateRef.current = null;
          void sessionStart({
            id: sessionId,
            agentId: sessionId,
            floorId: floor?.id,
            floorName: floor?.name,
            branch: floor?.branch,
            role: node?.role,
            label: node?.label,
            command: [config.command, ...(config.args ?? [])].join(" "),
            cwd: config.cwd,
          }).catch(() => {});
        }

        // --- Scheduler de saída (ref P0 #2) ----------------------------
        // Escreve um chunk ao vivo + avança o seq aplicado. Single entrypoint pro
        // term.write ao vivo (foreground / flush de backlog / drain pós-snapshot).
        const writeLive = (data: string, seq: number | undefined) => {
          term.write(data);
          if (seq !== undefined && seq > lastSeqRef.current) lastSeqRef.current = seq;
        };

        // Aplica um chunk respeitando dedup + foreground/background. Reusado pelo
        // listener ao vivo E pelo drain do buffer pós-snapshot.
        const applyChunk = (data: string, seq: number | undefined) => {
          // Dedup: já coberto por um snapshot (ou write) anterior → descarta.
          if (seq !== undefined && seq <= lastSeqRef.current) return;
          // Stale (backlog estourou em background): dropa TUDO até o replay re-hidratar —
          // senão a fila re-enche/esvazia 2MB em loop (CPU thrashing). [GLM-audit #2]
          if (staleRef.current) return;
          if (activeRef.current) {
            writeLive(data, seq);
            return;
          }
          // Background: enfileira até o cap. Estourou → dropa tudo + marca stale (o
          // snapshot re-hidrata no retorno). Mesmo o chunk atual é descartado: a fonte
          // da verdade é o backend, não este backlog.
          if (bgQueueCharsRef.current + data.length > MAX_BG_CHARS) {
            bgQueueRef.current = [];
            bgQueueCharsRef.current = 0;
            staleRef.current = true;
            return;
          }
          bgQueueRef.current.push(data);
          bgQueueCharsRef.current += data.length;
          // Mesmo enfileirando, mantém o seq aplicado monotônico pra não perder o
          // dedup quando esse backlog for flushado depois.
          if (seq !== undefined && seq > lastSeqRef.current) lastSeqRef.current = seq;
        };

        unlistenOutput = await listenPtyOutput(sessionId, (data, seq) => {
          // Durante o await do snapshot, bufferiza — reaplica com o mesmo filtro de
          // seq quando o snapshot resolver (anti-corrida snapshot×live).
          if (snapshotInFlightRef.current) {
            pendingDuringSnapshotRef.current.push({ data, seq });
            return;
          }
          applyChunk(data, seq);
        });
        applyChunkRef.current = applyChunk;

        unlistenStatus = await listenAgentStatus(sessionId, (state) => {
          setTerminalStatus(sessionId, state);
          if (state !== lastStateRef.current) {
            lastStateRef.current = state;
            void sessionEvent(sessionId, `state:${state}`).catch(() => {});
          }
        });

        unlistenExit = await listenPtyExit(sessionId, (code) => {
          // Exit do PTY morto DURANTE reconnect → ignora (o novo PTY assume; não marca a
          // sessão como encerrada, senão o exit real futuro seria engolido). [GLM-audit #1]
          if (reconnectingRef.current) return;
          term.write(
            `\r\n\x1b[2;37m[processo encerrou — código ${code ?? "?"}]\x1b[0m\r\n`,
          );
          setTerminalStatus(sessionId, "dead");
          if (!sessionEndedRef.current) {
            sessionEndedRef.current = true;
            const status = lastStateRef.current === "done" ? "done" : "exited";
            void sessionEnd(sessionId, status, `exit code ${code ?? "?"}`).catch(() => {});
          }
          onExit?.(code);
        });

        // Teclas do usuário → stdin do PTY.
        //
        // WebKitGTK + IBus (Linux) DUPLICAM o caractere composto (acentos, ç…):
        // o caminho de composição do xterm emite o char e o evento `input`
        // seguinte da textarea emite o MESMO char de novo. A dedup interna do
        // xterm (`_isSendingComposition` + setTimeout 0) perde a corrida nesse
        // motor → "começar" vira "come ç çar". Guardamos a string recém-composta
        // numa janela curta: a 1ª cópia passa, a 2ª idêntica é dropada (uma vez).
        // No-op em motores sem o bug — nunca há 2ª cópia pra dropar (não deleta).
        let composed: { data: string; until: number; seen: boolean } | null = null;
        const onCompositionEnd = (e: CompositionEvent) => {
          if (e.data) composed = { data: e.data, until: Date.now() + 60, seen: false };
        };
        term.textarea?.addEventListener("compositionend", onCompositionEnd);
        disposeImeGuard = () =>
          term.textarea?.removeEventListener("compositionend", onCompositionEnd);

        // Dedup por keydown — cobre o ç do ABNT2 (TECLA DIRETA, não dead-key): o
        // IBus/WebKitGTK também emite o MESMO char 2× a partir de UM único keydown,
        // mas SEM passar por `compositionend`, então o guard acima não pega. Cada
        // tecla-de-char incrementa `keySeq` (no handler abaixo); duas emissões
        // idênticas com o MESMO keySeq (nenhum keydown entre elas) = duplicata →
        // dropa a 2ª. key-repeat e "çç" legítimo têm keydowns distintos (keySeq
        // muda) → passam. Complementa o guard de composição (que cobre dead-keys).
        let keySeq = 0;
        let lastEmit: { data: string; seq: number } | null = null;

        dataDisposable = term.onData((data) => {
          if (lastEmit && lastEmit.data === data && lastEmit.seq === keySeq) {
            lastEmit = null; // 2ª emissão da MESMA tecla (duplicata IBus) → dropa
            return;
          }
          lastEmit = { data, seq: keySeq };
          if (composed && data === composed.data && Date.now() < composed.until) {
            if (composed.seen) {
              composed = null; // 2ª cópia (duplicata WebKitGTK/IBus) → dropa
              return;
            }
            composed.seen = true; // 1ª cópia (a legítima) → passa adiante
          }
          // Não aguardamos: a UI deve ser imediata; erros aparecem nos logs.
          ptyWrite(sessionId, data).catch((e) => {
            console.error("[omni-canvas] pty_write falhou:", e);
          });
        });

        // Atalhos de input extra (interceptados ANTES do xterm gerar bytes):
        //  - Shift+Enter → quebra de linha (\n) em vez de enviar (\r) — Claude Code
        //    e REPLs tratam \n como nova linha e \r como submit.
        //  - Ctrl/Cmd+V → cola do clipboard (mesmo caminho do menu de contexto:
        //    navigator.clipboard.readText, que cobre o WebKitGTK com foco no canvas).
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== "keydown") return true;
          // Conta cada tecla-de-char (key.length === 1) p/ o dedup por keySeq do
          // onData acima. Teclas especiais (Enter/Shift/Arrow/Backspace…) têm
          // key.length > 1 e não contam — é isto que distingue a duplicata do IBus
          // (1 keydown → 2 emissões) de uma 2ª digitação real (key-repeat / "çç").
          if (e.key.length === 1) keySeq++;
          if (e.key === "Enter" && e.shiftKey) {
            ptyWrite(sessionId, "\n").catch(() => {});
            return false;
          }
          if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "v" || e.key === "V")) {
            void navigator.clipboard
              .readText()
              .then((text) => (text ? ptyWrite(sessionId, text) : undefined))
              .catch(() => {});
            return false;
          }
          return true;
        });

        // Reage a resize do xterm
        term.onResize(({ cols: c, rows: r }) => {
          ptyResize(sessionId, c, r).catch((e) => {
            console.error("[omni-canvas] pty_resize falhou:", e);
          });
        });

        // Attach (Fase 2 do #8): com os listeners já montados, re-hidrata a view do
        // estado ATUAL do PTY via snapshot — reusa EXATAMENTE o caminho do #6
        // (replayFromSnapshot): marca snapshot-em-voo (o listener de output bufferiza
        // os chunks ao vivo), escreve o snapshot, drena o buffer dedupado por seq.
        // No spawn normal NÃO roda (o PTY nasce vazio; o output ao vivo já cobre tudo).
        if (config.attach && !disposed) {
          void replayFromSnapshot();
        }

        if (!disposed) {
          setReady(true);
          void emit("pty://ready", { id: sessionId });
        }
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
      disposedRef.current = true; // visível pro reconnect() abortar o re-spawn [GLM-audit #3]
      spawnedRef.current = false; // Permite remount (React StrictMode faz double-mount em dev)
      // Zera o scheduler: o applyChunk fecha sobre o `term` que vamos dispose abaixo.
      applyChunkRef.current = null;
      bgQueueRef.current = [];
      bgQueueCharsRef.current = 0;
      snapshotInFlightRef.current = false;
      pendingDuringSnapshotRef.current = [];
      disposeImeGuard?.();
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenStatus?.();
      unlistenExit?.();
      // Encerra o registro da sessão se o exit não chegou a disparar (node removido).
      if (!sessionEndedRef.current) {
        sessionEndedRef.current = true;
        void sessionEnd(sessionId, "closed").catch(() => {});
      }
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

    // O novo PTY nasce com um emulador novo (seq reinicia em 0) → zera o estado do
    // scheduler pra não dedupar contra o seq do PTY anterior nem flushar backlog velho.
    lastSeqRef.current = -1;
    bgQueueRef.current = [];
    bgQueueCharsRef.current = 0;
    staleRef.current = false;
    snapshotInFlightRef.current = false;
    pendingDuringSnapshotRef.current = [];

    reconnectingRef.current = true; // ignora o exit do PTY que vamos matar [GLM-audit #1]
    try { await ptyKill(sessionId); } catch { /* já morreu */ }

    // Pequeno delay para o Rust liberar a sessão antes de re-spawnar
    await new Promise<void>((r) => setTimeout(r, 200));

    // Desmontou durante o delay → não cria PTY órfão nem setState em componente morto. [GLM-audit #3]
    if (disposedRef.current || !terminalRef.current) { reconnectingRef.current = false; return; }

    try {
      fitAddon?.fit();
      const { cols, rows } = term;
      await ptySpawn(sessionId, { ...config, cols, rows });
      // Novo PTY (mesmo sessionId): os listeners de output/exit do useEffect seguem ativos.
      sessionEndedRef.current = false; // exit REAL do novo PTY volta a contar [GLM-audit #1]
      reconnectingRef.current = false;
      setReady(true);
    } catch (e) {
      reconnectingRef.current = false;
      const msg = e instanceof Error ? e.message : String(e);
      setError(msg);
    }
  }, [sessionId, config, setTerminalStatus]);

  // Re-hidrata a view via snapshot do backend e retoma os writes ao vivo dedupados por
  // seq (ref P0 #2). Chamado no retorno-a-foreground COM stale. Fail-open: erro no
  // snapshot mantém o term como está (não limpa).
  const replayFromSnapshot = useCallback(async () => {
    const term = terminalRef.current;
    if (!term) return;
    // Já tem snapshot em voo → não dispara outro (evita reset duplo).
    if (snapshotInFlightRef.current) return;

    // Entra no modo "em voo": os chunks ao vivo que chegarem agora são bufferizados
    // e reaplicados depois com o mesmo filtro de seq. Limpa o backlog de background
    // (vamos re-hidratar do zero) e a flag stale.
    snapshotInFlightRef.current = true;
    bgQueueRef.current = [];
    bgQueueCharsRef.current = 0;
    staleRef.current = false;

    try {
      const snap = await ptySnapshot(sessionId);
      term.reset();
      term.write(snap.data);
      lastSeqRef.current = snap.seq;
    } catch {
      // Fail-open: backend sem emulador / erro → mantém o term como está (não limpa).
      // O lastSeqRef fica como estava; os live seguintes continuam aplicando.
    } finally {
      snapshotInFlightRef.current = false;
      // Drena o que chegou durante o await, com o MESMO filtro de seq (descarta os já
      // cobertos pelo snapshot; escreve os novos). `applyChunk` respeita active/bg.
      const pending = pendingDuringSnapshotRef.current;
      pendingDuringSnapshotRef.current = [];
      const apply = applyChunkRef.current;
      if (apply) {
        for (const { data, seq } of pending) apply(data, seq);
      }
    }
  }, [sessionId]);

  // Foreground (visível) / background (oculto) — vem do `inViewport` do TerminalNode.
  const setActive = useCallback(
    (visible: boolean) => {
      if (visible) {
        // Volta a foreground.
        if (staleRef.current) {
          // Backlog estourou enquanto oculto → re-hidrata via snapshot (não há backlog
          // confiável pra flushar). activeRef liga ANTES pra o drain pós-snapshot
          // escrever ao vivo.
          activeRef.current = true;
          void replayFromSnapshot();
          return;
        }
        // Sem stale: flusha o backlog acumulado (sob o cap) ao vivo, dedupado por seq.
        activeRef.current = true;
        // Snapshot em voo cuida da reaplicação (pendingDuringSnapshot) — não flushe junto. [GLM-audit #4]
        if (snapshotInFlightRef.current) return;
        const queue = bgQueueRef.current;
        bgQueueRef.current = [];
        bgQueueCharsRef.current = 0;
        const apply = applyChunkRef.current;
        if (apply) {
          // O seq já foi acompanhado no enqueue; passamos `undefined` no flush pra não
          // re-dedupar contra ele mesmo (o conteúdo do backlog é novo, ainda não escrito).
          for (const data of queue) apply(data, undefined);
        }
      } else {
        // Vai pra background: os próximos chunks são enfileirados (até o cap).
        activeRef.current = false;
      }
    },
    [replayFromSnapshot],
  );

  return { containerRef, ready, error, fit, getSelection, reconnect, setActive };
}
