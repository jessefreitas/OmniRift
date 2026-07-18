function clamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(v, max));
}

export type FridayOrbHandle = {
  start(): void;
  stop(): void;
  setIntensity(n: number): void;
  resize(): void;
};

export function createFridayOrb(
  canvas: HTMLCanvasElement,
  opts?: { color?: string }
): FridayOrbHandle {
  const ctx0 = canvas.getContext('2d');
  if (!ctx0) {
    return { start: () => {}, stop: () => {}, setIntensity: () => {}, resize: () => {} };
  }
  // Tipo explícito não-null: o narrowing do `if` não persiste dentro das closures (draw/resize).
  const ctx: CanvasRenderingContext2D = ctx0;

  const colorHex = opts?.color ?? '#38d6ff';
  const rgb = hexToRgb(colorHex);

  let rafId: number | null = null;
  let intensity = 0;
  let t = 0;
  let dpr = window.devicePixelRatio || 1;

  // partículas determinísticas, semeadas uma única vez
  const particleCount = 40;
  const particles = Array.from({ length: particleCount }, (_, i) => ({
    angle: (i / particleCount) * Math.PI * 2,
    radius: 0.22 + (i % 3) * 0.06,
    speed: (i % 2 === 0 ? 1 : -1) * (0.005 + (i / particleCount) * 0.01),
    size: 1.5 + (i % 4),
  }));

  function hexToRgb(hex: string): { r: number; g: number; b: number } {
    const cleaned = hex.replace('#', '');
    const bigint = parseInt(cleaned, 16);
    const r = (bigint >> 16) & 255;
    const g = (bigint >> 8) & 255;
    const b = bigint & 255;
    return { r, g, b };
  }

  function rgba(r: number, g: number, b: number, a: number): string {
    return `rgba(${r},${g},${b},${a})`;
  }

  function resize() {
    dpr = window.devicePixelRatio || 1;
    const rect = canvas.getBoundingClientRect();
    canvas.width = Math.floor(rect.width * dpr);
    canvas.height = Math.floor(rect.height * dpr);
    ctx.scale(dpr, dpr);
  }

  function setIntensity(n: number) {
    intensity = clamp(n, 0, 1);
  }

  function draw() {
    const rect = canvas.getBoundingClientRect();
    const w = rect.width;
    const h = rect.height;
    const cx = w / 2;
    const cy = h / 2;
    const baseRadius = Math.min(w, h) * 0.12;

    ctx.clearRect(0, 0, w, h);

    // 1) núcleo pulsante
    const pulse = Math.sin(t * 0.05) * (0.04 + intensity * 0.06);
    const coreRadius = baseRadius * (1 + pulse);
    const coreAlpha = 0.6 + intensity * 0.4;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, coreRadius * 2.5);
    grad.addColorStop(0, rgba(rgb.r, rgb.g, rgb.b, coreAlpha));
    grad.addColorStop(0.4, rgba(rgb.r, rgb.g, rgb.b, coreAlpha * 0.5));
    grad.addColorStop(1, rgba(rgb.r, rgb.g, rgb.b, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(cx, cy, coreRadius * 2.5, 0, Math.PI * 2);
    ctx.fill();

    // 2) anéis concêntricos girando
    ctx.lineWidth = 1.5;
    for (let i = 0; i < 3; i++) {
      const ringRadius = baseRadius * (1.8 + i * 0.6);
      const rotation = t * (0.002 + i * 0.001) * (i % 2 === 0 ? 1 : -1);
      const ringAlpha = 0.08 + intensity * 0.12;
      ctx.strokeStyle = rgba(rgb.r, rgb.g, rgb.b, ringAlpha);
      ctx.beginPath();
      for (let a = 0; a <= Math.PI * 2; a += 0.1) {
        const x = cx + Math.cos(a + rotation) * ringRadius;
        const y = cy + Math.sin(a + rotation) * ringRadius * (1 + i * 0.03);
        if (a === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.stroke();
    }

    // 3) partículas em órbita
    const maxDim = Math.min(w, h);
    for (const p of particles) {
      const orbitR = maxDim * p.radius * (1 + intensity * 0.1);
      const angle = p.angle + t * p.speed * (1 + intensity * 0.5);
      const px = cx + Math.cos(angle) * orbitR;
      const py = cy + Math.sin(angle) * orbitR;
      const size = p.size * (1 + intensity * 0.6);
      const alpha = 0.3 + intensity * 0.5;

      ctx.fillStyle = rgba(rgb.r, rgb.g, rgb.b, alpha);
      ctx.beginPath();
      ctx.arc(px, py, size, 0, Math.PI * 2);
      ctx.fill();
    }

    t++;
    rafId = requestAnimationFrame(draw);
  }

  function start() {
    if (rafId !== null) return;
    resize();
    rafId = requestAnimationFrame(draw);
  }

  function stop() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
  }

  return { start, stop, setIntensity, resize };
}