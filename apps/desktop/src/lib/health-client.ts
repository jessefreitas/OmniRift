// src/lib/health-client.ts
//
// Cliente do painel "Saúde do Projeto" (spec 2026-06-23, Fase A — dimensão Código).
// Wrappers tipados dos comandos Tauri + helper p/ escutar o streaming do scan.
//
// Contrato do backend (implementado em paralelo):
//   - project_scan(root)        → emite `health://file` por arquivo e
//                                  `health://scan-done` no fim; retorna o ScanSummary.
//   - health_analyze_file(path) → AiReport (análise de IA inline, sob demanda).
//
// O scan é PROGRESSIVO: a UI dispara `projectScan`, popula via `onHealthFile`
// conforme os eventos chegam, e fecha o resumo com `onHealthScanDone`. Os listeners
// devolvem um `unlisten` — sempre limpe no cleanup do efeito React.

import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/** Nível de severidade agregado de um arquivo (derivado dos thresholds no backend). */
export type HealthLevel = "ok" | "warn" | "high";

/** Pior função do arquivo (a que mais pesa na complexidade). */
export interface WorstFn {
  name: string;
  line: number;
  /** Complexidade ciclomática da pior função. */
  cx: number;
}

/** Saúde de um arquivo — uma linha do scan (evento `health://file`). */
export interface FileHealth {
  /** Caminho (absoluto ou relativo à raiz, conforme o backend emitir). */
  path: string;
  /** Id de linguagem (rust/typescript/tsx/javascript/jsx/python…). */
  lang: string;
  /** Complexidade ciclomática do arquivo. */
  cyclomatic: number;
  /** Complexidade cognitiva do arquivo. */
  cognitive: number;
  /** Índice de manutenibilidade (0–100; maior = melhor). */
  mi: number;
  /** A função mais complexa do arquivo (pode faltar se não houver funções). */
  worstFn?: WorstFn | null;
  /** Nível agregado já calculado pelo backend. */
  level: HealthLevel;
}

/** Resumo do scan inteiro (evento `health://scan-done` + retorno de `project_scan`). */
export interface ScanSummary {
  /** Total de arquivos que entraram no scan (com grammar de métrica). */
  totalFiles: number;
  /** Média de complexidade ciclomática entre os arquivos. */
  avgCx: number;
  /** Top hotspots (mais complexos/arriscados), já ordenados pelo backend. */
  hotspots: FileHealth[];
  /** Quantos arquivos foram efetivamente medidos. */
  scanned: number;
  /** Quantos foram pulados (sem grammar, ilegíveis, ignorados). */
  skipped: number;
}

/** Severidade de um achado da IA. */
export type FindingSeverity = "critical" | "warning" | "info" | string;

/** Um achado estruturado do relatório de IA. */
export interface AiFinding {
  severity: FindingSeverity;
  /** Tipo/categoria do achado (ex.: "smell", "refactor", "risk"). */
  kind: string;
  title: string;
  detail: string;
  /** Correção sugerida (texto livre). */
  suggestion: string;
  /** Linha alvo, quando aplicável. */
  line?: number | null;
}

/** Relatório de IA por arquivo (retorno de `health_analyze_file`). */
export interface AiReport {
  /** Alvo analisado (caminho do arquivo). */
  target: string;
  findings: AiFinding[];
  /** Resumo executivo (1–2 parágrafos). */
  summary: string;
}

// ── Dimensão Banco de Dados (Fase B — do repo) ──────────────────────────────
//
// Contrato do backend (implementado em paralelo):
//   - db_scan_repo(root)    → DbScan: detecta fontes de schema no repo
//                             (migrations, *.sql, schema.prisma, models ORM) e
//                             extrai tabelas/colunas/PK/FK/índices. Fail-soft.
//   - health_analyze_db(root) → AiReport (mesmo tipo da análise de arquivo).

/** Uma coluna de uma tabela detectada no schema do repo. */
export interface DbColumn {
  name: string;
  /** Tipo declarado (texto livre — varia por dialeto/ORM). */
  type: string;
  /** É chave primária. */
  pk: boolean;
  /** É chave estrangeira. */
  fk: boolean;
  /** Aceita NULL. */
  nullable: boolean;
}

/** Uma tabela detectada no schema do repo (evento/retorno de `db_scan_repo`). */
export interface DbTable {
  name: string;
  columns: DbColumn[];
  /** Índices declarados (texto livre — nome/expressão por índice). */
  indexes: string[];
  /** De onde veio (arquivo de migration/.sql/prisma/model ORM). */
  source: string;
}

/** Resultado do scan de schema do repo (retorno de `db_scan_repo`). */
export interface DbScan {
  tables: DbTable[];
  /** Fontes de schema detectadas (caminhos/diretórios). */
  sources: string[];
  /** Dialeto inferido (postgres/mysql/sqlite/prisma…), quando detectável. */
  dialect?: string | null;
}

/**
 * Dispara o scan do projeto inteiro a partir de `root`. O backend percorre o
 * repo (respeita `.gitignore`), calcula métricas por arquivo e EMITE eventos
 * (`health://file` / `health://scan-done`) — registre os listeners ANTES de
 * chamar isto. Resolve com o `ScanSummary` final.
 */
export async function projectScan(root: string): Promise<ScanSummary> {
  return invoke<ScanSummary>("project_scan", { root });
}

/**
 * Detecta e parseia o schema de banco a partir do repo em `root` — migrations,
 * `*.sql`, `schema.prisma` e models ORM. Fail-soft: o que não parsear vira
 * aviso no backend, não erro. Resolve com o `DbScan` (tabelas + fontes + dialeto).
 */
export async function dbScanRepo(root: string): Promise<DbScan> {
  return invoke<DbScan>("db_scan_repo", { root });
}

/**
 * Análise de IA do schema detectado no repo (sob demanda). Monta prompt com as
 * tabelas/relações e roteia pelo LLM/brain ativo → relatório estruturado. Em
 * caso de LLM indisponível, o backend rejeita com mensagem amigável (fail-open
 * na UI). Reusa o mesmo `AiReport`/`AiReportView` da dimensão Código.
 */
export async function healthAnalyzeDb(root: string): Promise<AiReport> {
  return invoke<AiReport>("health_analyze_db", { root });
}

/**
 * Análise de IA de um arquivo (sob demanda). Monta prompt com as métricas +
 * trecho e roteia pelo LLM/brain ativo → relatório estruturado. Em caso de LLM
 * indisponível, o backend deve rejeitar com mensagem amigável (fail-open na UI).
 */
export async function healthAnalyzeFile(path: string): Promise<AiReport> {
  return invoke<AiReport>("health_analyze_file", { path });
}

/**
 * Escuta cada arquivo medido durante o scan (evento `health://file`).
 * Devolve o `unlisten` — chame no cleanup do efeito.
 */
export async function onHealthFile(cb: (file: FileHealth) => void): Promise<UnlistenFn> {
  return listen<FileHealth>("health://file", (e) => cb(e.payload));
}

/**
 * Escuta o fim do scan (evento `health://scan-done`), com o resumo agregado.
 * Devolve o `unlisten` — chame no cleanup do efeito.
 */
export async function onHealthScanDone(cb: (summary: ScanSummary) => void): Promise<UnlistenFn> {
  return listen<ScanSummary>("health://scan-done", (e) => cb(e.payload));
}

/**
 * Conveniência: registra os DOIS listeners do streaming de uma vez e devolve um
 * único `unlisten` que limpa ambos. Padrão de uso num efeito React:
 *
 *   useEffect(() => {
 *     let stop: (() => void) | undefined;
 *     listenHealthScan({ onFile, onDone }).then((u) => { stop = u; });
 *     return () => stop?.();
 *   }, []);
 */
export async function listenHealthScan(handlers: {
  onFile?: (file: FileHealth) => void;
  onDone?: (summary: ScanSummary) => void;
}): Promise<UnlistenFn> {
  const unlisteners: UnlistenFn[] = [];
  if (handlers.onFile) unlisteners.push(await onHealthFile(handlers.onFile));
  if (handlers.onDone) unlisteners.push(await onHealthScanDone(handlers.onDone));
  return () => {
    for (const un of unlisteners) un();
  };
}
