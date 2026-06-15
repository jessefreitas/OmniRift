// src/lib/git-client.ts
//
// Ponte frontend → git backing dos Floors (Fase A).
// Cada floor git-backed é uma branch num worktree próprio, isolado do repo
// principal — é o que permite agentes paralelos editarem sem conflito.

import { invoke } from "@tauri-apps/api/core";

export interface GitRepoInfo {
  root: string;
  branch: string;
}

export interface FloorGit {
  worktreePath: string;
  branch: string;
  baseBranch: string;
  repoRoot: string;
}

export interface GitStatus {
  branch: string;
  ahead: number;
  behind: number;
  dirty: number;
}

/** Raiz + branch atual do repo que contém `cwd`. Rejeita se não for repo git. */
export async function gitRepoInfo(cwd: string): Promise<GitRepoInfo> {
  return invoke<GitRepoInfo>("git_repo_info", { cwd });
}

/** Cria um floor git-backed: worktree numa branch nova (ou reusa existente). */
export async function floorGitCreate(
  cwd: string,
  branch: string,
  base?: string,
): Promise<FloorGit> {
  return invoke<FloorGit>("floor_git_create", { cwd, branch, base: base ?? null });
}

/** Status resumido (branch/ahead/behind/dirty) de um worktree. */
export async function floorGitStatus(path: string): Promise<GitStatus> {
  return invoke<GitStatus>("floor_git_status", { path });
}

export interface FileDiff {
  path: string;
  /** M(odified) A(dded) D(eleted) R(enamed) C(opied). */
  status: string;
  additions: number;
  deletions: number;
  /** Patch unificado só desse arquivo. */
  patch: string;
}

export interface FloorDiff {
  files: FileDiff[];
  /** Arquivos novos não-rastreados (sem patch). */
  untracked: string[];
}

/** Diff do worktree vs sua base (commitado + working tree) + untracked. */
export async function floorGitDiff(path: string, base: string): Promise<FloorDiff> {
  return invoke<FloorDiff>("floor_git_diff", { path, base });
}

/** Land: merge da branch do floor em `into` + remove worktree + apaga branch. */
export async function floorGitLand(
  repoRoot: string,
  branch: string,
  into: string,
  worktreePath: string,
): Promise<string> {
  return invoke<string>("floor_git_land", { repoRoot, branch, into, worktreePath });
}

/** Descarta o worktree de um floor sem merge (opcionalmente apaga a branch). */
export async function floorGitRemove(
  repoRoot: string,
  worktreePath: string,
  branch: string,
  deleteBranch: boolean,
): Promise<void> {
  return invoke("floor_git_remove", { repoRoot, worktreePath, branch, deleteBranch });
}
