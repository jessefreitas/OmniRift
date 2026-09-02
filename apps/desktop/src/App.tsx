import { useEffect, useState } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { Canvas } from "@/components/Canvas";
import { BootIntro } from "@/components/BootIntro";
import { BootIntroArmor } from "@/components/BootIntroArmor";
import { applyBenchOverrides, getFlag, useFlag } from "@/lib/feature-flags";
import { makeSyntheticNodes } from "@/lib/bench-load";
import { runCanvasBench, type BenchConfig } from "@/lib/canvas-bench";
import { Sidebar } from "@/components/Sidebar";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ResourceChip } from "@/components/ResourceChip";
import { FluencyChip } from "@/components/FluencyChip";
import { ResourcePanel } from "@/components/ResourcePanel";
import { initOrchestrationBridge } from "@/lib/orchestration-client";
import { initPersistence, flushPersistence } from "@/lib/persistence-client";
import { initResourceStore } from "@/store/resource-store";
import { startAutoSnapshot, stopAutoSnapshot } from "@/lib/auto-snapshot";
import { persistReviewConfig } from "@/lib/review-config-sync";
import { syncSandboxFlag } from "@/lib/sandbox-flag-sync";
import { acpGc } from "@/lib/acp-client";
import { initPtyGlobalSink } from "@/lib/pty-global-sink";
import { useCanvasStore } from "@/store/canvas-store";
import { logToDisk, startMainThreadWatchdog } from "@/lib/debug-log";
import { markBootUiReady, whenBootUiReady } from "@/lib/boot-ui-ready";
import { mcpServersImportGlobal } from "@/lib/mcp-servers-client";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";
import { useOrchestrationWatchdog } from "@/hooks/useOrchestrationWatchdog";
import { useReducedUi } from "@/lib/experience-mode";
import { setPhase } from "@/lib/perf-probe";
import { WelcomeSlides } from "@/components/WelcomeSlides";
import { WELCOME_SEEN_KEY, shouldShowWelcome } from "@/lib/welcome-state";

export default function App() {
  // Watchdog da orquestração: cobra o líder quando o time trava esperando as
  // fatias e aciona o reviewer na entrega do contrato (flag orchestration-watchdog).
  useOrchestrationWatchdog();

  const tr = useT();
  const reduced = useReducedUi();

  // Intro FRIDAY (flag boot-intro): cobre a tela na abertura até o usuário entrar.
  // introDone sobe no onDone → some pra sempre nesta sessão (não re-monta em re-render).
  const bootIntroOn = useFlag("boot-intro") && !reduced;
  const [introDone, setIntroDone] = useState(false);
  // Alterna a cada boot: numa vez a armadura JARVIS, na outra o HUD procedural.
  const [useArmor] = useState(() => Math.random() < 0.5);

  // Boas-vindas: SÓ na primeira abertura de uma instalação nova. Lido uma vez no mount
  // (não a cada render) pra a tela não voltar quando o usuário troca de modo depois.
  const [welcomeOpen, setWelcomeOpen] = useState(() => shouldShowWelcome(window.localStorage));
  const closeWelcome = () => {
    try { window.localStorage.setItem(WELCOME_SEEN_KEY, "1"); } catch { /* storage off: reaparece no próximo boot, não quebra */ }
    setWelcomeOpen(false);
  };

  // Libera scans adiados (usage_scan etc.) só depois do intro — ou já no mount se off.
  useEffect(() => {
    if (!bootIntroOn || introDone) markBootUiReady();
  }, [bootIntroOn, introDone]);

  // Watchdog de main thread: grava no debug.log quando a UI congela (o "não responde /
  // forçar saída" do WebKitGTK). O contexto vai junto pra correlacionar o travamento com a
  // CARGA — floors montados vs nós vs terminais VIVOS (dormentes não custam PTY/xterm).
  // O trackRender já cobre loop de render; isto cobre bloqueio sem loop, que ele não vê.
  useEffect(() => {
    return startMainThreadWatchdog(() => {
      const s = useCanvasStore.getState();
      const nodes = s.parallels.reduce((acc, f) => acc + f.nodes.length, 0);
      const live = s.parallels.reduce(
        (acc, f) => acc + f.nodes.filter((n) => n.kind === "terminal" && !n.dormant).length,
        0,
      );
      return `floors=${s.parallels.length} nodes=${nodes} terms-vivos=${live}`;
    });
  }, []);

  // Aviso pós strict-mcp: os agentes NÃO herdam mais os mcpServers do ~/.claude.json.
  // Depois do boot-intro (não disputa IPC com db_load no cold start).
  useEffect(() => {
    let cancelled = false;
    void whenBootUiReady().then(() => {
      if (cancelled) return;
      mcpServersImportGlobal()
        .then((n) => {
          if (cancelled || n <= 0) return;
          void notify(
            tr("mcpServers.globalImportNotice1", "Os agentes não herdam mais os MCPs globais do Claude. ")
              + n
              + tr("mcpServers.globalImportNotice2", " server(s) foram adicionados DESLIGADOS em Ferramentas → MCP Servers — ligue só o que quiser."),
          );
        })
        .catch(() => {});
    });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    initOrchestrationBridge().then((u) => {
      // StrictMode (dev) monta 2×: se já desmontou antes da promise resolver,
      // desliga o listener na hora pra não registrar em duplicidade.
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    let cleanup: (() => void) | undefined;
    let disposed = false;
    initPersistence().then((c) => {
      if (disposed) c();
      else cleanup = c;
    });
    return () => {
      disposed = true;
      cleanup?.();
    };
  }, []);

  // "Cron" de backup automático do canvas (settings em localStorage).
  useEffect(() => {
    startAutoSnapshot();
    return () => stopAutoSnapshot();
  }, []);

  // Flush do autosave ao fechar a janela: o debounce de 600ms perderia a última
  // edição. preventDefault + flush + destroy garante a gravação ANTES da janela
  // morrer (sem preventDefault o WebView fecha antes do await terminar). Re-fechamos
  // com destroy() (não re-emite close-requested → sem loop).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    const win = getCurrentWindow();
    win
      .onCloseRequested(async (e) => {
        e.preventDefault();
        try {
          await flushPersistence();
        } finally {
          void win.destroy();
        }
      })
      .then((u) => {
        // StrictMode (dev) monta 2×: desliga na hora se já desmontou.
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Espelha a config de review (LLM+policy) pro backend no boot — base do Stop
  // hook / tool MCP que vão rodar o review headless nos agentes (#2).
  useEffect(() => {
    void persistReviewConfig();
  }, []);

  // Espelha a flag sandbox-workspace pro backend (envelope bwrap em PTY/ACP).
  useEffect(() => {
    void syncSandboxFlag(getFlag("sandbox-workspace"));
  }, []);

  // F2 backend-owned (ACP): reaper no boot — mata sessões do AcpManager cujo id não
  // corresponde a nenhum agent-node do canvas atual (o restore remapeia ids; um crash
  // do front também deixa órfãs). No boot limpo é no-op barato. O restoreWorkspace
  // chama o mesmo gc após cada restore.
  useEffect(() => {
    const ids = useCanvasStore
      .getState()
      .parallels.flatMap((f) => f.nodes.filter((n) => n.kind === "agent").map((n) => n.id));
    void acpGc(ids).catch(() => {});
  }, []);

  // F3 backend-owned (PTY): sink global de agent://status + pty://exit — com a
  // virtualização, terminais fora do viewport estão DESMONTADOS (sem listeners);
  // o sink mantém terminalStatuses (FleetBar/StatusDot) e o session recorder
  // frescos pra eles. Sessões com view montada são ignoradas (o nó cuida — inclui
  // a supressão de exit durante reconnect, que só o nó conhece).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    initPtyGlobalSink()
      .then((u) => {
        if (disposed) u();
        else unlisten = u;
      })
      .catch(() => {}); // fora do Tauri (vite puro) o listen rejeita — sink é opcional
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Monitor de recursos: assina resource://sample uma vez (chip sempre-visível).
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let disposed = false;
    initResourceStore().then((u) => {
      if (disposed) u();
      else unlisten = u;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, []);

  // Fase de vida do app, pro watchdog saber SE um bloqueio importa: boot bloqueia por
  // natureza, intro é animação pesada conhecida, canvas é onde travar é bug.
  const uiReady = !bootIntroOn || introDone;
  useEffect(() => {
    setPhase(uiReady ? "canvas" : bootIntroOn ? "intro" : "boot");
  }, [uiReady, bootIntroOn]);

  // Harness de benchmark de fluidez/jank do canvas:
  // Se OMNIRIFT_BENCH_MODE=1 estiver ativo, aplica overrides de flags e executa o bench.
  useEffect(() => {
    let disposed = false;
    (async () => {
      try {
        const raw = await invoke<{
          mode: boolean;
          flags: string;
          nodes: number;
          drag_steps?: number;
          dragSteps?: number;
        }>("bench_config").catch(() => null);

        if (disposed || !raw || !raw.mode) return;

        const cfg: BenchConfig = {
          mode: raw.mode,
          flags: raw.flags,
          nodes: raw.nodes,
          dragSteps: raw.dragSteps ?? raw.drag_steps ?? 30,
        };

        applyBenchOverrides("1", cfg.flags);

        await whenBootUiReady();
        if (disposed) return;

        await runCanvasBench(cfg, {
          log: logToDisk,
          now: () => Date.now(),
          loadNodes: (count) => {
            const nodes = makeSyntheticNodes(count);
            useCanvasStore.getState().importCommunityNodes(nodes, []);
            return nodes.map((n) => n.id);
          },
          readPositions: (ids) => {
            const s = useCanvasStore.getState();
            const active = s.parallels.find((p) => p.id === s.activeParallelId);
            const map = new Map<string, { x: number; y: number }>();
            if (active) {
              const idSet = new Set(ids);
              for (const n of active.nodes) {
                if (idSet.has(n.id)) {
                  map.set(n.id, { ...n.position });
                }
              }
            }
            return map;
          },
          dragNode: async (id, path) => {
            let el =
              document.querySelector<HTMLElement>(`[data-id="${id}"] .node-drag-handle`) ??
              document.querySelector<HTMLElement>(`[data-id="${id}"]`);
            if (!el) {
              for (let attempt = 0; attempt < 10; attempt++) {
                await new Promise((r) => setTimeout(r, 50));
                el =
                  document.querySelector<HTMLElement>(`[data-id="${id}"] .node-drag-handle`) ??
                  document.querySelector<HTMLElement>(`[data-id="${id}"]`);
                if (el) break;
              }
            }
            if (!el) {
              logToDisk(`[BENCH-LOAD] elemento do nó ${id} não foi encontrado`);
              return;
            }
            if (path.length === 0) return;

            const rect = el.getBoundingClientRect();
            let currentX = rect.left + rect.width / 2;
            let currentY = rect.top + rect.height / 2;

            // O React Flow usa d3-drag, que inicia o gesto por mousedown; pointerdown
            // permanece porque outros handlers do app podem depender dele.
            el.dispatchEvent(
              new PointerEvent("pointerdown", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: currentX,
                clientY: currentY,
                pointerId: 1,
                isPrimary: true,
                button: 0,
                buttons: 1,
              }),
            );
            el.dispatchEvent(
              new MouseEvent("mousedown", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: currentX,
                clientY: currentY,
                button: 0,
                buttons: 1,
              }),
            );

            for (let i = 0; i < path.length; i++) {
              const pt = path[i];
              const prev = i === 0 ? path[0] : path[i - 1];
              currentX += pt.x - prev.x;
              currentY += pt.y - prev.y;

              const moveEvt = new PointerEvent("pointermove", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: currentX,
                clientY: currentY,
                pointerId: 1,
                isPrimary: true,
                button: 0,
                buttons: 1,
              });
              el.dispatchEvent(moveEvt);
              window.dispatchEvent(moveEvt);

              // Após o mousedown, d3-drag escuta mousemove na window, não no elemento.
              window.dispatchEvent(
                new MouseEvent("mousemove", {
                  bubbles: true,
                  cancelable: true,
                  view: window,
                  clientX: currentX,
                  clientY: currentY,
                  button: 0,
                  buttons: 1,
                }),
              );
              await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            }

            const upEvt = new PointerEvent("pointerup", {
              bubbles: true,
              cancelable: true,
              view: window,
              clientX: currentX,
              clientY: currentY,
              pointerId: 1,
              isPrimary: true,
              button: 0,
              buttons: 0,
            });
            el.dispatchEvent(upEvt);
            window.dispatchEvent(upEvt);
            // d3-drag também encerra o gesto pelo mouseup registrado na window.
            window.dispatchEvent(
              new MouseEvent("mouseup", {
                bubbles: true,
                cancelable: true,
                view: window,
                clientX: currentX,
                clientY: currentY,
                button: 0,
                buttons: 0,
              }),
            );
            await new Promise((resolve) => setTimeout(resolve, 16));
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          startTicker: (intervalMs, tick) => {
            const handle = window.setInterval(tick, intervalMs);
            return () => window.clearInterval(handle);
          },
        });
      } catch (err) {
        // Envolve em try/catch para nunca derrubar o app (requisito smoke-boot / CI)
        console.error("Canvas bench error:", err);
      }
    })();
    return () => {
      disposed = true;
    };
  }, []);

  return (
    <div className="flex h-screen w-screen bg-bg">
      {/* Canvas/Sidebar só após o intro: no cold start o WebGL do armor + scans
          disputavam o event loop com a resposta IPC do db_load. Persistência
          continua nos effects acima. */}
      {uiReady && (
        <>
          <Sidebar />
          <main className="flex-1 flex flex-col min-w-0">
            <ProjectTabs />
            <div className="flex-1 relative">
              <Canvas />
            </div>
          </main>
          {!reduced && (
            <>
              <ResourceChip />
              <FluencyChip />
              <ResourcePanel />
            </>
          )}
        </>
      )}
      {uiReady && welcomeOpen && <WelcomeSlides onDone={closeWelcome} />}
      {bootIntroOn && !introDone && (useArmor
        ? <BootIntroArmor onDone={() => setIntroDone(true)} />
        : <BootIntro onDone={() => setIntroDone(true)} />)}
    </div>
  );
}
