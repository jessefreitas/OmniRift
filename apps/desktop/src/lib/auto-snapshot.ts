// src/lib/auto-snapshot.ts
//
// "Cron" de backup do canvas: a cada N minutos grava um snapshot AUTOMÁTICO
// (rotaciona — mantém só os `maxAuto` mais recentes; manuais nunca são podados).
// Pula o backup quando o canvas não mudou desde o último (hash). Settings em
// localStorage. Ligar uma vez no boot com startAutoSnapshot().

import { useCanvasStore } from "@/store/canvas-store";
import { snapshotCreate, snapshotPruneAuto } from "@/lib/snapshot-client";

export interface AutoSnapSettings {
  enabled: boolean;
  /** Intervalo entre backups, em minutos. */
  intervalMin: number;
  /** Quantos backups automáticos manter (os mais antigos são podados). */
  maxAuto: number;
}

const KEY = "maestri-autosnap-v1";
const DEFAULTS: AutoSnapSettings = { enabled: true, intervalMin: 10, maxAuto: 20 };

function clampNum(v: unknown, lo: number, hi: number, dflt: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : dflt;
}

export function loadAutoSnapSettings(): AutoSnapSettings {
  try {
    const s = localStorage.getItem(KEY);
    if (!s) return { ...DEFAULTS };
    const v = JSON.parse(s);
    return {
      enabled: typeof v.enabled === "boolean" ? v.enabled : DEFAULTS.enabled,
      intervalMin: clampNum(v.intervalMin, 1, 720, DEFAULTS.intervalMin),
      maxAuto: clampNum(v.maxAuto, 1, 500, DEFAULTS.maxAuto),
    };
  } catch {
    return { ...DEFAULTS };
  }
}

export function saveAutoSnapSettings(s: AutoSnapSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    /* noop */
  }
  restartAutoSnapshot();
}

/** djb2 — hash barato pra detectar "o canvas não mudou desde o último backup". */
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return h;
}

function autoLabel(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `auto ${p(d.getHours())}:${p(d.getMinutes())}`;
}

let timer: ReturnType<typeof setInterval> | null = null;
let lastHash: number | null = null;

async function tick(maxAuto: number): Promise<void> {
  try {
    const doc = JSON.stringify(useCanvasStore.getState().getWorkspaceSnapshot());
    const h = hash(doc);
    if (h === lastHash) return; // canvas inalterado → não duplica backup
    await snapshotCreate(autoLabel(), doc, true);
    lastHash = h;
    await snapshotPruneAuto(maxAuto);
  } catch (e) {
    console.warn("[auto-snapshot] falhou:", e);
  }
}

/** (Re)arma o timer conforme as settings atuais. Idempotente. */
export function restartAutoSnapshot(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  const s = loadAutoSnapSettings();
  if (!s.enabled) return;
  timer = setInterval(() => void tick(s.maxAuto), s.intervalMin * 60_000);
}

/** Dispara um backup automático agora (usado pelo botão "backup agora"). */
export async function snapshotNow(): Promise<void> {
  const { maxAuto } = loadAutoSnapSettings();
  lastHash = null; // força gravar mesmo se inalterado
  await tick(maxAuto);
}

/** Para o timer (ex.: cleanup de unmount). Settings reativam no próximo boot. */
export function stopAutoSnapshot(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

/** Ligar UMA vez no boot do app. */
export function startAutoSnapshot(): void {
  restartAutoSnapshot();
}
