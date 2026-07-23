#!/usr/bin/env bash
set -euo pipefail

branch="$(git branch --show-current)"
case "$branch" in
  lab|lab/*) ;;
  *)
    echo "ERRO: lab:sync só pode rodar em lab ou lab/* (atual: ${branch:-detached})." >&2
    exit 1
    ;;
esac

if [ -n "$(git status --porcelain)" ]; then
  echo "ERRO: o worktree Lab precisa estar limpo antes de sincronizar." >&2
  exit 1
fi

git fetch origin main
git rebase origin/main
npm run lab:guard

echo "Lab sincronizado com origin/main e isolamento revalidado."
