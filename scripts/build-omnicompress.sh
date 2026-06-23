#!/usr/bin/env bash
# Builda o omnicompress-proxy (github.com/jessefreitas/OmniCompress, Apache-2.0) e
# coloca como SIDECAR do OmniRift em apps/desktop/src-tauri/binaries/
# (nome com o target triple, como o Tauri externalBin exige). Roda na CI
# (release.yml) por plataforma e localmente pra dev. O binário é gitignored.
#
#   OMNICOMPRESS_SRC=/caminho  → usa essa fonte COMO ESTÁ (não mexe no git dela).
#   sem ela                    → clone gerenciado em /tmp, SEMPRE atualizado pro
#                                HEAD do upstream.
#
# Por que atualizar sempre: o clone gerenciado antes só era criado uma vez e nunca
# era atualizado — o sidecar ficava preso num commit antigo e perdia fixes do proxy
# (ex.: streaming SSE + cache_stable, 2026-06-19). Agora o fetch/reset garante que
# o binário embarcado reflete o upstream a cada build.
set -euo pipefail

REPO="https://github.com/jessefreitas/OmniCompress"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/apps/desktop/src-tauri/binaries"

TRIPLE="$(rustc -vV | sed -n 's/host: //p')"
EXT=""
# Windows: linka o CRT MSVC ESTÁTICO no sidecar — senão o .exe exige VCRUNTIME140.dll,
# que não existe num Windows limpo (erro "VCRUNTIME140.dll não foi encontrado" no boot).
case "$TRIPLE" in
  *windows*) EXT=".exe"; export RUSTFLAGS="${RUSTFLAGS:+$RUSTFLAGS }-C target-feature=+crt-static" ;;
esac

if [ -n "${OMNICOMPRESS_SRC:-}" ]; then
  # Fonte do usuário: respeita como está (pode ter edits/working copy).
  SRC="$OMNICOMPRESS_SRC"
else
  # Clone gerenciado: cria se não existe, senão atualiza pro HEAD do upstream.
  SRC="${RUNNER_TEMP:-/tmp}/OmniCompress"
  if [ ! -d "$SRC/.git" ]; then
    git clone --depth 1 "$REPO" "$SRC"
  else
    git -C "$SRC" fetch --depth 1 origin HEAD
    git -C "$SRC" reset --hard FETCH_HEAD
  fi
fi

( cd "$SRC" && cargo build --release \
    -p omnicompress-proxy -p omnicompress-mcp -p omnicompress-cli )

# O target-dir pode estar redirecionado (.cargo/config.toml manda artefatos pro
# SSD, p.ex.) → pergunta pro cargo onde o binário saiu, em vez de assumir target/.
TARGET_DIR="$(cd "$SRC" && cargo metadata --no-deps --format-version 1 \
  | grep -o '"target_directory":"[^"]*"' | head -1 \
  | sed 's/^"target_directory":"//;s/"$//')"
[ -n "$TARGET_DIR" ] || TARGET_DIR="$SRC/target"

# 3 sidecars do OmniCompress (zero-install): proxy (lossless, transparente via
# BASE_URL), mcp (agressivo + retrieve, tools p/ agentes) e a CLI compress/eval/bench.
# O binário da CLI chama-se 'omnicompress' (não 'omnicompress-cli') — ver Cargo [[bin]].
mkdir -p "$DEST"
for bin in omnicompress-proxy omnicompress-mcp omnicompress; do
  cp "$TARGET_DIR/release/$bin$EXT" "$DEST/$bin-$TRIPLE$EXT"
  echo "sidecar pronto: $DEST/$bin-$TRIPLE$EXT"
done
