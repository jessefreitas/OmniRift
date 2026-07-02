// src/lib/git-providers.ts
//
// Conexões com provedores git (GitHub/GitLab/Forgejo): tokens + listar/clonar repos.
// Chama os comandos Rust (reqwest/git, fora do WebKit).
//
// Task #33 — o TOKEN mora no keychain do SO (conta `git.<providerId>.token`), via
// os comandos `git_token_*`. Só a CONFIG do provider (kind/baseUrl) fica no
// localStorage (não é segredo). Tokens legados (que ainda estavam no localStorage)
// migram pro keychain uma única vez, no primeiro load.

import { invoke } from "@tauri-apps/api/core";

export type GitProviderKind = "github" | "forgejo" | "gitlab";

export interface GitProviderConfig {
  kind: GitProviderKind;
  baseUrl: string;
  /** Runtime-only — NUNCA persistido no localStorage (vive no keychain do SO). */
  token: string;
}

export interface RemoteRepo {
  name: string;
  fullName: string;
  cloneUrl: string;
  private: boolean;
  description: string;
  defaultBranch: string;
}

export async function gitListRepos(c: GitProviderConfig): Promise<RemoteRepo[]> {
  return invoke<RemoteRepo[]>("git_list_repos", { kind: c.kind, baseUrl: c.baseUrl, token: c.token });
}

/** Clona em destDir/<name> (token embutido p/ privado). Devolve o caminho local. */
export async function gitClone(cloneUrl: string, destDir: string, token?: string): Promise<string> {
  return invoke<string>("git_clone", { cloneUrl, destDir, token: token ?? null });
}

export const GIT_PRESETS: { id: string; label: string; kind: GitProviderKind; baseUrl: string }[] = [
  { id: "github", label: "GitHub", kind: "github", baseUrl: "https://api.github.com" },
  { id: "gitlab", label: "GitLab", kind: "gitlab", baseUrl: "https://gitlab.com" },
  { id: "forgejo-omni", label: "Forgejo (omnimemory)", kind: "forgejo", baseUrl: "https://git.omnimemory.com.br" },
  { id: "forgejo", label: "Forgejo / Gitea (custom)", kind: "forgejo", baseUrl: "" },
];

const KEY = "omnirift-git-providers-v1";
const DEST_KEY = "omnirift-git-clone-dir";

/** Metadados persistidos (SEM token). O token vive no keychain. */
interface StoredProvider {
  kind: GitProviderKind;
  baseUrl: string;
}

/**
 * Id estável e seguro do provider (chave do segredo no keychain). Deriva do
 * kind + host do baseUrl → `git.<providerId>.token`. Normaliza p/ o mesmo host
 * (com/sem barra final) resolver o mesmo token.
 */
export function providerId(kind: GitProviderKind, baseUrl: string): string {
  const host = (baseUrl || "")
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
    .replace(/[^a-zA-Z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .toLowerCase();
  return `${kind}-${host || "default"}`;
}

// ── Comandos Tauri do keychain ───────────────────────────────────────────────

export async function gitTokenSet(id: string, token: string): Promise<void> {
  await invoke("git_token_set", { providerId: id, token });
}
export async function gitTokenGet(id: string): Promise<string | null> {
  return invoke<string | null>("git_token_get", { providerId: id });
}
export async function gitTokenDelete(id: string): Promise<void> {
  await invoke("git_token_delete", { providerId: id });
}

/** Token salvo (keychain) de um provider. "" se não houver / IPC indisponível. */
export async function getGitToken(kind: GitProviderKind, baseUrl: string): Promise<string> {
  try {
    return (await gitTokenGet(providerId(kind, baseUrl))) ?? "";
  } catch {
    return "";
  }
}

// ── Persistência (metadados no localStorage; token no keychain) ───────────────

function loadStored(): StoredProvider[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) || "[]");
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((p) => p && typeof p.kind === "string" && typeof p.baseUrl === "string")
      .map((p) => ({ kind: p.kind as GitProviderKind, baseUrl: p.baseUrl as string }));
  } catch {
    return [];
  }
}

function writeStored(list: StoredProvider[]): void {
  localStorage.setItem(KEY, JSON.stringify(list.map((p) => ({ kind: p.kind, baseUrl: p.baseUrl }))));
}

/**
 * Migração one-time: tokens legados gravados no localStorage → keychain.
 * Idempotente (flag de módulo). Best-effort: se o `git_token_set` falhar, mantém
 * o token no localStorage pra tentar de novo na próxima. Sempre reescreve os
 * metadados sem o campo `token`.
 */
let migrated = false;
export async function migrateLegacyGitTokens(): Promise<void> {
  if (migrated) return;
  migrated = true;
  let raw: unknown;
  try {
    raw = JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return;
  }
  if (!Array.isArray(raw)) return;
  let changed = false;
  const keep: StoredProvider[] = [];
  for (const p of raw as Array<Record<string, unknown>>) {
    if (!p || typeof p.kind !== "string" || typeof p.baseUrl !== "string") continue;
    const kind = p.kind as GitProviderKind;
    const baseUrl = p.baseUrl as string;
    const legacyToken = typeof p.token === "string" ? p.token.trim() : "";
    if (legacyToken) {
      try {
        await gitTokenSet(providerId(kind, baseUrl), legacyToken);
        changed = true; // token saiu do localStorage → keychain
      } catch {
        // keychain/IPC indisponível: preserva o token pra próxima tentativa.
        migrated = false;
        keep.push({ kind, baseUrl });
        continue;
      }
    } else if ("token" in p) {
      changed = true; // tinha token vazio → só limpa o campo
    }
    keep.push({ kind, baseUrl });
  }
  if (changed) writeStored(keep);
}

/** Providers salvos (metadados; token vem depois via `getGitToken`). */
export function loadGitProviders(): GitProviderConfig[] {
  return loadStored().map((p) => ({ kind: p.kind, baseUrl: p.baseUrl, token: "" }));
}

/** Upsert por kind+baseUrl. Config → localStorage; token → keychain. */
export async function saveGitProvider(c: GitProviderConfig): Promise<void> {
  const rest = loadStored().filter((p) => !(p.kind === c.kind && p.baseUrl === c.baseUrl));
  writeStored([...rest, { kind: c.kind, baseUrl: c.baseUrl }]);
  await gitTokenSet(providerId(c.kind, c.baseUrl), c.token);
}

export async function removeGitProvider(c: GitProviderConfig): Promise<void> {
  const rest = loadStored().filter((p) => !(p.kind === c.kind && p.baseUrl === c.baseUrl));
  writeStored(rest);
  await gitTokenDelete(providerId(c.kind, c.baseUrl));
}

/** Token do primeiro provider GitHub salvo (keychain). undefined se não houver. */
export async function githubToken(): Promise<string | undefined> {
  await migrateLegacyGitTokens();
  const gh = loadStored().find((p) => p.kind === "github");
  if (!gh) return undefined;
  const tok = await getGitToken(gh.kind, gh.baseUrl);
  return tok || undefined;
}

export function loadCloneDir(): string | null {
  return localStorage.getItem(DEST_KEY);
}
export function saveCloneDir(d: string): void {
  localStorage.setItem(DEST_KEY, d);
}
