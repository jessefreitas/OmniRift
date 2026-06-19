#!/usr/bin/env bash
# Builda o omnicompress-proxy (github.com/jessefreitas/OmniCompress, Apache-2.0) e
# coloca como SIDECAR do OmniRift em apps/desktop/src-tauri/binaries/
# (nome com o target triple, como o Tauri externalBin exige). Roda na CI
# (release.yml) por plataforma e localmente pra dev. O binário é gitignored.
set -euo pipefail

REPO="https://github.com/jessefreitas/OmniCompress"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/desktop/src-tauri/binaries"
SRC="${OMNICOMPRESS_SRC:-${RUNNER_TEMP:-/tmp}/OmniCompress}"

TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
EXT=""
case "$TRIPLE" in *windows*) EXT=".exe" ;; esac

if [ ! -d "$SRC/.git" ]; then
  git clone --depth 1 "$REPO" "$SRC"
fi
( cd "$SRC" && cargo build --release -p omnicompress-proxy )

mkdir -p "$DEST"
cp "$SRC/target/release/omnicompress-proxy$EXT" "$DEST/omnicompress-proxy-$TRIPLE$EXT"
echo "sidecar pronto: $DEST/omnicompress-proxy-$TRIPLE$EXT"
