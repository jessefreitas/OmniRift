#!/usr/bin/env bash
# install-macos.sh — instala o OmniRift no macOS (Apple Silicon) sem o erro
# "App is damaged and can't be opened".
#
# Fluxo:
#   1. Baixa o .dmg mais recente (ou usa um path local)
#   2. Copia OmniRift.app → /Applications
#   3. Remove quarentena (com.apple.quarantine do download)
#   4. Re-sela com codesign ad-hoc (defesa em profundidade se o release ainda
#      vier com assinatura linker-signed incompleta)
#   5. Abre o app
#
# Uso:
#   bash scripts/install-macos.sh
#   bash scripts/install-macos.sh /caminho/OmniRift_x.y.z_aarch64.dmg
#   curl -fsSL https://raw.githubusercontent.com/jessefreitas/OmniRift/main/scripts/install-macos.sh | bash
#
# Requisitos: macOS Apple Silicon (arm64), curl, hdiutil, codesign.
# Isso NÃO substitui Developer ID + notarization — é o caminho de beta até o
# time assinar/notarizar o release.

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ Este script é só para macOS." >&2
  exit 1
fi

if [[ "$(uname -m)" != "arm64" ]]; then
  echo "❌ Builds oficiais são Apple Silicon (arm64). Este Mac é $(uname -m)." >&2
  exit 1
fi

REPO="${OMNIRIFT_REPO:-jessefreitas/OmniRift}"
APP_NAME="OmniRift.app"
DEST="/Applications/${APP_NAME}"
TMPDIR_INSTALL="$(mktemp -d "${TMPDIR:-/tmp}/omnirift-install.XXXXXX")"
cleanup() { rm -rf "$TMPDIR_INSTALL"; }
trap cleanup EXIT

DMG_SRC="${1:-}"

download_latest_dmg() {
  echo "→ Buscando .dmg mais recente em github.com/${REPO}/releases/latest …"
  # API pública; não precisa de auth para release público
  local url
  url="$(curl -fsSL "https://api.github.com/repos/${REPO}/releases/latest" \
    | python3 -c '
import json,sys
rel=json.load(sys.stdin)
for a in rel.get("assets",[]):
    n=a.get("name","")
    if n.endswith(".dmg") and ("aarch64" in n or "arm64" in n):
        print(a["browser_download_url"]); sys.exit(0)
for a in rel.get("assets",[]):
    if a.get("name","").endswith(".dmg"):
        print(a["browser_download_url"]); sys.exit(0)
sys.exit("nenhum .dmg no release latest")
')"
  if [[ -z "$url" ]]; then
    echo "❌ Não achei .dmg no latest release de ${REPO}." >&2
    exit 1
  fi
  local out="${TMPDIR_INSTALL}/OmniRift.dmg"
  echo "→ Baixando: $url"
  curl -fL --progress-bar -o "$out" "$url"
  DMG_SRC="$out"
}

if [[ -z "$DMG_SRC" ]]; then
  download_latest_dmg
elif [[ ! -f "$DMG_SRC" ]]; then
  echo "❌ Arquivo não encontrado: $DMG_SRC" >&2
  exit 1
fi

echo "→ Montando DMG: $DMG_SRC"
MNT="$(hdiutil attach -nobrowse -readonly "$DMG_SRC" | awk '/\/Volumes\// {print $3; exit}')"
if [[ -z "$MNT" || ! -d "$MNT" ]]; then
  echo "❌ Falha ao montar o DMG." >&2
  exit 1
fi
detach() { hdiutil detach "$MNT" -quiet 2>/dev/null || true; }
trap 'detach; cleanup' EXIT

SRC_APP="$(find "$MNT" -maxdepth 2 -type d -name "$APP_NAME" | head -n 1 || true)"
if [[ -z "$SRC_APP" ]]; then
  echo "❌ ${APP_NAME} não encontrado dentro do DMG." >&2
  exit 1
fi

echo "→ Instalando em $DEST"
# Substitui instalação anterior sem pedir (beta)
rm -rf "$DEST"
# cp -R preserva atributos do volume; em seguida limpamos quarentena/sign
cp -R "$SRC_APP" "$DEST"

detach
trap cleanup EXIT

echo "→ Removendo quarentena (Gatekeeper download flag)…"
xattr -cr "$DEST" 2>/dev/null || true

echo "→ Selando ad-hoc (assinatura completa do bundle)…"
codesign --force --deep --sign - "$DEST"
codesign --verify --deep --strict "$DEST" || {
  echo "⚠️  codesign --verify falhou; tentando abrir mesmo assim." >&2
}

echo "→ Abrindo OmniRift…"
open "$DEST"

echo ""
echo "✓ Instalado em $DEST"
echo "  Se o macOS ainda bloquear: Ajustes do Sistema → Privacidade e Segurança → Abrir mesmo assim."
echo "  Solução definitiva (time): Apple Developer ID + notarize + staple no CI."
