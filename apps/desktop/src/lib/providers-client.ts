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
