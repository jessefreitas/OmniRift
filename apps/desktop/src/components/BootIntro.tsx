import { useEffect, useRef, useState, useCallback } from "react";
import { createFridayOrb, type FridayOrbHandle } from "@/lib/friday-orb";
import { BOOT_PROBES, runBootProbe, type ProbeResult } from "@/lib/boot-probes";
import { playBootSound, speakGreeting, stopAudio } from "@/lib/boot-audio";

export function BootIntro({
  onDone,
  greeting = "Bom dia. Sistemas OmniRift online.",
  color = "#38d6ff",
}: {
  onDone: () => void;
  greeting?: string;
  color?: string;
}) {
  // refs do orb, canvas e ciclo de vida
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const orbRef = useRef<FridayOrbHandle | null>(null);
  const aliveRef = useRef(true);

  // estado da introdução
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [started, setStarted] = useState(false);
  const [ready, setReady] = useState(false);
  const [fading, setFading] = useState(false);

  // inicializa o orb ao montar
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

  // inicia áudio e sequência de probes no primeiro gesto
  const begin = useCallback(() => {
    setStarted(true);
    playBootSound();
    void speakGreeting(greeting);

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
  }, [greeting]);

  // finaliza a intro e chama o callback
  const enter = useCallback(() => {
    if (fading) return;
    setFading(true);
    stopAudio();
    setTimeout(onDone, 500);
  }, [fading, onDone]);

  // clique/tecla disparam o fluxo
  const handleGesture = useCallback(() => {
    if (!started) begin();
    else enter();
  }, [started, begin, enter]);

  // escuta teclado globalmente
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
      <div className="relative z-10 flex flex-col items-center gap-6 px-6 text-center font-mono select-none">
        <div
          className="text-2xl font-semibold tracking-[0.3em]"
          style={{ color }}
        >
          OMNIRIFT
        </div>

        {started && (
          <div className="text-sm text-white/70">{greeting}</div>
        )}

        {started && (
          <div className="mt-2 flex flex-col gap-1 text-[11px]">
            {results.map((r, i) => (
              <div
                key={i}
                className="flex items-center justify-between gap-6 min-w-[260px]"
              >
                <span className="text-white/50">{r.label}</span>
                <span className={r.ok ? "text-emerald-400" : "text-white/30"}>
                  {r.status}
                </span>
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