#!/usr/bin/env bash
# Builda o omnifs-mcp (github.com/jessefreitas/omnifs) e coloca como SIDECAR do
# OmniRift em apps/desktop/src-tauri/binaries/ (nome com o target triple, como o
# Tauri externalBin exige). Roda na CI (release.yml) e localmente pra dev. O binário
# é gitignored. Espelha o scripts/build-omnicompress.sh.
#
#   OMNIFS_SRC=/caminho  → usa essa fonte COMO ESTÁ (não mexe no git dela).
#   sem ela              → clone gerenciado em /tmp, atualizado pro HEAD do upstream.
#
# PLATAFORMA: o omnifs-mcp depende de FUSE (crate `fuser`) → só compila em Linux e
# macOS. No WINDOWS o script SAI limpo (exit 0) sem produzir sidecar — o OmniRift no
# Windows roda o OmniFS via WSL/Linux (pré-requisito) e o find_omnifs_bin degrada pro
# PATH. Assim o `externalBin` do Windows NÃO deve listar omnifs-mcp (ver tauri.*.conf.json).
set -euo pipefail

REPO="https://github.com/jessefreitas/omnifs"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/desktop/src-tauri/binaries"

TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
case "$TRIPLE" in
  *windows*)
    echo "[omnifs-sidecar] Windows ($TRIPLE): FUSE indisponível — pulando (OmniFS via WSL)."
    exit 0
    ;;
esac

if [ -n "${OMNIFS_SRC:-}" ]; then
  # Fonte do usuário (ex.: clone no SSD): respeita como está.
  SRC="$OMNIFS_SRC"
else
  # Clone gerenciado: cria se não existe, senão atualiza pro HEAD do upstream.
  SRC="${RUNNER_TEMP:-/tmp}/omnifs"
  if [ ! -d "$SRC/.git" ]; then
    git clone --depth 1 "$REPO" "$SRC"
  else
    git -C "$SRC" fetch --depth 1 origin HEAD
    git -C "$SRC" reset --hard FETCH_HEAD
  fi
fi

( cd "$SRC" && cargo build --release -p omnifs-mcp )

# target-dir pode estar redirecionado (.cargo/config.toml) → pergunta pro cargo.
TARGET_DIR="$(cd "$SRC" && cargo metadata --no-deps --format-version 1 \
  | grep -o '"target_directory":"[^"]*"' | head -1 \
  | sed 's/^"target_directory":"//;s/"$//')"
[ -n "$TARGET_DIR" ] || TARGET_DIR="$SRC/target"

mkdir -p "$DEST"
cp "$TARGET_DIR/release/omnifs-mcp" "$DEST/omnifs-mcp-$TRIPLE"
echo "sidecar pronto: $DEST/omnifs-mcp-$TRIPLE"
