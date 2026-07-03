// src/lib/feature-flags.ts
//
// Sistema LEVE de feature flags — rollout gradual / kill-switch / gating de beta,
// 100% LOCAL (sem serviço externo). Inspirado no PostHog, mas sem rede: um registro
// estático (FLAGS) define o default de cada flag; o usuário sobrescreve por máquina
// e a escolha persiste em localStorage (`omnirift-feature-flags` = Record<key, bool>).
//
// Precedência do valor efetivo:
//   1) override local do usuário (localStorage)  — se existir
//   2) remoteDefault (rollout do servidor)        — RESERVADO, sempre vazio no MVP
//   3) default estático do FLAGS
//
// Consumo é OPCIONAL: declarar a flag + o painel já é o MVP. Ligar uma feature a
// `useFlag(key)` é aditivo e reversível — as flags das features atuais são default:true,
// então esquecer de consumir NÃO quebra nada.

import { create } from "zustand";

export type FlagStage = "stable" | "beta" | "experimental";

export interface FlagDef {
  key: string;
  label: string;
  description: string;
  /** Valor quando não há override local (nem rollout remoto). */
  default: boolean;
  /** Maturidade — só rótulo visual no painel, não afeta o valor. */
  stage?: FlagStage;
}

// Registro estático das flags conhecidas. Features RECÉM-ADICIONADAS entram como
// default:true (stable/beta) pra NÃO mudar o comportamento atual ao introduzir o
// sistema; a experimental (default:false) é o exemplo de kill-switch de um recurso
// ainda em construção — liga sob demanda.
export const FLAGS: FlagDef[] = [
  {
    key: "insights-por-agente",
    label: "Insights por agente",
    description:
      "Painel/anotações de insight que o Arquiteto de Pipeline gera por agente do time. Desligue pra esconder o bloco de insights.",
    default: true,
    stage: "stable",
  },
  {
    key: "workflow-templates",
    label: "Templates de workflow",
    description:
      "Menu de templates prontos de canvas (equipes/ondas) na toolbar. Desligue pra ocultar o atalho de templates.",
    default: true,
    stage: "beta",
  },
  {
    key: "conn-schema-validation",
    label: "Validação de schema nas conexões",
    description:
      "Valida o response-schema (conexões semânticas Fase 2) quando um agente passa saída pra outro. Desligue pra aceitar payload livre.",
    default: true,
    stage: "beta",
  },
  {
    key: "remote-4g-relay",
    label: "Acesso remoto 4G (relay)",
    description:
      "Controle remoto do canvas pelo celular via 4G através do relay próprio (Cloudflare Worker). Em construção — kill-switch: mantenha desligado até estabilizar.",
    default: false,
    stage: "experimental",
  },
  {
    key: "omnifs-auto-checkpoint",
    label: "Checkpoint automático (OmniFS)",
    description:
      "Cada turno de agente que edita arquivos vira um snapshot restaurável no drive OmniFS (undo por ação, com rollback no nó). Desligue pra economizar disco em drives OmniFS.",
    default: true,
    stage: "stable",
  },
  {
    key: "omnifs-semantic-search",
    label: "Busca semântica (OmniFS)",
    description:
      "Busca no drive dos agentes por SIGNIFICADO (\"a lógica de auth\"), não por nome de arquivo. 100% local (embeddings offline). Desligue pra ocultar a busca no painel do OmniFS.",
    default: true,
    stage: "stable",
  },
  {
    key: "omnigraph-import",
    label: "Grafo de código no canvas (OmniGraph)",
    description:
      "Botão \"importar visão\" que traz as comunidades do grafo de conhecimento do código pro canvas. Desligue pra ocultar o atalho na toolbar.",
    default: true,
    stage: "beta",
  },
  {
    key: "omnigraph-land-gate",
    label: "Gate estrutural no Land (OmniGraph)",
    description:
      "Ao concluir (Land), mede o blast-radius das mudanças contra o grafo do código e alerta quando tocam um god node / muitas comunidades. Desligue pra não gatear o Land pela estrutura.",
    default: true,
    stage: "beta",
  },
];

const FLAGS_BY_KEY: Record<string, FlagDef> = Object.fromEntries(FLAGS.map((f) => [f.key, f]));

const STORAGE_KEY = "omnirift-feature-flags";

// ── Gancho de ROLLOUT REMOTO (FUTURO — NÃO implementado no MVP) ────────────────
// O projeto já tem um Cloudflare Worker (license-worker: /download, /activate, …).
// Um endpoint tipo `GET /flags` poderia devolver { <key>: boolean } de rollout
// gradual por versão/coorte e popular `remoteDefaults` aqui. A precedência acima já
// deixa o override LOCAL do usuário ganhar do rollout do servidor (opt-out sempre
// possível). Quando entrar, basta:
//   const r = await fetch(`${WORKER}/flags`); const j = await r.json();
//   setRemoteDefaults(j);   // dispara re-render dos useFlag() via bump do store
// Por enquanto isto é sempre {} — o sistema é puramente local.
let remoteDefaults: Record<string, boolean> = {};

/** Reservado pro fetch remoto futuro — no MVP nada chama isto. */
export function setRemoteDefaults(map: Record<string, boolean>): void {
  const clean: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(map)) {
    if (k in FLAGS_BY_KEY && typeof v === "boolean") clean[k] = v;
  }
  remoteDefaults = clean;
  // Bump do store pra re-render dos assinantes (o valor efetivo pode ter mudado).
  useFeatureFlagStore.setState((s) => ({ overrides: { ...s.overrides } }));
}

function loadOverrides(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, boolean> = {};
    // Sanitiza: só chaves conhecidas + valores boolean (ignora lixo/flag renomeada).
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (k in FLAGS_BY_KEY && typeof v === "boolean") out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

function persist(overrides: Record<string, boolean>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
  } catch {
    /* localStorage indisponível — degrada em memória */
  }
}

/** Default efetivo (rollout remoto > default estático). Sem override local. */
function effectiveDefault(key: string): boolean {
  if (key in remoteDefaults) return remoteDefaults[key];
  return FLAGS_BY_KEY[key]?.default ?? false;
}

interface FlagState {
  /** SÓ os overrides do usuário (chave ausente = usa o default). */
  overrides: Record<string, boolean>;
  setFlag: (key: string, val: boolean) => void;
  resetFlag: (key: string) => void;
  resetAll: () => void;
}

export const useFeatureFlagStore = create<FlagState>((set) => ({
  overrides: loadOverrides(),
  setFlag: (key, val) =>
    set((s) => {
      const next = { ...s.overrides, [key]: val };
      persist(next);
      return { overrides: next };
    }),
  resetFlag: (key) =>
    set((s) => {
      if (!(key in s.overrides)) return s;
      const next = { ...s.overrides };
      delete next[key];
      persist(next);
      return { overrides: next };
    }),
  resetAll: () =>
    set(() => {
      persist({});
      return { overrides: {} };
    }),
}));

// ── API imperativa (fora de React — services, spawn, event handlers) ───────────
/** Valor efetivo da flag (override local > rollout remoto > default estático). */
export function getFlag(key: string): boolean {
  const ov = useFeatureFlagStore.getState().overrides;
  if (key in ov) return ov[key];
  return effectiveDefault(key);
}
export function setFlag(key: string, val: boolean): void {
  useFeatureFlagStore.getState().setFlag(key, val);
}
export function resetFlag(key: string): void {
  useFeatureFlagStore.getState().resetFlag(key);
}
export function resetAllFlags(): void {
  useFeatureFlagStore.getState().resetAll();
}
/** true se o usuário sobrescreveu a flag (≠ default) — pro badge/reset no painel. */
export function isOverridden(key: string): boolean {
  return key in useFeatureFlagStore.getState().overrides;
}

// ── Hook React ─────────────────────────────────────────────────────────────────
// SELETOR CONSERVADOR: retorna um PRIMITIVO boolean (nunca objeto/array inline). No
// zustand v5 um seletor que cria referência nova a cada render entra em loop infinito
// (o app já travou com isso). Aqui o retorno é `boolean`, sempre igual por valor.
export function useFlag(key: string): boolean {
  return useFeatureFlagStore((s) => (key in s.overrides ? s.overrides[key] : effectiveDefault(key)));
}
