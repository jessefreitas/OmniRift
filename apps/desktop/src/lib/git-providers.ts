// src/lib/git-providers.ts
//
// Conexões com provedores git (GitHub/Forgejo): tokens + listar/clonar repos.
// Chama os comandos Rust (reqwest/git, fora do WebKit). Config em localStorage
// (token ofuscado/keychain = fase futura, mesma dívida da memória/LLM).

import { invoke } from "@tauri-apps/api/core";

export type GitProviderKind = "github" | "forgejo" | "gitlab";

export interface GitProviderConfig {
  kind: GitProviderKind;
  baseUrl: string;
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

export function loadGitProviders(): GitProviderConfig[] {
  try {
    return JSON.parse(localStorage.getItem(KEY) || "[]");
  } catch {
    return [];
  }
}

/** Upsert por kind+baseUrl. */
export function saveGitProvider(c: GitProviderConfig): void {
  const all = loadGitProviders().filter((p) => !(p.kind === c.kind && p.baseUrl === c.baseUrl));
  localStorage.setItem(KEY, JSON.stringify([...all, c]));
}

export function removeGitProvider(c: GitProviderConfig): void {
  const all = loadGitProviders().filter((p) => !(p.kind === c.kind && p.baseUrl === c.baseUrl));
  localStorage.setItem(KEY, JSON.stringify(all));
}

export function loadCloneDir(): string | null {
  return localStorage.getItem(DEST_KEY);
}
export function saveCloneDir(d: string): void {
  localStorage.setItem(DEST_KEY, d);
}
