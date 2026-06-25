// apps/desktop/src/lib/turbo-client.ts
//
// Cliente do TURBO mode (loop engineering autônomo — spec 2026-06-24). Ponte
// tipada entre a UI React e os comandos Tauri em src-tauri/src/turbo/.
//
// Conceito: goal + condição de parada VERIFICÁVEL (comando shell, exit 0 = pronto)
// → loop: implementer headless tenta → roda a condição → se exit≠0 devolve o erro
// pro implementer corrigir → repete até exit 0 OU bater o teto → aí um verifier
// SEPARADO dá GO/NO-GO no diff. Estado em disco (`.omnirift/turbo/<id>.json`); a UI
// vê ao vivo via `turbo://update`. SEM auto-commit (checkpoint humano).
//
// O BACKEND é a fonte da verdade: reabrir o painel recarrega via turboList/turboStatus.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Status de um run TURBO. */
export type TurboStatus = "running" | "passed" | "failed_cap" | "stopped";

/** Uma iteração do loop: o implementer rodou, a condição foi avaliada. */
export interface TurboIter {
  /** Número da iteração (1-based). */
  n: number;
  /** stdout (truncado) do implementer nesta iteração. */
  implementerOut: string;
  /** Exit code da condição (null se o processo não retornou código). */
  conditionExit: number | null;
  /** stdout+stderr (truncado) da condição nesta iteração. */
  conditionOut: string;
}

/** Estado completo de um run TURBO (retorno/evento — a fonte da verdade). */
export interface TurboRun {
  /** Id do run (também o nome do arquivo `<id>.json`). */
  id: string;
  /** Goal em linguagem natural. */
  goal: string;
  /** Condição de parada: comando shell cujo exit 0 = pronto. */
  condition: string;
  /** CLI do implementer (quem escreve). */
  implementerCli: string;
  /** CLI do verifier (quem aprova — maker ≠ checker). */
  verifierCli: string;
  /** Teto de iterações. */
  maxIter: number;
  /** Estado atual. */
  status: TurboStatus;
  /** Iterações já executadas. */
  iterations: TurboIter[];
  /** Parecer do verifier (GO/NO-GO + motivo); ausente até parar. */
  verdict?: string | null;
  /** Carimbo de criação em epoch millis. */
  createdAtMs: number;
}

/**
 * Inicia um run TURBO. Persiste o estado inicial e spawna o loop em background no
 * backend; resolve imediatamente com o `id` (o progresso chega via `turbo://update`
 * + persistência). NÃO bloqueia. `maxIter` é clampeado em 1..=50 pelo backend.
 */
export async function turboStart(args: {
  cwd: string;
  goal: string;
  condition: string;
  implementerCli: string;
  verifierCli: string;
  maxIter: number;
}): Promise<string> {
  return invoke<string>("turbo_start", {
    cwd: args.cwd,
    goal: args.goal,
    condition: args.condition,
    implementerCli: args.implementerCli,
    verifierCli: args.verifierCli,
    maxIter: args.maxIter,
  });
}

/**
 * Lê o estado de UM run do disco (`<cwd>/.omnirift/turbo/<id>.json`). `null` se não
 * existe. Use ao reabrir o painel num run específico.
 */
export async function turboStatus(cwd: string, id: string): Promise<TurboRun | null> {
  return invoke<TurboRun | null>("turbo_status", { cwd, id });
}

/** Lista todos os runs TURBO do projeto em `cwd` (mais recente primeiro). */
export async function turboList(cwd: string): Promise<TurboRun[]> {
  return invoke<TurboRun[]>("turbo_list", { cwd });
}

/**
 * Sinaliza o cancelamento de um run pelo `id`. O backend checa ANTES de cada
 * iteração e para limpo (status "stopped"). Idempotente.
 */
export async function turboStop(id: string): Promise<void> {
  return invoke<void>("turbo_stop", { id });
}

/**
 * Escuta as atualizações ao vivo do loop (evento `turbo://update`) — o backend
 * emite o `TurboRun` COMPLETO a cada passo. Devolve o `unlisten`; chame no cleanup
 * do efeito React. Filtre por `id` no callback se você acompanha um run só.
 */
export async function listenTurboUpdate(cb: (run: TurboRun) => void): Promise<UnlistenFn> {
  return listen<TurboRun>("turbo://update", (e) => cb(e.payload));
}
