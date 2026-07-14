#!/usr/bin/env bash
# install-macos-dev.sh — builda o OmniRift da branch atual e instala como
# "OmniRift Dev vX.Y" em /Applications, SEM sobrescrever o OmniRift oficial.
#
# A cada build:
#   1. Lê a versão em scripts/omnirift-dev-version (ex.: 1.1)
#   2. Apaga TODAS as instalações anteriores "OmniRift Dev*.app"
#   3. Instala como /Applications/OmniRift Dev vX.Y.app
#   4. Incrementa a versão patch (1.1 → 1.2) pro próximo build
#
# Uso (na raiz do monorepo):
#   bash scripts/install-macos-dev.sh
#   DEV_VERSION=1.5 bash scripts/install-macos-dev.sh   # força versão
#   SKIP_BUMP=1 bash scripts/install-macos-dev.sh       # não incrementa
#
# Requisitos: macOS Apple Silicon, Node 20+, Rust, Xcode CLT.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ Só macOS." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

VERSION_FILE="$ROOT/scripts/omnirift-dev-version"
if [[ -n "${DEV_VERSION:-}" ]]; then
  VER="$DEV_VERSION"
elif [[ -f "$VERSION_FILE" ]]; then
  VER="$(tr -d '[:space:]' < "$VERSION_FILE")"
else
  VER="1.1"
fi
# normaliza (só dígitos e ponto)
if [[ ! "$VER" =~ ^[0-9]+(\.[0-9]+)*$ ]]; then
  echo "❌ Versão inválida: '$VER' (use ex.: 1.1)" >&2
  exit 1
fi

APP_LABEL="OmniRift Dev v${VER}"
APP_NAME="${APP_LABEL}.app"
DEST="/Applications/${APP_NAME}"
CONF="src-tauri/tauri.dev-install.conf.json"

# Gera conf temporária com productName/title versionados (Dock + bundle name)
TMP_CONF="$(mktemp -t omnirift-dev-conf).json"
trap 'rm -f "$TMP_CONF"' EXIT
python3 - "$CONF" "$TMP_CONF" "$APP_LABEL" <<'PY'
import json, sys
base_path, out_path, label = sys.argv[1], sys.argv[2], sys.argv[3]
# conf base (tauri.dev-install.conf.json) é merge partial
with open(base_path) as f:
    cfg = json.load(f)
cfg["productName"] = label
cfg.setdefault("app", {}).setdefault("windows", [{}])
if isinstance(cfg["app"]["windows"], list) and cfg["app"]["windows"]:
    cfg["app"]["windows"][0]["title"] = label
else:
    cfg["app"]["windows"] = [{"title": label}]
# identifier estável (mesmo app dev; não muda a cada versão)
cfg["identifier"] = "com.omniforge.omnirift.dev"
with open(out_path, "w") as f:
    json.dump(cfg, f, indent=2)
    f.write("\n")
print(out_path)
PY

echo "→ Branch: $(git branch --show-current 2>/dev/null || echo '?')"
echo "→ Versão dev: v${VER}"
echo "→ Instalando como: ${DEST}"
echo "→ (o OmniRift oficial em /Applications/OmniRift.app não é tocado)"
echo

if [[ ! -d node_modules ]]; then
  echo "→ npm install (primeira vez)…"
  npm install
fi

if [[ -f scripts/build-omnicompress.sh ]]; then
  echo "→ Build OmniCompress sidecars…"
  bash scripts/build-omnicompress.sh || echo "⚠ omnicompress sidecar falhou — seguindo (pode faltar no bundle)"
fi

echo "→ tauri build (productName=${APP_LABEL})…"
# conf path relativo ao apps/desktop (cwd do workspace script)
# copiamos a conf gerada para o desktop src-tauri
cp "$TMP_CONF" apps/desktop/src-tauri/tauri.dev-install.generated.json
npm run tauri:build --workspace=apps/desktop -- \
  --config src-tauri/tauri.dev-install.generated.json \
  --bundles app

# Localiza o .app gerado (nome versionado ou fallback)
APP="$(find apps/desktop/src-tauri/target -type d -name "${APP_LABEL}.app" 2>/dev/null \
  | grep '/release/' | head -n 1 || true)"

if [[ -z "$APP" || ! -d "$APP" ]]; then
  APP="$(find apps/desktop/src-tauri/target -type d -name 'OmniRift Dev*.app' 2>/dev/null \
    | grep '/release/bundle' | head -n 1 || true)"
fi

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "❌ .app de Dev não encontrado em target/release." >&2
  find apps/desktop/src-tauri/target -name '*.app' -type d 2>/dev/null | head -20 >&2 || true
  exit 1
fi

echo "→ App gerado: $APP"

if [[ -f scripts/macos-adhoc-codesign.sh ]]; then
  bash scripts/macos-adhoc-codesign.sh "$APP" || codesign --force --deep --sign - "$APP"
else
  codesign --force --deep --sign - "$APP"
fi

echo "→ Removendo instalações Dev anteriores em /Applications…"
# Apaga OmniRift Dev.app e OmniRift Dev v*.app (qualquer versão antiga)
while IFS= read -r old; do
  [[ -z "$old" ]] && continue
  if [[ "$(basename "$old")" == "$(basename "$DEST")" ]]; then
    continue
  fi
  echo "   rm -rf $old"
  rm -rf "$old"
done < <(find /Applications -maxdepth 1 \( -name 'OmniRift Dev.app' -o -name 'OmniRift Dev v*.app' \) 2>/dev/null)
# se reinstalando a mesma versão, limpa o destino
rm -rf "$DEST"

echo "→ Instalando em $DEST"
cp -R "$APP" "$DEST"
xattr -cr "$DEST" 2>/dev/null || true
codesign --force --deep --sign - "$DEST" 2>/dev/null || true

# Bump versão pro próximo build (1.1 → 1.2; 1 → 1.1 se só major)
if [[ "${SKIP_BUMP:-0}" != "1" ]]; then
  IFS='.' read -r major minor rest <<<"${VER}."
  major="${major:-1}"
  minor="${minor:-0}"
  if [[ -n "${minor}" && "$minor" != "" ]]; then
    next="${major}.$((minor + 1))"
  else
    next="${major}.1"
  fi
  # se VER era "1.1.0" com 3 partes, só bumpamos minor do semver curto major.minor
  echo "$next" > "$VERSION_FILE"
  echo "→ Próxima versão dev: v${next} (gravado em scripts/omnirift-dev-version)"
fi

echo
echo "✓ Instalado: $DEST"
echo "  Spotlight: OmniRift Dev v${VER}"
echo "  open \"$DEST\""
echo
open "$DEST" || true
