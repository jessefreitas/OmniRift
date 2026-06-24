// src/lib/health-tracker.ts
//
// Tracker de dívida técnica do painel Saúde do Projeto (spec 2026-06-24, §3).
// Persiste os findings que viraram ação ("corrigir") como `DebtItem[]` POR
// PROJETO no localStorage — chave `omnirift-health-debt:<hash do root>`.
//
// Cada item passa por: aberto → corrigindo (com backupId) → resolvido|ignorado.
// Tudo é frontend/persistência; nenhuma chamada ao backend aqui (o backup-gate
// vive no health-client). Fail-soft: localStorage off → opera em memória, nunca
// trava o fluxo.

import type { DebtItem, DebtStatus, FindingSeverity } from "./health-client";

const PREFIX = "omnirift-health-debt:";

/** Hash estável (djb2) de uma string → chave de localStorage por projeto. */
function hashRoot(root: string): string {
  let h = 5381;
  for (let i = 0; i < root.length; i++) {
    h = ((h << 5) + h + root.charCodeAt(i)) >>> 0;
  }
  return h.toString(36);
}

/** Chave de localStorage do tracker para um `root`. */
function keyFor(root: string): string {
  return `${PREFIX}${hashRoot(root)}`;
}

/**
 * Id estável de um item de dívida — derivado de arquivo+título+linha. Mesmo
 * finding "corrigido" 2x não duplica no tracker (upsert por id).
 */
export function debtId(file: string, title: string, line?: number | null): string {
  const raw = `${file}|${title}|${line ?? ""}`;
  return hashRoot(raw);
}

/** Lê os itens de dívida do projeto (vazio se nada salvo / localStorage off). */
export function loadDebt(root: string): DebtItem[] {
  try {
    const raw = localStorage.getItem(keyFor(root));
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as DebtItem[]) : [];
  } catch {
    return [];
  }
}

/** Persiste a lista inteira (fail-soft). */
function saveDebt(root: string, items: DebtItem[]): void {
  try {
    localStorage.setItem(keyFor(root), JSON.stringify(items));
  } catch {
    /* localStorage off — opera em memória nesta sessão */
  }
}

/**
 * Insere ou atualiza um item (merge por `id`). Atualiza o `ts` pra agora.
 * Devolve a lista resultante (já persistida).
 */
export function upsertDebt(root: string, item: DebtItem): DebtItem[] {
  const items = loadDebt(root);
  const next: DebtItem = { ...item, ts: item.ts || new Date().toISOString() };
  const idx = items.findIndex((d) => d.id === next.id);
  if (idx === -1) items.push(next);
  else items[idx] = { ...items[idx], ...next };
  saveDebt(root, items);
  return items;
}

/**
 * Conveniência: registra um finding como dívida com um dado status (e backupId
 * opcional). Calcula o id estável a partir de arquivo+título+linha.
 */
export function trackFinding(
  root: string,
  f: { file: string; title: string; severity: FindingSeverity; line?: number | null },
  status: DebtStatus,
  backupId?: string,
): DebtItem[] {
  return upsertDebt(root, {
    id: debtId(f.file, f.title, f.line),
    file: f.file,
    title: f.title,
    severity: f.severity,
    status,
    backupId,
    ts: new Date().toISOString(),
  });
}

/** Troca o status de um item (no-op se não existir). Devolve a lista resultante. */
export function setStatus(root: string, id: string, status: DebtStatus): DebtItem[] {
  const items = loadDebt(root);
  const idx = items.findIndex((d) => d.id === id);
  if (idx === -1) return items;
  items[idx] = { ...items[idx], status, ts: new Date().toISOString() };
  saveDebt(root, items);
  return items;
}

/** Remove um item do tracker. Devolve a lista resultante. */
export function removeDebt(root: string, id: string): DebtItem[] {
  const items = loadDebt(root).filter((d) => d.id !== id);
  saveDebt(root, items);
  return items;
}
