import { useEffect } from "react";
import { Canvas } from "@/components/Canvas";
import { Sidebar } from "@/components/Sidebar";
import { ProjectTabs } from "@/components/ProjectTabs";
import { initOrchestrationBridge } from "@/lib/orchestration-client";
import { initPersistence } from "@/lib/persistence-client";

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

  return (
    <div className="flex h-screen w-screen bg-bg">
      <Sidebar />
      <main className="flex-1 flex flex-col min-w-0">
        <ProjectTabs />
        <div className="flex-1 relative">
          <Canvas />
        </div>
      </main>
    </div>
  );
}
