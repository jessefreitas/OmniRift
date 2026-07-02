// src/lib/providers-client.ts
//
// Área de Conexões — ponte frontend pros 5 comandos da camada de memória
// plugável (MemoryProvider). Gerencia conexões: listar/adicionar/testar/alternar.
// Distinto do memory-client.ts (esse navega a memória local; este conecta providers).

import { invoke } from "@tauri-apps/api/core";

export type ProviderKind = "local" | "omnimemory" | "obsidian";

export interface ConnectionConfig {
  kind: ProviderKind;
  endpoint?: string;
  /** Só ida (escrita) — nunca volta do backend (mascarado). */
  token?: string;
}

export interface ProviderHealth {
  ok: boolean;
  detail: string;
}

/** Conexões configuradas (sem token). */
export async function providersList(): Promise<ConnectionConfig[]> {
  return invoke<ConnectionConfig[]>("memory_providers_list");
}

/** Cria/atualiza uma conexão (token ofuscado em repouso pelo backend). */
export async function providerConnect(config: ConnectionConfig): Promise<void> {
  return invoke("memory_connect", { config });
}

/** Testa a saúde de um provider sem trocar o ativo. */
export async function providerTest(kind: ProviderKind): Promise<ProviderHealth> {
  return invoke<ProviderHealth>("memory_test", { kind });
}

/** Define o provider ativo (precisa estar configurado). */
export async function providerSetActive(kind: ProviderKind): Promise<void> {
  return invoke("memory_set_active", { kind });
}

/** Provider ativo atual. */
export async function providerActive(): Promise<ProviderKind> {
  return invoke<ProviderKind>("memory_active");
}

// ── Migração de memórias entre providers (task #34) ─────────────────────────

export interface MigratePreview {
  /** Total de memórias na origem. */
  count: number;
  /** Quantas já estão no destino (serão puladas). */
  already: number;
}

export interface MigrateResult {
  copied: number;
  skipped: number;
  errors: number;
  /** Amostra das primeiras mensagens de erro (se houver). */
  errorSamples: string[];
}

/** Conta quantas memórias seriam migradas de `from` → `to` (não grava nada). */
export async function memoryMigratePreview(
  from: ProviderKind,
  to: ProviderKind,
): Promise<MigratePreview> {
  return invoke<MigratePreview>("memory_migrate_preview", { from, to });
}

/** Copia (ou move) todas as memórias de `from` → `to`. */
export async function memoryMigrate(
  from: ProviderKind,
  to: ProviderKind,
  mode: "copy" | "move",
): Promise<MigrateResult> {
  return invoke<MigrateResult>("memory_migrate", { from, to, mode });
}
