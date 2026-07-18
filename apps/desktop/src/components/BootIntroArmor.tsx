import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { runArmorScene, type ArmorScene } from "@/lib/boot-armor";
import { speakGreeting, stopAudio } from "@/lib/boot-audio";
import { gateClose } from "@/lib/gate-close";
import { getBootVoice, setBootVoice, type BootVoice } from "@/lib/boot-greeting";

const CSS = `
.bi-root{position:fixed;inset:0;z-index:9999;background:#02040a;font-family:'Orbitron',system-ui,monospace;transition:opacity .6s;color:#dbe1e7;overflow:hidden;}
.bi-canvas{position:fixed;inset:0;z-index:1;}
.bi-vig{position:fixed;inset:0;z-index:4;pointer-events:none;background:radial-gradient(circle at 50% 48%,transparent 62%,rgba(0,0,0,.5) 100%);}
.bi-brand{position:fixed;left:0;right:0;bottom:4%;text-align:center;z-index:6;pointer-events:none;}
.bi-title{font-weight:900;font-size:3rem;letter-spacing:.5em;color:#f2fbff;text-shadow:0 0 10px #bfe8ff,0 0 30px rgba(120,215,255,.9);}
.bi-sub{margin-top:12px;font-weight:600;font-size:.64rem;letter-spacing:.5em;text-transform:uppercase;color:rgba(210,235,255,.6);animation:biblink 2s infinite;}
@keyframes biblink{0%,100%{opacity:.35}50%{opacity:1}}
.bi-voice{position:fixed;right:16px;top:16px;z-index:8;border:1px solid rgba(255,255,255,.18);background:rgba(255,255,255,.05);color:rgba(230,245,255,.8);border-radius:999px;padding:5px 14px;font:600 12px 'Orbitron',monospace;cursor:pointer;}
`;

export function BootIntroArmor({ onDone }: { onDone: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<ArmorScene | null>(null);
  const aliveRef = useRef(true);
  const enteredRef = useRef(false);
  const [voice, setVoiceState] = useState<BootVoice>(getBootVoice());
  const [ready, setReady] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [brand, setBrand] = useState<{ color: string; shadow: string }>({
    color: "#f2fbff",
    shadow: "0 0 10px #bfe8ff,0 0 30px rgba(120,215,255,.9)",
  });

  useEffect(() => {
    aliveRef.current = true;
    const cv = canvasRef.current;
    if (!cv) return;
    const scene = runArmorScene(cv);
    sceneRef.current = scene;
    const h = scene.hue;
    setBrand({
      color: `hsl(${h},60%,96%)`,
      shadow: `0 0 10px hsl(${h},90%,80%),0 0 30px hsla(${h},90%,65%,.9),0 0 60px hsla(${h},85%,55%,.6)`,
    });
    const poll = setInterval(() => {
      if (!aliveRef.current) return;
      if (scene.progress() > 0.98) {
        setReady(true);
        clearInterval(poll);
      }
    }, 200);
    return () => {
      aliveRef.current = false;
      clearInterval(poll);
      scene.stop();
      stopAudio();
    };
  }, []);

  const enter = useCallback(() => {
    if (enteredRef.current) return;
    enteredRef.current = true;
    // Espera a saudação terminar antes de fechar (teto de 6s se não houver dispositivo de áudio).
    void gateClose(speakGreeting(voice), 6000).then(() => {
      setLeaving(true);
      setTimeout(onDone, 600);
    });
  }, [voice, onDone]);

  const toggleVoice = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    const next: BootVoice = voice === "male" ? "female" : "male";
    setVoiceState(next);
    setBootVoice(next);
  }, [voice]);

  return (
    <div className="bi-root" onClick={enter} style={{ opacity: leaving ? 0 : 1 }}>
      <style>{CSS}</style>
      <canvas ref={canvasRef} className="bi-canvas" />
      <button className="bi-voice" onClick={toggleVoice}>{voice === "male" ? "♂ Adam" : "♀ Maria"}</button>
      <div className="bi-vig" />
      <div className="bi-brand">
        <div className="bi-title" style={{ color: brand.color, textShadow: brand.shadow }}>OMNIRIFT</div>
        <div className="bi-sub">{ready ? "clique para entrar" : "clique para iniciar"}</div>
      </div>
    </div>
  );
}
