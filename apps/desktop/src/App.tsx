import { useEffect } from "react";
import { Canvas } from "@/components/Canvas";
import { Sidebar } from "@/components/Sidebar";
import { initOrchestrationBridge } from "@/lib/orchestration-client";

export default function App() {
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    initOrchestrationBridge().then((u) => (unlisten = u));
    return () => unlisten?.();
  }, []);

  return (
    <div className="flex h-screen w-screen bg-bg">
      <Sidebar />
      <main className="flex-1 relative">
        <Canvas />
      </main>
    </div>
  );
}
