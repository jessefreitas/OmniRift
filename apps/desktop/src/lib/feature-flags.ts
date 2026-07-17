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
    key: "agent-clean-hooks",
    label: "Agentes com config isolado (sem hooks globais)",
    description:
      "Agentes claude spawnados pelo canvas nascem com CLAUDE_CONFIG_DIR próprio (~/.omnirift/agent-claude-home): os hooks e skills GLOBAIS do seu ~/.claude não carregam neles — sem isso, cada turno de agente pagava minutos de Stop hooks herdados, atrasando a conversa entre agentes (agent_ask). Os hooks do OmniRift (status/review/failproof) continuam, via --settings. Credenciais são copiadas do login principal. Kill-switch: desligue pra voltar a herdar seu ~/.claude inteiro.",
    default: true,
    stage: "beta",
  },
  {
    key: "failproof-agents",
    label: "Agentes aprendem com erros (failproof)",
    description:
      "Cada agente que você monta captura os próprios erros→correções e recebe de volta o fix conhecido quando o mesmo tropeço reaparece (distingue palpite de correção confirmada). Roda local e privado. Kill-switch: o captor roda um pequeno processo a cada comando de terminal do agente — desligue se notar lentidão.",
    default: true,
    stage: "beta",
  },
  {
    key: "terminal-webgl",
    label: "Terminal com GPU (WebGL)",
    description:
      "Renderiza os terminais na GPU (WebGL2) — bem mais leve com muitos terminais no canvas. Se você ver o terminal 'travar ao renderizar' (race do addon-webgl no descarte), DESLIGUE: cai pro renderer DOM, que é mais pesado mas nunca tem esse crash.",
    default: true,
    stage: "stable",
  },
  {
    key: "capability-risk-scan",
    label: "Scan de risco (Lurkr)",
    description:
      "Antes de mandar contexto pro agente, avisa se há credencial CRÍTICA (token/chave privada) indo pro LLM — o segredo aparece redigido, nunca cru. Complementa o gate gitleaks/semgrep (que olha o diff, não o contexto vivo). Só alerta, não bloqueia. Desligue pra silenciar.",
    default: true,
    stage: "beta",
  },
  {
    key: "recitation",
    label: "Recitação de foco (agentes)",
    description:
      "Em loop longo, reinjeta o FOCO (objetivo do Goal + card do Kanban + progresso do projeto) no contexto do agente pra ele não perder o rumo — técnica de recitação do Manus. Toggle 📿 por-agente no nó. Desligue pra voltar ao comportamento antigo.",
    default: true,
    stage: "beta",
  },
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
    key: "orchestration-watchdog",
    label: "Watchdog da orquestração",
    description:
      "Vigia o time do canvas: se o Arquiteto não entrega as fatias e a equipe fica ociosa, cobra o líder automaticamente (2 níveis) e depois avisa você. Também aciona o Code Reviewer quando o contrato é entregue. Desligue pra times 100% manuais.",
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
    key: "laziness-check",
    label: "Classificador de preguiça",
    description:
      "Ao fim de cada turno SEM Goal ativo, um juiz LLM (o mesmo do OmniPartner/review) cruza o que o agente DISSE com as tool calls que ele REALMENTE fez e sinaliza 'possível parada prematura' quando ele declara vitória sem verificar. Experimental — kill-switch. Precisa de um LLM configurado em Ferramentas.",
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
    label: "Mapa do código (OmniGraph)",
    description:
      "Botão \"Mapa do código\" (canto sup. direito do canvas) que gera sob demanda e traz o grafo de conhecimento do código — comunidades, dependências, god nodes — pro canvas. Desligue pra ocultar o atalho na toolbar.",
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
  {
    key: "omnigraph-symbol-body",
    label: "Corpo do símbolo no OmniGraph",
    description:
      "Clicar num símbolo (god node / top membro) de uma comunidade do grafo abre o CÓDIGO daquela função/classe num painel read-only, fatiado sob demanda. Desligue pra deixar os símbolos como texto puro.",
    default: true,
    stage: "stable",
  },
  {
    key: "omniswitch",
    label: "OmniSwitch (roteador de chave LLM)",
    description:
      "Aponta os agentes pro roteador interno de chave (fallback + rotação): as BASE_URL do agente vão pro router local e o token do router vira a 'API key' dele. Experimental — kill-switch: mantenha desligado até validar ponta-a-ponta. Com a flag OFF o spawn é idêntico ao atual.",
    default: false,
    stage: "experimental",
  },
  {
    key: "boot-intro",
    label: "Intro FRIDAY (boot animado)",
    description:
      "Uma intro estilo assistente de voz sci-fi (esfera FRIDAY em Canvas 2D) na abertura do app: som de boot sintetizado + voz TTS + a sequência de inicialização REAL (provedores, sessões, snapshots) acendendo linha a linha. Fica na tela até você clicar/teclar pra entrar. Personalizável. Kill-switch: desligue pra abrir direto no canvas. (MVP default:true pra teste — vira false no release.)",
    default: true,
    stage: "experimental",
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
