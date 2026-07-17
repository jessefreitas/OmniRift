import { useEffect, useRef, useState, useCallback, type MouseEvent as ReactMouseEvent } from "react";
import { buildHudSvg, pickAccent } from "@/lib/boot-hud";
import { BOOT_PROBES, runBootProbe, type ProbeResult } from "@/lib/boot-probes";
import { playBootSound, speakGreeting, stopAudio } from "@/lib/boot-audio";
import { getBootVoice, setBootVoice, type BootVoice } from "@/lib/boot-greeting";

const CSS = `
.bi-root{position:fixed;inset:0;z-index:9999;background:radial-gradient(circle at 50% 50%,#0d0f12 0%,#060708 70%);font-family:'Orbitron',system-ui,monospace;transition:opacity .5s;color:#dbe1e7;}
.bi-hud{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;z-index:10;}
.bi-hud svg{width:min(90vmin,640px);height:min(90vmin,640px);}
.bhud-spin{transform-origin:320px 320px;animation:bhudspin var(--dur,20s) linear infinite;animation-direction:var(--dir,normal);}
@keyframes bhudspin{to{transform:rotate(360deg);}}
.bi-brand{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;pointer-events:none;z-index:50;}
.bi-title{font-size:3rem;font-weight:700;letter-spacing:.45em;text-shadow:0 0 24px rgba(200,208,216,.6);}
.bi-cta{margin-top:1.4rem;font-size:.72rem;letter-spacing:.4em;text-transform:uppercase;color:rgba(255,255,255,.55);animation:bipulse 2.2s ease-in-out infinite;}
@keyframes bipulse{0%,100%{opacity:.35}50%{opacity:1}}
@keyframes biignite{0%{transform:rotate(0) scale(1);opacity:1}70%{transform:rotate(360deg) scale(1.3);opacity:.7}100%{transform:rotate(360deg) scale(1.6);opacity:0}}
.igniting .bi-hud{animation:biignite 1.5s cubic-bezier(.5,.05,.3,1) forwards;}
.loading .bi-hud,.ready .bi-hud,.entering .bi-hud{opacity:0;pointer-events:none;}
.igniting .bi-brand{opacity:0;transition:opacity .4s;}
.bi-loader{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);width:min(560px,80vw);opacity:0;pointer-events:none;z-index:60;transition:opacity .6s;}
.loading .bi-loader{opacity:1;}
.entering .bi-loader{opacity:0;}
.bi-bar{height:3px;background:rgba(255,255,255,.08);border-radius:2px;overflow:hidden;margin-bottom:16px;}
.bi-fill{height:100%;background:linear-gradient(90deg,#6b7280,#c0c8d0);box-shadow:0 0 12px rgba(200,208,216,.6);transition:width .35s ease;}
.bi-list{list-style:none;font-size:11px;letter-spacing:.12em;margin:0;padding:0;}
.bi-list li{display:flex;justify-content:space-between;padding:3px 0;color:rgba(215,222,228,.85);}
.bi-list li .ok{color:#9aa6b2;}
.bi-pct{text-align:right;font-size:10px;letter-spacing:.2em;color:rgba(255,255,255,.35);margin-top:10px;}
.bi-enter{position:absolute;left:50%;bottom:18%;transform:translateX(-50%);z-index:70;text-align:center;opacity:0;pointer-events:none;transition:opacity .6s;}
.ready .bi-enter{opacity:1;}
.bi-enter .rdy{font-size:14px;letter-spacing:.35em;text-shadow:0 0 16px rgba(200,208,216,.5);}
.bi-enter .go{margin-top:10px;font-size:11px;letter-spacing:.4em;text-transform:uppercase;color:rgba(255,255,255,.6);animation:bipulse 2s ease-in-out infinite;}
.bi-voice{position:absolute;right:16px;top:16px;z-index:80;border:1px solid rgba(255,255,255,.15);background:rgba(255,255,255,.05);border-radius:999px;padding:4px 12px;font:11px 'Orbitron',monospace;color:rgba(255,255,255,.7);cursor:pointer;}
`;

export function BootIntro({ onDone }: { onDone: () => void }) {
  const [hud] = useState(() => buildHudSvg());
  const [accent] = useState(() => (Math.random() < 0.4 ? pickAccent() : "#dbe1e7"));
  const [phase, setPhase] = useState<"idle"|"igniting"|"loading"|"ready"|"entering">("idle");
  const [results, setResults] = useState<ProbeResult[]>([]);
  const [voice, setVoiceState] = useState<BootVoice>(getBootVoice());
  const aliveRef = useRef(true);
  const phaseRef = useRef(phase); phaseRef.current = phase;

  useEffect(() => { aliveRef.current = true; return () => { aliveRef.current = false; stopAudio(); }; }, []);

  const startLoading = useCallback(() => {
    setPhase("loading");
    (async () => {
      for (const p of BOOT_PROBES) {
        if (!aliveRef.current) return;
        const res = await runBootProbe(p);
        if (!aliveRef.current) return;
        setResults((prev) => [...prev, res]);
        await new Promise((r) => setTimeout(r, 380));
      }
      if (aliveRef.current) setPhase("ready");
    })();
  }, []);

  const ignite = useCallback(() => {
    setPhase("igniting");
    playBootSound();
    void speakGreeting(voice);
    setTimeout(() => { if (aliveRef.current) startLoading(); }, 1500);
  }, [voice, startLoading]);

  const enter = useCallback(() => {
    setPhase("entering");
    stopAudio();
    setTimeout(onDone, 600);
  }, [onDone]);

  const onGesture = useCallback(() => {
    const ph = phaseRef.current;
    if (ph === "idle") ignite();
    else if (ph === "ready") enter();
  }, [ignite, enter]);

  const toggleVoice = useCallback((e: ReactMouseEvent) => {
    e.stopPropagation();
    const next: BootVoice = voice === "male" ? "female" : "male";
    setVoiceState(next); setBootVoice(next);
  }, [voice]);

  const pct = BOOT_PROBES.length ? Math.round(results.length / BOOT_PROBES.length * 100) : 0;

  return (
    <div className={`bi-root ${phase}`} onClick={onGesture} style={{ opacity: phase === "entering" ? 0 : 1 }}>
      <style>{CSS}</style>
      <button className="bi-voice" onClick={toggleVoice}>{voice === "male" ? "♂ Adam" : "♀ Maria"}</button>
      <div className="bi-hud" dangerouslySetInnerHTML={{ __html: hud }} />
      <div className="bi-brand">
        <div className="bi-title" style={{ color: accent }}>OMNIRIFT</div>
        <div className="bi-cta">clique para iniciar</div>
      </div>
      <div className="bi-loader">
        <div className="bi-bar"><div className="bi-fill" style={{ width: pct + "%" }} /></div>
        <ul className="bi-list">
          {results.map((r, i) => (<li key={i}><span>{r.label}</span><span className="ok">{r.status}</span></li>))}
        </ul>
        <div className="bi-pct">{pct}%</div>
      </div>
      <div className="bi-enter"><div className="rdy">SISTEMA PRONTO</div><div className="go">clique para entrar</div></div>
    </div>
  );
}