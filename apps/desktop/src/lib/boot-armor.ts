// Cena canvas do boot "power-on" estilo JARVIS: a armadura holográfica monta ao
// centro a partir de peças explodidas, com HUD operando (rede neural, gauges,
// barras, módulos inicializando) e os olhos do visor acendendo ao ficar pronto.
// Cor (hue) e sentido de rotação são aleatórios por boot.
// Portado de gen_armor.py — SEM áudio (só a saudação toca, no BootIntro) e SEM
// manipulação de brand (também no BootIntro).
import { ARM } from "./boot-armor-data";

export interface ArmorScene {
  stop: () => void;
  progress: () => number;
  redo: () => void;
  hue: number;
}

interface Item {
  p2d: Path2D;
  cx: number;
  cy: number;
  ex: number;
  ey: number;
  rot: number;
  p: number;
  delay: number;
  target: number;
  ph: number;
}
interface NeuralNode {
  x: number;
  y: number;
  ph: number;
}
type Edge = [number, number, number];

export function runArmorScene(cv: HTMLCanvasElement): ArmorScene {
  const ctx = cv.getContext("2d");
  if (!ctx) return { stop: () => {}, progress: () => 0, redo: () => {}, hue: 0 };

  let W = 0;
  let H = 0;
  let dpr = 1;
  let S = 1;

  function resize() {
    dpr = Math.min(devicePixelRatio, 2);
    W = innerWidth;
    H = innerHeight;
    cv.width = W * dpr;
    cv.height = H * dpr;
    // Canvas é elemento *replaced*: sem width/height de CSS ele é exibido no
    // tamanho INTRÍNSECO (= buffer, dpr vezes maior que a janela) e o `right:0`
    // do `inset:0` é descartado por over-constraint — em dpr=2 a cena inteira
    // saía ancorada à esquerda com o dobro do tamanho, jogando o que é desenhado
    // em W/2 (a armadura) para a borda direita. Travar aqui, e não no CSS, faz o
    // dimensionamento viajar junto com a cena.
    cv.style.width = W + "px";
    cv.style.height = H + "px";
    ctx!.setTransform(dpr, 0, 0, dpr, 0, 0);
    S = (Math.min(W / ARM.VW, H / ARM.VH) * 0.52);
  }
  resize();
  addEventListener("resize", resize);

  function toScreen(vx: number, vy: number): [number, number] {
    return [W / 2 + (vx - ARM.VW / 2) * S, H / 2 + (vy - ARM.VH / 2) * S];
  }

  const HUE = Math.floor(Math.random() * 360);
  const AC = "hsla(" + HUE + ",82%,72%,";
  const WH = "hsla(" + HUE + ",75%,92%,";
  const SH = "hsl(" + HUE + ",92%,70%)";
  const ARMC = "hsl(" + HUE + ",60%,93%)";
  const RSPIN = Math.random() < 0.5 ? 1 : -1;
  const RVAR = 0.6 + Math.random() * 1.1;

  const items: Item[] = ARM.items.map((it) => {
    const dx = it.cx - ARM.VW / 2;
    const dy = it.cy - ARM.VH / 2;
    const ang = Math.atan2(dy, dx);
    const dist = 120 + Math.random() * 220;
    return {
      p2d: new Path2D(it.d),
      cx: it.cx,
      cy: it.cy,
      ex: Math.cos(ang) * dist,
      ey: Math.sin(ang) * dist,
      rot: (Math.random() - 0.5) * 2.4 * RSPIN,
      p: 0,
      delay: Math.random() * 0.7,
      target: 1,
      ph: Math.random() * 6.28,
    };
  });

  let t = 0;
  let busy = false;
  let op = 0;

  const NODES: NeuralNode[] = [];
  const EDGES: Edge[] = [];
  (function () {
    const n = 54;
    for (let i = 0; i < n; i++) NODES.push({ x: Math.random(), y: Math.random(), ph: Math.random() * 6.28 });
    for (let i = 0; i < n; i++) {
      const d: [number, number][] = [];
      for (let j = 0; j < n; j++)
        if (i !== j) {
          const dx = NODES[i].x - NODES[j].x;
          const dy = NODES[i].y - NODES[j].y;
          d.push([dx * dx + dy * dy, j]);
        }
      d.sort((a, b) => a[0] - b[0]);
      for (let k = 0; k < 2; k++) EDGES.push([i, d[k][1], Math.random()]);
    }
  })();

  function txt(s: string, x: number, y: number, sz?: number, al?: number, ce?: boolean) {
    ctx!.font = "600 " + (sz || 10) + "px Orbitron,monospace";
    ctx!.fillStyle = AC + (al || 0.6) + ")";
    ctx!.textAlign = ce ? "center" : "left";
    ctx!.fillText(s, x, y);
    ctx!.textAlign = "left";
  }

  function neural() {
    EDGES.forEach((e) => {
      const a = NODES[e[0]];
      const b = NODES[e[1]];
      const ax = a.x * W;
      const ay = a.y * H;
      const bx = b.x * W;
      const by = b.y * H;
      ctx!.strokeStyle = AC + "0.07)";
      ctx!.lineWidth = 1;
      ctx!.beginPath();
      ctx!.moveTo(ax, ay);
      ctx!.lineTo(bx, by);
      ctx!.stroke();
      const p = (t * 0.22 + e[2]) % 1;
      const px = ax + (bx - ax) * p;
      const py = ay + (by - ay) * p;
      ctx!.fillStyle = WH + (0.45 * (1 - Math.abs(p - 0.5) * 2)).toFixed(3) + ")";
      ctx!.shadowColor = SH;
      ctx!.shadowBlur = 6;
      ctx!.beginPath();
      ctx!.arc(px, py, 1.5, 0, 7);
      ctx!.fill();
      ctx!.shadowBlur = 0;
    });
    NODES.forEach((nd) => {
      const pu = 0.22 + 0.22 * Math.sin(t * 2 + nd.ph);
      ctx!.fillStyle = AC + pu.toFixed(3) + ")";
      ctx!.beginPath();
      ctx!.arc(nd.x * W, nd.y * H, 1.7, 0, 7);
      ctx!.fill();
    });
  }

  function gauge(gx: number, gy: number, r: number, frac: number, label: string, val: string) {
    ctx!.lineWidth = 1;
    ctx!.strokeStyle = AC + "0.16)";
    for (let a = 0; a < 270; a += 6) {
      const rd = ((135 + a) * Math.PI) / 180;
      ctx!.beginPath();
      ctx!.moveTo(gx + Math.cos(rd) * r, gy + Math.sin(rd) * r);
      ctx!.lineTo(gx + Math.cos(rd) * (r - 8), gy + Math.sin(rd) * (r - 8));
      ctx!.stroke();
    }
    ctx!.lineWidth = 3;
    ctx!.strokeStyle = AC + "0.12)";
    ctx!.beginPath();
    ctx!.arc(gx, gy, r - 15, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5);
    ctx!.stroke();
    ctx!.strokeStyle = WH + "0.9)";
    ctx!.shadowColor = SH;
    ctx!.shadowBlur = 8;
    ctx!.beginPath();
    ctx!.arc(gx, gy, r - 15, Math.PI * 0.75, Math.PI * 0.75 + Math.PI * 1.5 * frac);
    ctx!.stroke();
    ctx!.shadowBlur = 0;
    ctx!.strokeStyle = AC + "0.3)";
    ctx!.lineWidth = 1.4;
    ctx!.beginPath();
    ctx!.arc(gx, gy, r - 28, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * ((t * 0.15 * RSPIN + frac) % 1));
    ctx!.stroke();
    ctx!.strokeStyle = AC + "0.18)";
    ctx!.beginPath();
    ctx!.arc(gx, gy, r - 38, 0, 7);
    ctx!.stroke();
    ctx!.shadowColor = SH;
    ctx!.shadowBlur = 7;
    txt(val, gx, gy + 6, 21, 0.95, true);
    ctx!.shadowBlur = 0;
    txt(label, gx, gy + r + 16, 10, 0.5, true);
  }

  function bars(px: number, py: number, w: number, title: string, rows: [string, number][]) {
    ctx!.strokeStyle = AC + "0.35)";
    ctx!.lineWidth = 1.2;
    ctx!.beginPath();
    ctx!.moveTo(px + 12, py - 18);
    ctx!.lineTo(px, py - 18);
    ctx!.lineTo(px, py + rows.length * 24 + 4);
    ctx!.lineTo(px + 12, py + rows.length * 24 + 4);
    ctx!.stroke();
    txt(title, px + 12, py - 7, 12, 0.75);
    rows.forEach((rw, i) => {
      const yy = py + 12 + i * 24;
      const f = rw[1];
      txt(rw[0], px + 12, yy, 10, 0.5);
      ctx!.strokeStyle = AC + "0.18)";
      ctx!.lineWidth = 1;
      ctx!.strokeRect(px + w - 96, yy - 9, 90, 7);
      ctx!.fillStyle = WH + "0.85)";
      ctx!.shadowColor = SH;
      ctx!.shadowBlur = 6;
      ctx!.fillRect(px + w - 96, yy - 9, 90 * f, 7);
      ctx!.shadowBlur = 0;
      txt(String(Math.round(f * 100)), px + w - 2, yy, 9, 0.6);
    });
  }

  function wave(px: number, py: number, w: number, h: number, seed: number) {
    ctx!.strokeStyle = WH + "0.7)";
    ctx!.lineWidth = 1.3;
    ctx!.shadowColor = SH;
    ctx!.shadowBlur = 6;
    ctx!.beginPath();
    for (let i = 0; i <= w; i += 3) {
      const yy = py + Math.sin(i * 0.08 + t * 3 + seed) * h * Math.sin(i * 0.02 + t) * 0.9;
      if (i) ctx!.lineTo(px + i, yy);
      else ctx!.moveTo(px + i, yy);
    }
    ctx!.stroke();
    ctx!.shadowBlur = 0;
  }

  function seg(gx: number, gy: number, r: number, sp: number) {
    ctx!.strokeStyle = AC + "0.4)";
    ctx!.lineWidth = 1.5;
    for (let k = 0; k < 6; k++) {
      const a0 = t * sp * RSPIN + (k * Math.PI) / 3;
      ctx!.beginPath();
      ctx!.arc(gx, gy, r, a0, a0 + 0.5);
      ctx!.stroke();
    }
  }

  function readout(x: number, y: number, label: string, val: string) {
    txt(label, x, y, 9, 0.4);
    ctx!.shadowColor = SH;
    ctx!.shadowBlur = 4;
    txt(val, x, y + 15, 12, 0.8);
    ctx!.shadowBlur = 0;
  }

  const MODS = ["CANVAS ENGINE", "PTY MANAGER", "AGENTES ACP", "MEMORIA", "FLOORS", "OMNIFS", "OMNIGRAPH", "OMNISWITCH", "ROUTINES"];
  function modules(o: number) {
    const x = 52;
    const y0 = 262;
    txt("INICIALIZANDO MODULOS", x, y0 - 14, 10, 0.6);
    MODS.forEach((nm, i) => {
      const thr = ((i + 1) / MODS.length) * 0.96;
      const st = o >= thr;
      const ld = !st && o >= thr - 0.14;
      const yy = y0 + i * 22;
      ctx!.strokeStyle = AC + "0.3)";
      ctx!.lineWidth = 1;
      ctx!.strokeRect(x, yy - 8, 10, 10);
      if (st) {
        ctx!.fillStyle = WH + "0.9)";
        ctx!.shadowColor = SH;
        ctx!.shadowBlur = 5;
        ctx!.fillRect(x + 2.5, yy - 5.5, 5, 5);
        ctx!.shadowBlur = 0;
      } else if (ld) {
        ctx!.fillStyle = AC + (0.3 + 0.35 * Math.sin(t * 9 + i)).toFixed(3) + ")";
        ctx!.fillRect(x + 2.5, yy - 5.5, 5, 5);
      }
      txt(nm, x + 18, yy, 10, st ? 0.82 : ld ? 0.55 : 0.28);
      txt(st ? "OK" : ld ? "..." : "---", x + 158, yy, 9, st ? 0.7 : 0.35);
    });
  }

  let raf = 0;
  let running = true;

  function loop() {
    if (!running) return;
    raf = requestAnimationFrame(loop);
    t += 0.016;
    ctx!.clearRect(0, 0, W, H);
    const cx = W / 2;
    const cy = H / 2;
    const R = Math.min(W, H);
    neural();
    ctx!.strokeStyle = AC + "0.06)";
    ctx!.lineWidth = 1;
    for (let a = 0; a < 360; a += 30) {
      const rd = ((a + t * 3 * RVAR * RSPIN) * Math.PI) / 180;
      ctx!.beginPath();
      ctx!.moveTo(cx + Math.cos(rd) * R * 0.2, cy + Math.sin(rd) * R * 0.2);
      ctx!.lineTo(cx + Math.cos(rd) * R * 0.72, cy + Math.sin(rd) * R * 0.72);
      ctx!.stroke();
    }
    ctx!.strokeStyle = AC + "0.16)";
    ctx!.lineWidth = 1.3;
    ([[0.48, [34, 20], 1], [0.54, [6, 12], -0.8], [0.6, [90, 50], 0.6], [0.66, [2, 8], -0.5], [0.72, [120, 40], 0.35]] as [number, number[], number][]).forEach((rr) => {
      ctx!.setLineDash(rr[1]);
      ctx!.lineDashOffset = t * 30 * rr[2] * RVAR * RSPIN;
      ctx!.beginPath();
      ctx!.arc(cx, cy, R * rr[0], 0, 7);
      ctx!.stroke();
    });
    ctx!.setLineDash([]);
    ctx!.strokeStyle = AC + "0.14)";
    ctx!.lineWidth = 2;
    for (let a = 0; a < 360; a += 6) {
      const rd = ((a + t * 6 * RSPIN) * Math.PI) / 180;
      ctx!.beginPath();
      ctx!.moveTo(cx + Math.cos(rd) * R * 0.66, cy + Math.sin(rd) * R * 0.66);
      ctx!.lineTo(cx + Math.cos(rd) * R * 0.685, cy + Math.sin(rd) * R * 0.685);
      ctx!.stroke();
    }
    const lw = 1.5 / (S * Math.abs(ARM.sy));
    let settled = 0;
    items.forEach((it) => {
      if (t > it.delay) it.p += (it.target - it.p) * 0.1;
      const e = 1 - it.p;
      if (it.p > 0.97) settled++;
      const br = Math.sin(t * 1.2 + it.ph) * 3 * it.p;
      const gl = 6 + e * 16;
      ctx!.shadowColor = SH;
      ctx!.shadowBlur = gl;
      ctx!.strokeStyle = ARMC;
      ctx!.lineJoin = "round";
      ctx!.lineCap = "round";
      ctx!.lineWidth = lw;
      ctx!.save();
      ctx!.translate(W / 2, H / 2);
      ctx!.scale(S, S);
      ctx!.translate(-ARM.VW / 2, -ARM.VH / 2);
      ctx!.translate(it.cx, it.cy + br);
      ctx!.translate(it.ex * e, it.ey * e);
      ctx!.rotate(it.rot * e);
      ctx!.translate(-it.cx, -it.cy);
      ctx!.translate(ARM.tx, ARM.ty);
      ctx!.scale(ARM.sx, ARM.sy);
      ctx!.globalAlpha = Math.min(1, it.p * 1.4);
      ctx!.stroke(it.p2d);
      ctx!.restore();
    });
    ctx!.globalAlpha = 1;
    ctx!.shadowBlur = 0;
    op = settled / items.length;
    const eyeOn = Math.max(0, Math.min(1, (op - 0.82) / 0.18));
    if (eyeOn > 0) {
      const ec = toScreen(ARM.VW * 0.5, ARM.VH * 0.205);
      const exo = ARM.VW * 0.052 * S;
      const pu = 0.65 + 0.35 * Math.sin(t * 4);
      ctx!.save();
      ctx!.globalCompositeOperation = "screen";
      [-1, 1].forEach((sd) => {
        const ex = ec[0] + sd * exo;
        const ey = ec[1];
        const g = ctx!.createRadialGradient(ex, ey, 0, ex, ey, 30 * eyeOn);
        g.addColorStop(0, "rgba(255,255,255," + pu * eyeOn + ")");
        g.addColorStop(0.4, WH + 0.7 * eyeOn + ")");
        g.addColorStop(1, "rgba(0,0,0,0)");
        ctx!.fillStyle = g;
        ctx!.beginPath();
        ctx!.arc(ex, ey, 30 * eyeOn, 0, 7);
        ctx!.fill();
        ctx!.fillStyle = "rgba(240,252,255," + pu * eyeOn + ")";
        ctx!.beginPath();
        ctx!.ellipse(ex, ey, 10 * eyeOn, 3.4 * eyeOn, sd * 0.32, 0, 7);
        ctx!.fill();
      });
      ctx!.restore();
    }
    gauge(130, H - 140, 80, 0.35 + 0.4 * (0.5 + 0.5 * Math.sin(t * 0.6)) * op, "NUCLEO", Math.round((55 + 35 * Math.sin(t * 0.6)) * op) + "%");
    gauge(W - 130, H - 140, 80, 0.3 + 0.45 * (0.5 + 0.5 * Math.sin(t * 0.85 + 1)) * op, "FLUXO", Math.round((48 + 40 * Math.sin(t * 0.85 + 1)) * op) + "%");
    bars(52, 116, 210, "SISTEMA", [["CPU", (0.35 + 0.25 * Math.sin(t * 0.9)) * op], ["GPU", (0.6 + 0.25 * Math.sin(t * 1.1)) * op], ["I/O", (0.5 + 0.3 * Math.sin(t * 1.6)) * op], ["TEMP", 0.48 * op]]);
    bars(W - 262, 116, 210, "REDE NEURAL", [["LINK", 0.88 * op], ["SYNC", (0.6 + 0.3 * Math.sin(t * 1.2 + 2)) * op], ["MEM", (0.5 + 0.25 * Math.sin(t * 0.7 + 2)) * op], ["AGENTES", 0.75 * op]]);
    wave(cx - 150, 120, 300, 16, 0);
    seg(130, 166, 22, 0.9);
    seg(W - 130, 166, 22, -0.9);
    modules(op);
    readout(52, H - 230, "LATENCIA", 8 + Math.round(6 * (0.5 + 0.5 * Math.sin(t * 2))) + "ms");
    readout(W - 150, H - 230, "THROUGHPUT", Math.round(op * 1240) + " t/s");
    readout(52, H - 190, "NODOS", NODES.length + "/" + NODES.length);
    readout(W - 150, H - 190, "ENLACES", EDGES.length + "");
    ctx!.strokeStyle = AC + "0.22)";
    ctx!.lineWidth = 1;
    for (let yy = 200; yy < H - 260; yy += 16) {
      const big = yy % 80 < 16;
      ctx!.beginPath();
      ctx!.moveTo(16, yy);
      ctx!.lineTo(16 + (big ? 16 : 8), yy);
      ctx!.stroke();
      ctx!.beginPath();
      ctx!.moveTo(W - 16, yy);
      ctx!.lineTo(W - 16 - (big ? 16 : 8), yy);
      ctx!.stroke();
    }
    txt("OMNIRIFT CORE // " + (op > 0.98 ? "ONLINE" : "BOOT " + Math.round(op * 100) + "%"), cx, 42, 12, 0.6, true);
    ctx!.strokeStyle = AC + "0.4)";
    ctx!.lineWidth = 2;
    const m = 16;
    const L = 34;
    ([[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]] as [number, number, number, number][]).forEach((c) => {
      ctx!.beginPath();
      ctx!.moveTo(c[0] + c[2] * L, c[1]);
      ctx!.lineTo(c[0], c[1]);
      ctx!.lineTo(c[0], c[1] + c[3] * L);
      ctx!.stroke();
    });
    const scy = (t * 0.2 % 1) * H;
    ctx!.fillStyle = AC + "0.28)";
    ctx!.fillRect(0, scy, W, 1);
  }

  function redo() {
    if (busy) return;
    busy = true;
    items.forEach((it) => {
      it.target = 0;
    });
    setTimeout(() => {
      items.forEach((it) => {
        it.target = 1;
        it.delay = t + Math.random() * 0.6;
      });
      setTimeout(() => {
        busy = false;
      }, 1600);
    }, 600);
  }

  function stop() {
    running = false;
    cancelAnimationFrame(raf);
    removeEventListener("resize", resize);
  }

  loop();

  return { stop, progress: () => op, redo, hue: HUE };
}
