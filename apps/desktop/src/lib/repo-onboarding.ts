// src/lib/repo-onboarding.ts
//
// ONBOARDING INTELIGENTE DO REPO GIT (task #32).
//
// Depois que "Abrir como projeto" clona um repo e o abre no canvas, o projeto
// não devia nascer morto — devia nascer VIVO. Este módulo transforma o clone em
// projeto pronto pra trabalhar, disparando (best-effort, opt-in) as três engines
// que o OmniRift já tem:
//
//   • OmniFS   → indexa o `cwd` na busca semântica do drive (memória TEMPORAL).
//   • OmniGraph→ constrói o knowledge graph do código (memória ESTRUTURAL) pro
//                Arquiteto de Pipeline ancorar decisões na estrutura real.
//   • Kanban   → semeia um card "Explorar o projeto <nome>" pra o board não nascer vazio.
//
// PRINCÍPIOS (não-negociáveis):
//   1. Cada passo é OPT-IN (flag em `OnboardOptions`) — o chamador decide o quê rodar.
//   2. Cada passo é BEST-EFFORT: try/catch individual, NUNCA lança pro chamador, NUNCA
//      trava o fluxo de abrir o projeto. Uma engine ausente = passo "skipped" com motivo,
//      não um erro.
//   3. AGNÓSTICO de provider: opera sobre o `cwd` já clonado (git puro) — vale igual pra
//      GitHub, GitLab e Forgejo/OmniGit. Não sabe nem se importa de onde o repo veio.
//   4. Degradação graciosa: engine indisponível é o CAMINHO ESPERADO, não exceção. O
//      resultado descreve o que rodou E o que foi pulado (com o porquê legível).
//
// Os passos LENTOS (reindex do drive, rebuild do grafo) são disparados fire-and-forget:
// a UI reporta que foram INICIADOS, sem travar o fechamento do modal esperando concluir.
// O rápido (criar o card) é aguardado pra confirmar no resumo.

import { omnifsStatus, omnifsIsManagedCwd, omnifsReindex } from "@/lib/omnifs-client";
import { omnigraphRebuild } from "@/lib/omnigraph-client";
import { omnigraphAvailable } from "@/lib/pipeline-client";
import { kanbanCardCreate } from "@/lib/kanban-client";

// NOTE: o gate `omnigraphAvailable` (comando Rust `omnigraph_available`, barato — nunca
// lança) vive em pipeline-client.ts; o `omnigraphRebuild` (build caro do grafo) vive em
// omnigraph-client.ts. Reusamos ambos como já expostos — sem duplicar comando.

/** Quais passos rodar. Cada um é OPT-IN — a UI liga por default os que têm engine. */
export interface OnboardOptions {
  /** Indexar o `cwd` na busca do OmniFS (se o drive estiver vivo e o cwd no mount). */
  indexOmnifs: boolean;
  /** Construir o knowledge graph (OmniGraph) do código. */
  buildGraph: boolean;
  /** Semear um card inicial no Kanban do projeto. */
  seedKanban: boolean;
  /** Nome legível do projeto (título do card). Ausente → derivado do basename do `cwd`. */
  name?: string;
}

/** Como cada passo terminou. */
export type OnboardStepStatus =
  /** Rodou (ou foi disparado fire-and-forget) com sucesso. */
  | "done"
  /** Pulado de propósito: engine ausente, cwd fora do mount, ou flag desligada. */
  | "skipped"
  /** Tentou rodar mas a chamada falhou (best-effort — não propaga). */
  | "failed";

/** Resultado de um passo do onboarding (pro resumo e pro log). */
export interface OnboardStepResult {
  step: "omnifs" | "omnigraph" | "kanban";
  status: OnboardStepStatus;
  /** Linha legível pt-BR pro toast/log (ex: "OmniGraph não instalado — pulei o mapa"). */
  detail: string;
}

/** Resultado completo do onboarding. */
export interface OnboardResult {
  steps: OnboardStepResult[];
  /** Texto multi-linha pronto pro notify() (título + uma linha por passo). */
  summary: string;
}

/** Basename de um path (POSIX ou Windows) pra usar como nome do projeto. */
function baseName(cwd: string): string {
  const parts = cwd.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts[parts.length - 1] || cwd;
}

// ── Passo 1: OmniFS — indexar o cwd na busca semântica ─────────────────────────────────
//
// O daemon do OmniFS já MONITORA o mount inteiro; se o clone caiu DENTRO do mount vivo,
// um reindex do drive faz o cwd aparecer na busca. Se o cwd está FORA do mount, a task
// manda "só registrar — não forçar mount": pulamos (não chamamos omnifsProvision). O
// omnifsReindex é GLOBAL (re-varre o drive), então dispará-lo fire-and-forget basta.
async function stepOmnifs(cwd: string): Promise<OnboardStepResult> {
  try {
    const st = await omnifsStatus();
    if (!st.binFound || !st.socketAlive) {
      return { step: "omnifs", status: "skipped", detail: "OmniFS indisponível — pulei a indexação da busca" };
    }
    const managed = await omnifsIsManagedCwd(cwd).catch(() => false);
    if (!managed) {
      // cwd fora do mount: NÃO forçamos mount (decisão da task). Só registramos.
      return {
        step: "omnifs",
        status: "skipped",
        detail: "cwd fora do mount OmniFS — não forcei mount (só registrei)",
      };
    }
    // Fire-and-forget: reindex do drive re-varre tudo e pega o clone novo. Não travamos.
    void omnifsReindex().catch((e) => console.warn("[onboarding] omnifs reindex falhou:", e));
    console.log("[onboarding] OmniFS: reindex do drive disparado (cwd no mount)");
    return { step: "omnifs", status: "done", detail: "Busca: indexando o projeto no drive OmniFS…" };
  } catch (e) {
    console.warn("[onboarding] OmniFS: passo falhou:", e);
    return { step: "omnifs", status: "failed", detail: "OmniFS: falhou ao consultar o drive (ignorado)" };
  }
}

// ── Passo 2: OmniGraph — construir o knowledge graph do código ─────────────────────────
//
// Se o OmniGraph está disponível, disparamos o rebuild fire-and-forget: o grafo fica
// pronto no disco pro Arquiteto de Pipeline (F1) ancorar o time na estrutura REAL. O
// rebuild é caro (AST + Leiden), então NÃO aguardamos — o resumo diz "construindo…".
async function stepOmnigraph(cwd: string): Promise<OnboardStepResult> {
  try {
    const ok = await omnigraphAvailable();
    if (!ok) {
      return { step: "omnigraph", status: "skipped", detail: "OmniGraph não instalado — pulei o mapa do código" };
    }
    // Fire-and-forget: o rebuild é lento; a UI só reporta que começou.
    void omnigraphRebuild(cwd).catch((e) => console.warn("[onboarding] omnigraph rebuild falhou:", e));
    console.log("[onboarding] OmniGraph: rebuild do grafo disparado");
    return { step: "omnigraph", status: "done", detail: "Mapa do código: construindo o grafo (OmniGraph)…" };
  } catch (e) {
    console.warn("[onboarding] OmniGraph: passo falhou:", e);
    return { step: "omnigraph", status: "failed", detail: "OmniGraph: falhou ao iniciar o mapa (ignorado)" };
  }
}

// ── Passo 3: Kanban — semear o board ───────────────────────────────────────────────────
//
// Board vazio dá sensação de projeto morto. Criamos UM card "Explorar o projeto <nome>"
// na primeira coluna do fluxo (col ausente → o backend usa `kanban_first_col`, que respeita
// colunas custom). O scope do Kanban é o `cwd` — o MESMO que o KanbanPanel usa (currentCwd).
async function stepKanban(cwd: string, name: string): Promise<OnboardStepResult> {
  try {
    const title = `Explorar o projeto ${name}`;
    // col omitido de propósito → cai na 1ª coluna do fluxo do projeto (default: Backlog).
    await kanbanCardCreate({
      project: cwd,
      title,
      body: "Card inicial criado no onboarding. Comece mapeando o que este repo faz e por onde atacar.",
    });
    console.log(`[onboarding] Kanban: card "${title}" criado (scope=${cwd})`);
    return { step: "kanban", status: "done", detail: `Kanban: card "${title}" no backlog` };
  } catch (e) {
    console.warn("[onboarding] Kanban: passo falhou:", e);
    return { step: "kanban", status: "failed", detail: "Kanban: falhou ao criar o card inicial (ignorado)" };
  }
}

/** Emoji-prefixo do status pro resumo do toast. */
function statusMark(status: OnboardStepStatus): string {
  return status === "done" ? "✓" : status === "skipped" ? "•" : "⚠";
}

/**
 * Prepara um projeto recém-clonado: dispara (best-effort, opt-in) indexação OmniFS,
 * build do OmniGraph e seed do Kanban. NUNCA lança — cada passo é isolado por try/catch;
 * uma engine ausente vira passo "skipped" com motivo legível. Retorna o que rodou e o que
 * foi pulado pra UI mostrar um único resumo. Passos lentos (OmniFS/OmniGraph) são disparados
 * fire-and-forget: o resultado reporta que INICIARAM, sem travar o fechamento do modal.
 *
 * @param cwd  Pasta local do repo já clonado (= scope do Kanban, = projeto do canvas).
 * @param opts Quais passos rodar (cada um OPT-IN) + nome legível opcional do projeto.
 */
export async function onboardProject(cwd: string, opts: OnboardOptions): Promise<OnboardResult> {
  const name = opts.name?.trim() || baseName(cwd);
  const steps: OnboardStepResult[] = [];

  if (!cwd.trim()) {
    // Sem cwd não há o que preparar — degrada limpo (não deveria acontecer no fluxo real).
    return { steps, summary: "Onboarding pulado: projeto sem pasta local." };
  }

  if (opts.indexOmnifs) steps.push(await stepOmnifs(cwd));
  if (opts.buildGraph) steps.push(await stepOmnigraph(cwd));
  if (opts.seedKanban) steps.push(await stepKanban(cwd, name));

  const lines = steps.map((s) => `${statusMark(s.status)} ${s.detail}`);
  const summary = lines.length
    ? `Projeto "${name}" preparado:\n${lines.join("\n")}`
    : `Projeto "${name}" aberto (nenhum passo de preparo selecionado).`;

  return { steps, summary };
}
