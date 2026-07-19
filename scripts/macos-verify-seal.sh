#!/usr/bin/env bash
# macos-verify-seal.sh — GUARD de leitura do .dmg no CI (job macos-14 do release.yml).
#
# Por quê existe: o Tauri sela o .app ad-hoc (bundle.macOS.signingIdentity = "-")
# ANTES de empacotar o .dmg. Se esse seal regredir, o bundle sai "linker-signed"
# (Sealed Resources=none) e o Gatekeeper diz "OmniRift is damaged" — mesmo com o
# binário íntegro. Este script falha ALTO quando isso acontece.
#
# Verifica, NÃO modifica: o .dmg publicado tem que ser byte-a-byte o que o
# tauri-action assinou com minisign — reempacotar aqui invalidaria esse .sig.
#
# O .app não sobrevive em target/ — o bundler o remove após criar o .dmg. Por isso
# montamos o .dmg e inspecionamos o .app lá dentro.
#
# Uso: bash scripts/macos-verify-seal.sh   (só macOS — precisa de hdiutil/codesign)

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "❌ Este script só roda em macOS." >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

DMG_DIR="apps/desktop/src-tauri/target/release/bundle/dmg"
DMG="$(find "$DMG_DIR" -maxdepth 1 -type f -name '*.dmg' -print -quit 2>/dev/null)" || true

if [[ -z "$DMG" || ! -f "$DMG" ]]; then
  echo "❌ Nenhum .dmg encontrado em ${DMG_DIR}/ — o tauri build falhou?" >&2
  exit 1
fi
echo "→ DMG: $DMG"

MNT="$(mktemp -d "${TMPDIR:-/tmp}/omnirift-verify.XXXXXX")"
MOUNTED=0

cleanup() {
  if [[ "$MOUNTED" == "1" ]]; then
    hdiutil detach "$MNT" -force >/dev/null 2>&1 || true
  fi
  rm -rf "$MNT" 2>/dev/null || true
}
trap cleanup EXIT

echo "→ Montando (readonly)…"
hdiutil attach "$DMG" -nobrowse -readonly -mountpoint "$MNT" >/dev/null
MOUNTED=1

APP="$MNT/OmniRift.app"
if [[ ! -d "$APP" ]]; then
  APP="$(find "$MNT" -maxdepth 1 -type d -name '*.app' -print -quit 2>/dev/null)" || true
fi
if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "❌ Nenhum .app dentro do dmg — bundle corrompido." >&2
  exit 1
fi
echo "→ App: $APP"

echo "→ Verificando seal…"
if ! codesign --verify --deep --strict "$APP"; then
  echo "❌ Seal ad-hoc do bundler REGREDIU — o Gatekeeper vai dizer 'is damaged'." >&2
  echo "   Confira bundle.macOS.signingIdentity = \"-\" no tauri.conf.json e o env" >&2
  echo "   APPLE_SIGNING_IDENTITY=- no job macos-14 do release.yml." >&2
  exit 1
fi
echo "✓ codesign --verify --deep --strict"

SIG_INFO="$(codesign -dv --verbose=2 "$APP" 2>&1 || true)"
head -n 20 <<< "$SIG_INFO"

if grep -qiE 'linker-signed|Sealed Resources=none' <<< "$SIG_INFO"; then
  echo "❌ Assinatura incompleta (linker-signed / Sealed Resources=none) —" >&2
  echo "   o bundler não aplicou o seal ad-hoc. Gatekeeper: 'is damaged'." >&2
  exit 1
fi
echo "✓ não é linker-signed"


if [[ "${OMNIRIFT_MACOS_NOTARIZED:-0}" != "1" ]]; then
  echo "→ spctl (informativo — build ad-hoc, sem notarização):"
  spctl -a -vv "$APP" 2>&1 || true
  echo "⚠️  Build ad-hoc: o Gatekeeper VAI bloquear na máquina do cliente."
  echo "✓ Seal ad-hoc do dmg OK"
  exit 0
fi

echo "→ Notarização declarada — exigindo ticket grampeado…"

STAPLED=""
if xcrun stapler validate "$APP" >/dev/null 2>&1; then
  STAPLED="app"
elif xcrun stapler validate "$DMG" >/dev/null 2>&1; then
  STAPLED="dmg"
fi

if [[ -z "$STAPLED" ]]; then
  echo "❌ Nenhum ticket de notarização grampeado (nem no .app, nem no .dmg)." >&2
  echo "   O cliente vai ver 'a Apple não pôde verificar se está livre de malware'." >&2
  echo "   Confira APPLE_ID / APPLE_PASSWORD (senha de APP) / APPLE_TEAM_ID no CI." >&2
  exit 1
fi

echo "✓ ticket grampeado (${STAPLED})"

echo "→ spctl (veredito final do Gatekeeper):"
SPCTL_OUT="$(spctl -a -vv --type execute "$APP" 2>&1 || true)"
echo "$SPCTL_OUT"

if ! grep -qi "accepted" <<< "$SPCTL_OUT"; then
  echo "❌ spctl NÃO aceitou o app — o Gatekeeper vai barrar apesar do staple." >&2
  exit 1
fi

echo "✓ spctl: accepted"
echo "✓ .dmg assinado com Developer ID, notarizado e grampeado"