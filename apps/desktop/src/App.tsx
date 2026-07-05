import { useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { Canvas } from "@/components/Canvas";
import { Sidebar } from "@/components/Sidebar";
import { ProjectTabs } from "@/components/ProjectTabs";
import { ResourceChip } from "@/components/ResourceChip";
import { ResourcePanel } from "@/components/ResourcePanel";
import { initOrchestrationBridge } from "@/lib/orchestration-client";
import { initPersistence, flushPersistence } from "@/lib/persistence-client";
import { initResourceStore } from "@/store/resource-store";
import { startAutoSnapshot, stopAutoSnapshot } from "@/lib/auto-snapshot";
import { persistReviewConfig } from "@/lib/review-config-sync";
import { acpGc } from "@/lib/acp-client";
import { initPtyGlobalSink } from "@/lib/pty-global-sink";
import { useCanvasStore } from "@/store/canvas-store";
import { mcpServersImportGlobal } from "@/lib/mcp-servers-client";
import { notify } from "@/lib/notify";
import { useT } from "@/lib/i18n";

export default function App() {
  const tr = useT();
  // FIRE-TEST (branch descartável): o smoke gate TEM que ficar vermelho com isto.
  throw new Error("fire-test: boot quebrado de propósito — o smoke deve detectar");

  // Aviso pós strict-mcp: os agentes NÃO herdam mais os mcpServers do ~/.claude.json.
  // No boot, importa os globais como DESLIGADOS (idempotente — nunca liga nem
  // sobrescreve) e avisa UMA vez: nas execuções seguintes importa 0 → sem toast.
  useEffect(() => {
    mcpServersImportGlobal()
      .then((n) => {
        if (n > 0) {
          void notify(
            tr("mcpServers.globalImportNotice1", "Os agentes não herdam mais os MCPs globais do Claude. ")
              + n
              + tr("mcpServers.globalImportNotice2", " server(s) foram adicionados DESLIGADOS em Ferramentas → MCP Servers — ligue só o que quiser."),
          );
        }
      })
      .catch(() => {}); // best-effort — aviso nunca trava o boot
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

  return (
    <div className="flex h-screen w-screen bg-bg">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <ProjectTabs />
        <div className="flex-1 relative">
          <Canvas />
        </div>
      </main>
      <ResourceChip />
      <ResourcePanel />
    </div>
  );
}
