// src/lib/product-profile.ts
//
// Profile runtime do produto: `pocket` (SKU simples) | `full` (Stable completo).
// NÃO é canal compile-time — um binário só; a superfície muda por preferência.
// First-run sem chave → default `pocket`. Spec:
// docs/superpowers/specs/2026-07-25-omnirift-pocket-design.md

import { useSyncExternalStore } from "react";
import type { NodeKind } from "@/types/canvas";

export type ProductProfile = "pocket" | "full";

export const PRODUCT_PROFILE_KEY = "omnirift-product-profile";

/** Tools visíveis no Pocket (sidebar / open-tool / atalhos). Fonte de verdade do MVP. */
export const POCKET_TOOL_IDS: readonly string[] = [
  "settings",
  "help",
  "appearance",
  "clis",
  "llm-providers",
  "companion",
  "git",
] as const;

/** Node kinds criáveis no Pocket (toolbar / palette “Criar”). */
export const POCKET_NODE_KINDS: readonly NodeKind[] = [
  "agent",
  "terminal",
  "note",
] as const;

const POCKET_TOOL_SET = new Set(POCKET_TOOL_IDS);
const POCKET_NODE_SET = new Set<NodeKind>(POCKET_NODE_KINDS);

type Listener = () => void;
const listeners = new Set<Listener>();

/** Último set nesta sessão (sobrevive falha de localStorage; testes sem DOM). */
let sessionProfile: ProductProfile | null = null;
/** Override só pra testes — tem precedência sobre session/localStorage. */
let testOverride: ProductProfile | null = null;

function notify() {
  for (const l of listeners) l();
}

function readRaw(): string | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage.getItem(PRODUCT_PROFILE_KEY);
  } catch {
    return null;
  }
}

/** Parse seguro. Valor inválido / ausente → `pocket` (first-run default). */
export function parseProductProfile(raw: string | null | undefined): ProductProfile {
  if (raw === "full") return "full";
  return "pocket";
}

export function getProductProfile(): ProductProfile {
  if (testOverride !== null) return testOverride;
  if (sessionProfile !== null) return sessionProfile;
  return parseProductProfile(readRaw());
}

export function setProductProfile(profile: ProductProfile): void {
  sessionProfile = profile;
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(PRODUCT_PROFILE_KEY, profile);
    }
  } catch {
    /* storage cheio / private mode — sessionProfile cobre esta sessão */
  }
  notify();
}

/** @internal — testes: força profile sem tocar storage. `null` limpa o override. */
export function __setProductProfileForTests(profile: ProductProfile | null): void {
  testOverride = profile;
  notify();
}

export function isPocket(profile: ProductProfile = getProductProfile()): boolean {
  return profile === "pocket";
}

export function isToolAllowed(
  toolId: string,
  profile: ProductProfile = getProductProfile(),
): boolean {
  if (profile === "full") return true;
  return POCKET_TOOL_SET.has(toolId);
}

export function isNodeKindAllowed(
  kind: NodeKind,
  profile: ProductProfile = getProductProfile(),
): boolean {
  if (profile === "full") return true;
  return POCKET_NODE_SET.has(kind);
}

export function filterToolsByProfile<T extends { id: string }>(
  tools: readonly T[],
  profile: ProductProfile = getProductProfile(),
): T[] {
  if (profile === "full") return [...tools];
  return tools.filter((t) => POCKET_TOOL_SET.has(t.id));
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  ensureStorageListener();
  return () => {
    listeners.delete(listener);
  };
}

/** Um único listener de storage pro cross-tab — evita N listeners por useProductProfile. */
let storageHooked = false;
function ensureStorageListener() {
  if (storageHooked || typeof window === "undefined") return;
  storageHooked = true;
  window.addEventListener("storage", (e: StorageEvent) => {
    if (e.key !== PRODUCT_PROFILE_KEY) return;
    sessionProfile = null; // re-lê do storage da outra aba
    notify();
  });
}

/** Hook React — re-render quando o profile muda. */
export function useProductProfile(): ProductProfile {
  return useSyncExternalStore(subscribe, getProductProfile, () => "pocket");
}
