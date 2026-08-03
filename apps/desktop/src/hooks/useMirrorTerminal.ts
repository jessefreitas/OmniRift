import { useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { ptySnapshot, ptyWrite, listenPtyOutput } from "@/lib/pty-client";

// O espelho é uma 2ª view propositalmente simples. O hook principal (useTerminalSession)
// é quem spawna, redimensiona e mata a sessão. Esse hook existe porque o
// OrchestratorDock reaproveita o DOM de um TerminalNode montado em outro floor via
// appendChild; se aquele floor for desmontado, o dock fica vazio. Ter um xterm
// independente aqui evita que o dock morra junto com floors inativos.
const XTERM_OPTIONS = {
  fontSize: 12,
  fontFamily: "monospace",
  convertEol: false,
  scrollback: 2000,
  cursorBlink: false,
  // O tema é herdado do CSS global; o espelho não precisa reinventá-lo.
};

interface PtySnapshot {
  content: string;
  seq: number;
}

function isPtySnapshot(value: unknown): value is PtySnapshot {
  return (
    !!value &&
    typeof value === "object" &&
    "seq" in value &&
    typeof (value as { seq: unknown }).seq === "number" &&
    "content" in value &&
    typeof (value as { content: unknown }).content === "string"
  );
}

export function useMirrorTerminal(args: {
  sessionId: string | null;
  containerRef: { current: HTMLElement | null };
  /** Se false, o espelho não é criado (flag desligada / dock fechado). */
  enabled: boolean;
}): { ready: boolean; error: string | null } {
  const { sessionId, containerRef, enabled } = args;

  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const sessionRef = useRef(sessionId);
  // Atualiza DENTRO de effect: escrever em ref durante o render é o antipadrão que
  // o lint do projeto barra (e que a auditoria de performance mapeou como risco).
  useEffect(() => {
    sessionRef.current = sessionId;
  }, [sessionId]);

  const termRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);
  const roRef = useRef<ResizeObserver | null>(null);
  const snapshotSeqRef = useRef<number>(-1);
  const bufferRef = useRef<Array<{ output: string; seq: number }>>([]);

  useEffect(() => {
    const container = containerRef.current;
    if (!enabled || !sessionId || !container) {
      // Sem uma das três condições o espelho não deve existir.
      setReady(false);
      setError(null);
      return;
    }

    let disposed = false;
    let snapshotHandled = false;

    // 1. Cria o terminal e abre no container do dock.
    const term = new Terminal(XTERM_OPTIONS);
    const fit = new FitAddon();

    term.loadAddon(fit);
    term.open(container);

    // 2. Teclado: espelho é interativo, escreve na MESMA sessão.
    const dataDispose = term.onData((data) => {
      const activeId = sessionRef.current;
      if (activeId) {
        ptyWrite(activeId, data);
      }
    });

    // 3. Resize APENAS local. NUNCA ptyResize.
    // O PTY tem UM tamanho, controlado pela view principal. Se o espelho também
    // enviasse resize, as duas views brigariam e o terminal saltaria de largura
    // para todos os observadores. FitAddon aqui serve só para caber no dock.
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
      } catch {
        // Container ainda sem dimensões (display:none, etc). Ignoramos.
      }
    });
    ro.observe(container);
    try {
      fit.fit();
    } catch {
      // Primeiro fit pode falhar se o container não tiver layout ainda.
    }

    termRef.current = term;
    fitRef.current = fit;
    roRef.current = ro;

    // Reset de estado para a nova sessão/container.
    snapshotSeqRef.current = -1;
    bufferRef.current = [];
    setError(null);
    setReady(false);

    // 4. Assina o output ANTES de buscar o snapshot.
    // Eventos ao vivo que chegarem enquanto await ptySnapshot são guardados para
    // serem aplicados depois, com o mesmo filtro de deduplicação por seq.
    const assinatura = listenPtyOutput(sessionId, (output, seq) => {
      if (disposed) return;

      if (!snapshotHandled) {
        // seq ausente vira -1: evento sem seq NUNCA é descartado pelo dedup —
        // perder saída é pior que pintar uma linha repetida.
        bufferRef.current.push({ output, seq: seq ?? -1 });
        return;
      }

      const snapSeq = snapshotSeqRef.current;
      if (seq !== undefined && seq <= snapSeq) {
        // Já pintado pelo snapshot; descarta para não duplicar histórico.
        return;
      }

      term.write(output);
    });
    // `listenPtyOutput` resolve depois; guarda o unlisten quando chegar e desliga
    // na hora se o hook já tiver sido desmontado nesse meio-tempo.
    void assinatura.then((un) => {
      if (disposed) {
        un();
        return;
      }
      unsubRef.current = un;
    });

    // 5. Busca histórico e aplica o buffer acumulado.
    (async () => {
      try {
        const rawSnapshot = await ptySnapshot(sessionId);
        if (disposed) return;

        if (!isPtySnapshot(rawSnapshot)) {
          throw new Error("Snapshot inválido: seq ou content ausente");
        }

        snapshotSeqRef.current = rawSnapshot.seq;
        snapshotHandled = true;

        if (rawSnapshot.content) {
          term.write(rawSnapshot.content);
        }

        // Aplica eventos que chegaram durante o await, filtrando duplicatas.
        const pending = bufferRef.current.filter((e) => e.seq > rawSnapshot.seq);
        bufferRef.current = [];
        for (const e of pending) {
          term.write(e.output);
        }

        setReady(true);
      } catch (err) {
        if (disposed) return;
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        setReady(false);
      }
    })();

    // 6. Limpeza: desmontar/trocar de sessão deve matar o espelho.
    // Um xterm invisível vazado continuaria recebendo output da sessão para sempre.
    return () => {
      disposed = true;

      unsubRef.current?.();
      unsubRef.current = null;

      dataDispose.dispose();

      ro.disconnect();
      roRef.current = null;

      term.dispose();
      termRef.current = null;
      fitRef.current = null;

      // Garante que nenhum fragmento de DOM do xterm fique preso no container.
      while (container.firstChild) {
        container.removeChild(container.firstChild);
      }

      setReady(false);
    };
  }, [enabled, sessionId, containerRef]);

  return { ready, error };
}
