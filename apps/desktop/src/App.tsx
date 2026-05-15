import { Canvas } from "@/components/Canvas";
import { Sidebar } from "@/components/Sidebar";

export default function App() {
  return (
    <div className="flex h-screen w-screen bg-bg">
      <Sidebar />
      <main className="flex-1 relative">
        <Canvas />
      </main>
    </div>
  );
}
