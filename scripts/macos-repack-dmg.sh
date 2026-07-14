#!/usr/bin/env bash
# macos-repack-dmg.sh — pós-build no CI (job macos-14 do release.yml).
#
# 1. Acha o OmniRift.app em target/
# 2. Garante seal ad-hoc (codesign --force --deep --sign -)
# 3. Reempacota o .dmg
# 4. Se TAG + GH_TOKEN estiverem setados, faz upload --clobber no draft release
#
# Idempotente: se o app já estiver bem selado, só reempacota se o dmg faltar
# ou se o seal tiver sido refeito.
#
# NÃO regenera .sig minisign do updater (precisa da chave privada). O job de
# release já assinou o dmg antigo; se reempacotarmos, o .sig antigo fica
# inválido para o updater. Por isso preferimos que o seal venha do
# signingIdentity="-" no tauri build. Este script é fallback + garante que o
# .app *dentro* do dmg está selado; o .sig do dmg é refeito só se
# TAURI_SIGNING_PRIVATE_KEY estiver no ambiente (opcional).

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

APP="$(find apps/desktop/src-tauri/target -type d -name 'OmniRift.app' 2>/dev/null \
  | grep '/release/' | head -n 1 || true)"

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "❌ OmniRift.app (release) não encontrado sob target/ — o tauri build falhou?" >&2
  exit 1
fi

echo "→ App: $APP"
bash scripts/macos-adhoc-codesign.sh "$APP"

# Volume name + staging
STAGE="$(mktemp -d "${TMPDIR:-/tmp}/omnirift-dmg.XXXXXX")"
trap 'rm -rf "$STAGE"' EXIT
cp -R "$APP" "$STAGE/OmniRift.app"

# Nome estável alinhado ao que o tauri-action costuma publicar
VERSION="$(python3 -c "import json; print(json.load(open('apps/desktop/src-tauri/tauri.conf.json'))['version'])")"
DMG_NAME="OmniRift_${VERSION}_aarch64.dmg"
OUT_DIR="apps/desktop/src-tauri/target/release/bundle/dmg"
mkdir -p "$OUT_DIR"
OUT_DMG="${OUT_DIR}/${DMG_NAME}"

echo "→ Criando $OUT_DMG"
rm -f "$OUT_DMG"
hdiutil create \
  -volname "OmniRift" \
  -srcfolder "$STAGE" \
  -ov \
  -format UDZO \
  "$OUT_DMG"

ls -lh "$OUT_DMG"

# Reupload no draft release (tauri-action já anexou o dmg "velho")
if [[ -n "${TAG:-}" && -n "${GH_TOKEN:-}" ]]; then
  echo "→ Upload --clobber no release draft ${TAG}: ${DMG_NAME}"
  gh release upload "$TAG" "$OUT_DMG" \
    -R "${GITHUB_REPOSITORY:-jessefreitas/OmniRift}" \
    --clobber

  # Regenera .sig do updater se a chave minisign estiver no ambiente
  if [[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ]]; then
    echo "→ Regenerando assinatura minisign do dmg (updater)…"
    # tauri signer CLI se disponível; senão avisa
    if command -v npx >/dev/null 2>&1; then
      # Escreve a chave em arquivo temporário (formato esperado pelo tauri signer)
      KEYFILE="$(mktemp)"
      printf '%s\n' "$TAURI_SIGNING_PRIVATE_KEY" > "$KEYFILE"
      if npx --yes @tauri-apps/cli signer sign "$OUT_DMG" -f "$KEYFILE" -p "${TAURI_SIGNING_PRIVATE_KEY_PASSWORD:-}" 2>/dev/null; then
        if [[ -f "${OUT_DMG}.sig" ]]; then
          gh release upload "$TAG" "${OUT_DMG}.sig" \
            -R "${GITHUB_REPOSITORY:-jessefreitas/OmniRift}" \
            --clobber
          echo "✓ .sig reenviado"
        fi
      else
        echo "⚠ Não regenerou .sig (signer indisponível/falhou)."
        echo "  Updater pode rejeitar o dmg até o próximo release com seal nativo do Tauri."
      fi
      rm -f "$KEYFILE"
    fi
  else
    echo "ℹ TAURI_SIGNING_PRIVATE_KEY ausente neste step — .sig do dmg não regenerado."
    echo "  O seal ad-hoc no .app *dentro* do dmg já resolve o Gatekeeper 'is damaged'."
  fi
else
  echo "ℹ TAG/GH_TOKEN ausentes — dmg local gerado em $OUT_DMG (sem upload)."
fi

echo "✓ macOS dmg post-process OK"
