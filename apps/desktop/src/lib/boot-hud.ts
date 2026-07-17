// boot-hud.ts — gerador procedural de HUD sci-fi em SVG

const greys = ['#9aa6b2', '#c0c8d0', '#8a94a0', '#aeb6be', '#7d868f'];
const accents = ['#9fe6ff', '#ffb347', '#7CFFB2', '#a78bfa', '#ff6b81', '#c0c8d0'];
const dashes = ['24 16', '60 30', '8 12', '4 10', '40 10 6 10', '2 8', '80 40', '12 6 4 6'];

function rnd(a: number, b: number): number {
  return a + Math.random() * (b - a);
}

function ri(a: number, b: number): number {
  return Math.floor(rnd(a, b + 1));
}

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

export function pickAccent(): string {
  return pick(accents);
}

export function buildHudSvg(): string {
  const base = pick(greys);
  const accent = pick(accents);

  let svg = `<svg viewBox="0 0 640 640" xmlns="http://www.w3.org/2000/svg">
  <style>
    .bhud-spin {
      transform-origin: 320px 320px;
      animation: spin var(--dur, 20s) linear infinite;
      animation-direction: var(--dir, normal);
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>`;

  let r = rnd(70, 95);
  const n = ri(4, 7);

  // anéis concêntricos girando
  for (let i = 0; i < n; i++) {
    r += rnd(24, 40);
    const color = Math.random() < 0.25 ? accent : base;
    const dir = Math.random() < 0.5 ? 'normal' : 'reverse';

    svg += `
  <g class="bhud-spin" style="--dur:${rnd(8, 44).toFixed(1)}s;--dir:${dir}">
    <circle cx="320" cy="320" r="${r.toFixed(1)}" fill="none" stroke="${color}"
      stroke-width="${rnd(1.5, 6).toFixed(1)}" stroke-dasharray="${pick(dashes)}"
      opacity="${rnd(0.35, 0.75).toFixed(2)}" />
  </g>`;
  }

  // ticks radiais no anel externo
  const tR = r + rnd(6, 20);
  const step = pick([6, 10, 12, 15]);
  let ticks = '';

  for (let a = 0; a < 360; a += step) {
    const rad = (a * Math.PI) / 180;
    const x1 = 320 + Math.cos(rad) * tR;
    const y1 = 320 + Math.sin(rad) * tR;
    const x2 = 320 + Math.cos(rad) * (tR + 14);
    const y2 = 320 + Math.sin(rad) * (tR + 14);

    ticks += `    <line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}"
      stroke="${base}" stroke-width="2" opacity="0.4" />`;
  }

  svg += `
  <g class="bhud-spin" style="--dur:${rnd(30, 60).toFixed(1)}s;--dir:reverse">
${ticks}  </g>`;

  // hexágonos orbitando
  const hn = ri(3, 8);
  const hR = rnd(120, 200);
  let hexes = '';

  for (let h = 0; h < hn; h++) {
    const ang = (360 / hn) * h;
    const rad = (ang * Math.PI) / 180;
    const cx = 320 + Math.cos(rad) * hR;
    const cy = 320 + Math.sin(rad) * hR;

    let points = '';
    for (let k = 0; k < 6; k++) {
      const krad = ((k * 60) * Math.PI) / 180;
      const px = cx + Math.cos(krad) * 10;
      const py = cy + Math.sin(krad) * 10;
      points += `${px.toFixed(1)},${py.toFixed(1)} `;
    }

    hexes += `    <polygon points="${points.trim()}" fill="#6b7280" stroke="${accent}" stroke-width="1.5" />`;
  }

  svg += `
  <g class="bhud-spin" style="--dur:${rnd(18, 34).toFixed(1)}s">
${hexes}  </g>`;

  // arcos destacados
  const arcCount = ri(1, 3);

  for (let z = 0; z < arcCount; z++) {
    const ar = rnd(150, 260);
    const a0 = rnd(0, 360);
    const a1 = a0 + rnd(30, 110);

    const r0 = (a0 * Math.PI) / 180;
    const r1 = (a1 * Math.PI) / 180;

    const x0 = 320 + Math.cos(r0) * ar;
    const y0 = 320 + Math.sin(r0) * ar;
    const x1 = 320 + Math.cos(r1) * ar;
    const y1 = 320 + Math.sin(r1) * ar;

    const dir = Math.random() < 0.5 ? 'normal' : 'reverse';

    svg += `
  <g class="bhud-spin" style="--dur:${rnd(10, 40).toFixed(1)}s;--dir:${dir}">
    <path d="M ${x0.toFixed(1)} ${y0.toFixed(1)} A ${ar.toFixed(1)} ${ar.toFixed(1)} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)}"
      fill="none" stroke="${accent}" stroke-width="${rnd(3, 7).toFixed(1)}"
      opacity="0.6" stroke-linecap="round" />
  </g>`;
  }

  svg += `
</svg>`;

  return svg;
}