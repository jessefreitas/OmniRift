import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { createFridayOrb, type FridayOrbHandle } from "@/lib/friday-orb";
import { BOOT_PROBES, runBootProbe, type ProbeResult } from "@/lib/boot-probes";
import { playBootSound, speakGreeting, stopAudio } from "@/lib/boot-audio";
import { currentGreeting, getBootVoice, setBootVoice, type BootVoice } from "@/lib/boot-greeting";

export function BootIntro({ onDone, color = "#38d6ff" }: { onDone: () => void; color?: string }) {
  const greeting = currentGreeting(); // texto neutro por período do dia
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<FridayOrbHandle | null>(null);
  const aliveRef = useRef(true);
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [fading, setFading] = useState(false);
  const [voice, setVoiceState] = useState<BootVoice>(getBootVoice());

  // Inicia o orb com baixa intensidade e escuta redimensionamento
  useEffect(() => {
    const orb = createFridayOrb(canvasRef.current!, { color });
    orbRef.current = orb;
    orb.start();
    orb.setIntensity(0.15);
    aliveRef.current = true;

    const onResize = () => orb.resize();
    window.addEventListener("resize", onResize);

    return () => {
      aliveRef.current = false;
      orb.stop();
      stopAudio();
      window.removeEventListener("resize", onResize);
      orbRef.current = null;
    };
  }, [color]);

  // Toque 1: acorda FRIDAY, toca som, fala saudação e executa probes
  const begin = useCallback(() => {
    setStarted(true);
    playBootSound();
    void speakGreeting(voice);

    const orb = orbRef.current;
    if (orb) orb.setIntensity(0.7);

    (async () => {
      for (const p of BOOT_PROBES) {
        if (!aliveRef.current) return;
        const res = await runBootProbe(p);
        if (!aliveRef.current) return;
        setResults((prev) => [...prev, res]);
        orb?.setIntensity(0.9);
        setTimeout(() => orb?.setIntensity(0.35), 250);
        await new Promise((r) => setTimeout(r, 380));
      }
      if (aliveRef.current) setReady(true);
    })();
  }, [voice]);

  // Toque 2: inicia fade e encerra introdução
  const enter = useCallback(() => {
    if (fading) return;
    setFading(true);
    stopAudio();
    setTimeout(onDone, 500);
  }, [fading, onDone]);

  // Encaminha clique/tecla para o fluxo correto
  const handleGesture = useCallback(() => {
    if (!started) begin();
    else enter();
  }, [started, begin, enter]);

  // Troca a voz (persiste); se já acordou, re-toca na hora
  const toggleVoice = useCallback(
    (e: ReactMouseEvent) => {
      e.stopPropagation();
      const next: BootVoice = voice === "male" ? "female" : "male";
      setVoiceState(next);
      setBootVoice(next);
      if (started) void speakGreeting(next);
    },
    [voice, started]
  );

  // Permite acordar/entrar via teclado
  useEffect(() => {
    const onKey = () => handleGesture();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleGesture]);

  return (
    <div
      onClick={handleGesture}
      className={`fixed inset-0 z-[9999] flex items-center justify-center bg-[#05070a] transition-opacity duration-500 ${
        fading ? "opacity-0" : "opacity-100"
      }`}
    >
      <canvas ref={canvasRef} className="absolute inset-0 h-full w-full" />

      {/* Botão de voz no canto superior direito */}
      <button
        onClick={toggleVoice}
        className="absolute right-4 top-4 z-20 rounded-full border border-white/15 bg-white/5 px-3 py-1 font-mono text-[11px] text-white/70 hover:border-white/30 hover:text-white"
      >
        {voice === "male" ? "♂ Adam" : "♀ Ophelia"}
      </button>

      <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center font-mono select-none">
        <div className="text-2xl font-semibold tracking-[0.3em]" style={{ color }}>
          OMNIRIFT
        </div>

        {started && <div className="text-sm text-white/70">{greeting}</div>}

        {started && (
          <div className="mt-2 flex flex-col gap-1 text-[11px]">
            {results.map((r, i) => (
              <div key={i} className="flex min-w-[260px] items-center justify-between gap-6">
                <span className="text-white/50">{r.label}</span>
                <span className={r.ok ? "text-emerald-400" : "text-white/30"}>{r.status}</span>
              </div>
            ))}
          </div>
        )}

        {!started ? (
          <div className="mt-4 animate-pulse text-[11px] uppercase tracking-widest text-white/60">
            clique ou tecle para acordar a FRIDAY
          </div>
        ) : !ready ? (
          <div className="mt-4 text-[11px] text-white/30">inicializando…</div>
        ) : (
          <div className="mt-4 animate-pulse text-[11px] uppercase tracking-widest text-white/60">
            clique ou tecle para entrar
          </div>
        )}
      </div>
    </div>
  );
}