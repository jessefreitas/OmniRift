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
import { WebglAddon } from "@xterm/addon-webgl";
import { getFlag } from "@/lib/feature-flags";
import { emit } from "@tauri-apps/api/event";
import type { UnlistenFn } from "@tauri-apps/api/event";
import { open as openExternal } from "@tauri-apps/plugin-shell";

import {
  listenAgentStatus,
  listenPtyExit,
  listenPtyOutput,
  ptyKill,
  ptyListAlive,
  ptyResize,
  ptySnapshot,
  ptySpawn,
  ptyWrite,
} from "@/lib/pty-client";
import { registerTerminalView, unregisterTerminalView } from "@/lib/terminal-sessions";
import { useCanvasStore } from "@/store/canvas-store";
import { sessionStart, sessionEvent, sessionEnd } from "@/lib/session-client";
import { scheduleReindex } from "@/lib/omnifs-client";
import { scheduleGraphRebuild } from "@/lib/omnigraph-client";
import { pasteText, copyText } from "@/lib/clipboard";
import type { PtySpawnConfig, SessionId } from "@/types/pty";

interface UseTerminalSessionOptions {
  sessionId: SessionId;
  config: PtySpawnConfig;
  onExit?: (code: number | null) => void;
  /** Colar (Ctrl+V) — delega ao caller, que sabe formatar imagem→caminho com o
   *  cwd/role do node (mesmo caminho do menu de contexto). Sem isto, o Ctrl+V cai
   *  no fallback de texto puro — que NÃO cobre imagem (clipboard com imagem e sem
   *  texto = no-op). Era a causa de "Ctrl+V não cola a imagem". */
  onPaste?: () => void | Promise<void>;
}

interface UseTerminalSessionReturn {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  ready: boolean;
  error: string | null;
  fit: () => void;
  getSelection: () => string;
  /** Escreve uma linha de AVISO local no xterm (NÃO vai pro PTY) — ex.: colar
   *  cancelado por exceder o teto de payload do IPC. */
  writeNotice: (msg: string) => void;
  /** Mata o PTY atual e re-spawna, sem recriar o xterm.js. `extraArgs` (ex: `["--continue"]`)
   *  são acrescentados aos args no respawn (recarregar subagentes MANTENDO a conversa).
   *  `configOverride` re-spawna com command/args/env NOVOS (troca de CLI/LLM, item 3) — sem
   *  ele usa a config do render (reload comum, intocado). */
  reconnect: (extraArgs?: string[], configOverride?: PtySpawnConfig) => Promise<void>;
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
  onPaste,
}: UseTerminalSessionOptions): UseTerminalSessionReturn {
  // "Latest ref" do onPaste: o useEffect de spawn é one-shot ([sessionId]); o handler
  // do Ctrl+V lê SEMPRE a versão mais recente do callback sem re-rodar o effect.
  const onPasteRef = useRef<UseTerminalSessionOptions["onPaste"]>(undefined);
  onPasteRef.current = onPaste;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const webglRef = useRef<WebglAddon | null>(null);
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
  // Contagem de chars do buffer acima — pro mesmo cap do bgQueue (MAX_BG_CHARS):
  // um agente barulhento durante um snapshot lento não pode reter MB no renderer.
  const pendingDuringSnapshotCharsRef = useRef(0);
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
    // F3 backend-owned: registra esta VIEW como montada — o sink global de
    // status/exit (pty-global-sink) e o fallback de wake ignoram sessões com view
    // (o nó cuida, com as supressões de reconnect que só ele conhece).
    registerTerminalView(sessionId);

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
    // Renderer GPU (WebGL2): ordens de grandeza mais leve que o DOM renderer default
    // com N terminais vivos no canvas. WebKitGTK varia por GPU/driver → try/catch com
    // fallback silencioso pro DOM; perda de contexto (driver reset) → dispose e o
    // xterm volta pro DOM sozinho. Precisa vir DEPOIS do term.open().
    // Kill-switch: flag off → fica no renderer DOM (evita a race do addon-webgl no dispose,
    // `_core._store._isDisposed`, que já derrubou o app). Guarda a ref pra dispor o WebGL
    // ANTES do term.dispose() no cleanup (para o rAF antes do core sumir).
    if (getFlag("terminal-webgl")) {
      try {
        const webgl = new WebglAddon();
        // Perda de contexto GPU (pressão de GPU / driver reset — comum com VM/browsers disputando
        // a placa): dispõe o WebGL de forma SEGURA e FORÇA o xterm a redesenhar no renderer DOM.
        // Só `dispose()` deixava o terminal PRETO — o WebGL parava de desenhar e o DOM não assumia
        // sozinho. Não recria o WebGL (perderia de novo); a partir daqui o terminal vive no DOM.
        webgl.onContextLoss(() => {
          try {
            webgl.dispose();
          } catch {
            /* `_core._store._isDisposed` race durante o context loss — já foi, ignora */
          }
          webglRef.current = null;
          try {
            term.refresh(0, term.rows - 1); // redesenha tudo no DOM → sem tela preta
          } catch {
            /* term já descartado */
          }
        });
        term.loadAddon(webgl);
        webglRef.current = webgl;
      } catch (e) {
        console.warn("[terminal] WebGL indisponível — seguindo no renderer DOM:", e);
      }
    }
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
    // Remove os listeners já montados. Em closure (TS não estreita os let pra null,
    // então o `?.()` typa) — usado pelos guards de unmount no meio do setup async.
    const dropListeners = () => {
      unlistenOutput?.();
      unlistenStatus?.();
      unlistenExit?.();
    };
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
        // Attach (Fase 2 do #8 + F3 backend-owned): o PTY desta sessão pode JÁ
        // existir no backend — attach explícito (CLI `omnirift spawn` →
        // `agent.spawn`, `config.attach`), re-mount de um nó que a virtualização
        // (`onlyRenderVisibleElements`) desmontou, ou eager-spawn do store
        // (addTerminal/restore → ensurePtySessions). Nesses casos PULAMOS o
        // `ptySpawn` — re-spawnar criaria um 2º processo e mataria o estado vivo.
        // O resto (session recorder, listeners, stdin, resize) é IDÊNTICO ao spawn
        // normal; a view é re-hidratada via `replayFromSnapshot` (mesmo caminho do
        // retorno-de-oculto do #6) logo após os listeners estarem montados.
        let attached = config.attach === true;
        if (!attached) {
          try {
            // VIVAS, não todas: uma sessão cujo processo morreu continua listada em
            // `ptyList` (o scrollback dela ainda serve). Attachar nela pulava o spawn e
            // colava num cadáver — terminal em branco, sem erro, com o card verde. Foi o
            // que fazia nó de CLI inexistente no Windows abrir vazio.
            attached = (await ptyListAlive()).includes(sessionId);
          } catch {
            /* lista indisponível → segue pro spawn normal */
          }
        }
        if (disposed) { dropListeners(); return; }
        if (!attached) {
          try {
            await ptySpawn(sessionId, {
              ...config,
              cols: config.cols ?? cols,
              rows: config.rows ?? rows,
            });
          } catch (e) {
            // Corrida com o eager-spawn do store (a sessão nasceu entre o pty_list
            // e o spawn) → anexa em vez de falhar. A mensagem vem do PtyManager
            // ("sessão {id} já existe").
            if (String(e).includes("já existe")) attached = true;
            else throw e;
          }
        }
        if (attached) {
          // Ajusta o PTY existente às dimensões reais deste xterm (eager-spawn e
          // agent.spawn nascem em 80×24). SÓ quando o container tem tamanho de
          // verdade: num mount oculto (floor em display:none) o fit não roda e
          // cols/rows seriam o default do xterm — redimensionar um PTY vivo pra
          // isso reflowaria a TUI à toa. Fire-and-forget — falha não bloqueia.
          const el = containerRef.current;
          if (el && el.clientWidth > 0 && el.clientHeight > 0) {
            ptyResize(sessionId, cols, rows).catch(() => {});
          }
        }
        // Desmontou durante o await do spawn → aborta antes de montar listeners
        // (senão eles resolveriam depois e escreveriam num term já disposto).
        if (disposed) { dropListeners(); return; }

        // Session recorder — registra a sessão no SQLite (durável). Pega o
        // contexto de floor/role do store; fire-and-forget (nunca quebra o PTY).
        {
          const { parallels } = useCanvasStore.getState();
          const floor = parallels.find((f) =>
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

        let lastPulseTs = 0;
        unlistenOutput = await listenPtyOutput(sessionId, (data, seq) => {
          // Conexões animadas p/ terminais: na atividade (output), pulsa verde as linhas ligadas
          // a este terminal. Throttle 500ms pra não spammar o store num agente barulhento.
          const now = performance.now();
          if (now - lastPulseTs > 500) {
            lastPulseTs = now;
            useCanvasStore.getState().pulseTerminalEdges(sessionId);
          }
          // Durante o await do snapshot, bufferiza — reaplica com o mesmo filtro de
          // seq quando o snapshot resolver (anti-corrida snapshot×live).
          if (snapshotInFlightRef.current) {
            // Cap igual ao bgQueue: estourou MAX_BG_CHARS → dropa o buffer + marca
            // stale (o próximo foreground re-hidrata via snapshot). Sem isto, um
            // snapshot lento + agente barulhento acumulava MB sem limite aqui.
            if (pendingDuringSnapshotCharsRef.current + data.length > MAX_BG_CHARS) {
              pendingDuringSnapshotRef.current = [];
              pendingDuringSnapshotCharsRef.current = 0;
              staleRef.current = true;
              return;
            }
            pendingDuringSnapshotRef.current.push({ data, seq });
            pendingDuringSnapshotCharsRef.current += data.length;
            return;
          }
          applyChunk(data, seq);
        });
        if (disposed) { dropListeners(); return; }
        applyChunkRef.current = applyChunk;

        unlistenStatus = await listenAgentStatus(sessionId, (state) => {
          setTerminalStatus(sessionId, state);
          if (state !== lastStateRef.current) {
            const prev = lastStateRef.current;
            lastStateRef.current = state;
            void sessionEvent(sessionId, `state:${state}`).catch(() => {});
            // F3 item 2: turno terminou (working/blocked → idle/done) e o cwd é mount
            // OmniFS vivo → agenda re-index debounced do drive. Fire-and-forget + gate
            // no backend (scheduleReindex ignora cwd vazio / fora do mount).
            if ((state === "idle" || state === "done") && (prev === "working" || prev === "blocked")) {
              scheduleReindex(config.cwd ?? "");
              // F4a: gêmeo estrutural — agenda o rebuild debounced (~90s) do grafo de código.
              // Fire-and-forget + gate barato/no-op no backend (sem grafo → nada roda).
              scheduleGraphRebuild(config.cwd ?? "");
            }
          }
        });
        if (disposed) { dropListeners(); return; }

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
        if (disposed) { dropListeners(); return; }

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
        //  - Ctrl/Cmd+V → cola do clipboard via pasteText() (plugin clipboard do
        //    Tauri; o navigator.clipboard.readText não funciona no WebKitGTK).
        term.attachCustomKeyEventHandler((e) => {
          if (e.type !== "keydown") return true;
          // Conta cada tecla-de-char (1 code point) p/ o dedup por keySeq do
          // onData acima. Teclas especiais (Enter/Shift/Arrow/Backspace…) têm
          // múltiplos chars e não contam — é isto que distingue a duplicata do IBus
          // (1 keydown → 2 emissões) de uma 2ª digitação real (key-repeat / "çç").
          // Array.from conta CODE POINTS: emoji/CJK-ext têm String#length 2 mas são
          // 1 tecla — senão a 2ª emissão do mesmo char viraria falso-duplicado.
          if (Array.from(e.key).length === 1) keySeq++;
          if (e.key === "Enter" && e.shiftKey) {
            ptyWrite(sessionId, "\n").catch(() => {});
            return false;
          }
          if ((e.ctrlKey || e.metaKey) && !e.altKey && (e.key === "v" || e.key === "V")) {
            // Delega ao caller (TerminalNode.handlePaste): texto → senão imagem→caminho.
            // Unifica o Ctrl+V com o menu de contexto (antes só o menu pegava imagem).
            // Fallback (sem onPaste): texto puro, retrocompat.
            if (onPasteRef.current) void onPasteRef.current();
            else void pasteText().then((text) => (text ? ptyWrite(sessionId, text) : undefined));
            return false;
          }
          // Ctrl/Cmd+Shift+C → COPIA a seleção pro clipboard do SO (o menu de contexto está
          // desabilitado no WebKitGTK; Ctrl+C puro é SIGINT). Sem isto, o que se copia do
          // terminal não colava em lugar nenhum.
          if ((e.ctrlKey || e.metaKey) && e.shiftKey && (e.key === "c" || e.key === "C")) {
            const s = term.getSelection();
            if (s) void copyText(s);
            return false;
          }
          return true;
        });

        // Auto-copia ao SELECIONAR (X11 primary-selection style) → selecionar no terminal já
        // manda pro clipboard do SO, mesmo sem Ctrl+Shift+C. É o que resolve "copio e não colo".
        term.onSelectionChange(() => {
          const s = term.getSelection();
          if (s && s.trim()) void copyText(s);
        });

        // Reage a resize do xterm
        term.onResize(({ cols: c, rows: r }) => {
          ptyResize(sessionId, c, r).catch((e) => {
            console.error("[omni-canvas] pty_resize falhou:", e);
          });
        });

        // Attach (Fase 2 do #8 / F3): com os listeners já montados, re-hidrata a
        // view do estado ATUAL do PTY via snapshot — reusa EXATAMENTE o caminho do
        // #6 (replayFromSnapshot): marca snapshot-em-voo (o listener de output
        // bufferiza os chunks ao vivo), escreve o snapshot, drena o buffer dedupado
        // por seq. No spawn normal NÃO roda (o PTY nasce vazio; o live cobre tudo).
        if (attached && !disposed) {
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
      pendingDuringSnapshotCharsRef.current = 0;
      disposeImeGuard?.();
      dataDisposable?.dispose();
      unlistenOutput?.();
      unlistenStatus?.();
      unlistenExit?.();
      // F3 backend-owned: o unmount NÃO mata o PTY nem encerra o session recorder —
      // o nó é uma VIEW descartável (a virtualização/troca de floor desmonta à
      // vontade; o próximo mount re-anexa via pty_list + snapshot). O kill +
      // sessionEnd explícitos vivem no canvas-store (removeNode, fechar floor/
      // projeto, gc do restore) — mesmo contrato do AgentNode (F2). O sink global
      // (pty-global-sink) assume status/exit enquanto não há view.
      unregisterTerminalView(sessionId);
      // Dispõe o WebGL ANTES do term.dispose(): para o rAF do renderer enquanto o core ainda
      // existe, evitando a race `_core._store._isDisposed` (o rAF acessava um core já limpo).
      try { webglRef.current?.dispose(); } catch { /* já disposed */ }
      webglRef.current = null;
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

  // Aviso local no xterm (amarelo), sem enviar nada pro PTY. \r\n nas duas pontas
  // pra não colar na linha do prompt onde o usuário estava digitando.
  const writeNotice = useCallback((msg: string) => {
    terminalRef.current?.write(`\r\n\x1b[33m${msg}\x1b[0m\r\n`);
  }, []);

  const reconnect = useCallback(async (extraArgs?: string[], configOverride?: PtySpawnConfig) => {
    const term = terminalRef.current;
    const fitAddon = fitAddonRef.current;
    if (!term) return;
    // configOverride: troca de CLI/LLM (item 3) re-spawna com command/args NOVOS. Aditivo —
    // sem override usa o `config` do render (comportamento original do reload intocado). O
    // override evita a corrida com o re-render do patchNode: spawnamos já com a config certa.
    const eff = configOverride ?? config;

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
    pendingDuringSnapshotCharsRef.current = 0;

    reconnectingRef.current = true; // ignora o exit do PTY que vamos matar [GLM-audit #1]
    try { await ptyKill(sessionId); } catch { /* já morreu */ }

    // Pequeno delay para o Rust liberar a sessão antes de re-spawnar
    await new Promise<void>((r) => setTimeout(r, 200));

    // Desmontou durante o delay → não cria PTY órfão nem setState em componente morto. [GLM-audit #3]
    if (disposedRef.current || !terminalRef.current) { reconnectingRef.current = false; return; }

    try {
      fitAddon?.fit();
      const { cols, rows } = term;
      const respawnArgs = extraArgs?.length ? [...(eff.args ?? []), ...extraArgs] : eff.args;
      const spawnOnce = () => ptySpawn(sessionId, { ...eff, args: respawnArgs, cols, rows });
      try {
        await spawnOnce();
      } catch (e) {
        // F3 backend-owned: sessão MORTA pode continuar registrada no manager (pra attach) →
        // o spawn devolve "sessão já existe" mesmo depois do kill. Mata de novo e re-tenta
        // UMA vez (era o "falha ao iniciar: sessão X já existe" ao clicar ⟳ pós-exit-129).
        if (!String(e).includes("já existe")) throw e;
        try { await ptyKill(sessionId); } catch { /* já foi */ }
        await new Promise<void>((r) => setTimeout(r, 250));
        if (disposedRef.current || !terminalRef.current) { reconnectingRef.current = false; return; }
        await spawnOnce();
      }
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
      pendingDuringSnapshotCharsRef.current = 0;
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

  return { containerRef, ready, error, fit, getSelection, writeNotice, reconnect, setActive };
}
