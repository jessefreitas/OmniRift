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

export default function App() {
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
