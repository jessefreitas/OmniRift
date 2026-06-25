// src/lib/hosts-client.ts
//
// Wrapper tipado para o registry de hosts SSH (`~/.omnirift/hosts.json`) — alimenta
// o dropdown de "novo agente" (onde o agente roda). Espelha commands/hosts.rs.
// Só key-auth: o registry nunca guarda senha; o spawn usa `-o BatchMode=yes`.

import { invoke } from "@tauri-apps/api/core";

/** Uma entrada do registry de hosts SSH (camelCase, igual ao Rust no fio). */
export interface SshHostEntry {
  id: string;
  label: string;
  sshTarget: string;
}

/** Lista os hosts SSH configurados (vazio se nunca configurou nenhum). */
export async function hostsList(): Promise<SshHostEntry[]> {
  return invoke<SshHostEntry[]>("hosts_list");
}

/** Adiciona um host SSH. O backend valida o sshTarget contra injeção. */
export async function hostsAdd(
  id: string,
  label: string,
  sshTarget: string,
): Promise<SshHostEntry[]> {
  return invoke<SshHostEntry[]>("hosts_add", { id, label, sshTarget });
}

/** Remove um host SSH pelo id (idempotente). */
export async function hostsRemove(id: string): Promise<SshHostEntry[]> {
  return invoke<SshHostEntry[]>("hosts_remove", { id });
}
