let audioCtx: AudioContext | null = null;

function getAudioContext(): AudioContext | null {
  if (typeof window === "undefined") return null;
  const AC = window.AudioContext || (window as any).webkitAudioContext;
  if (!AC) return null;
  try {
    if (!audioCtx) audioCtx = new AC();
  } catch {
    return null;
  }
  return audioCtx;
}

export function playBootSound(): void {
  const ctx = getAudioContext();
  if (!ctx) return;

  try {
    // Garante que o contexto esteja rodando (navegadores bloqueiam autoplay)
    if (ctx.state === "suspended") ctx.resume();

    const now = ctx.currentTime;

    // Oscilador principal: sweep de power-up
    const osc = ctx.createOscillator();
    osc.type = "sawtooth";
    osc.frequency.setValueAtTime(120, now);
    osc.frequency.exponentialRampToValueAtTime(880, now + 0.9);

    const gain = ctx.createGain();
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.linearRampToValueAtTime(0.15, now + 0.05);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 1.2);

    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 1.3);

    // Ping agudo de brilho
    const ping = ctx.createOscillator();
    ping.type = "sine";
    ping.frequency.setValueAtTime(1200, now + 0.2);

    const pingGain = ctx.createGain();
    pingGain.gain.setValueAtTime(0.0001, now + 0.2);
    pingGain.gain.linearRampToValueAtTime(0.08, now + 0.25);
    pingGain.gain.exponentialRampToValueAtTime(0.0001, now + 0.55);

    ping.connect(pingGain);
    pingGain.connect(ctx.destination);
    ping.start(now + 0.2);
    ping.stop(now + 0.6);
  } catch {
    // WebKitGTK pode não expor toda a API; falha silenciosa
  }
}

export function speakGreeting(text: string): Promise<boolean> {
  return new Promise((resolve) => {
    if (
      typeof window === "undefined" ||
      !window.speechSynthesis ||
      typeof SpeechSynthesisUtterance === "undefined"
    ) {
      resolve(false);
      return;
    }

    try {
      window.speechSynthesis.cancel();

      const utter = new SpeechSynthesisUtterance(text);
      utter.lang = "pt-BR";
      utter.rate = 0.95;
      utter.pitch = 1.0;

      const timeout = setTimeout(() => resolve(false), 6000);

      utter.onend = () => {
        clearTimeout(timeout);
        resolve(true);
      };

      utter.onerror = () => {
        clearTimeout(timeout);
        resolve(false);
      };

      window.speechSynthesis.speak(utter);
    } catch {
      resolve(false);
    }
  });
}

export function stopAudio(): void {
  if (typeof window !== "undefined" && window.speechSynthesis) {
    try {
      window.speechSynthesis.cancel();
    } catch {
      // ignora
    }
  }

  if (audioCtx) {
    try {
      audioCtx.close();
    } catch {
      // ignora
    }
    audioCtx = null;
  }
}