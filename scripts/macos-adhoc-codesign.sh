#!/usr/bin/env bash
# macos-adhoc-codesign.sh — selagem ad-hoc do .app (sem Apple Developer ID).
#
# Por quê: builds Tauri sem signingIdentity saem com assinatura "linker-signed"
# incompleta (Sealed Resources=none). No macOS moderno o Gatekeeper traduz isso
# em "OmniRift is damaged and can't be opened" — mesmo com o binário íntegro.
#
# O que este script faz:
#   codesign --force --deep --sign -  → identidade ad-hoc com sealed resources
#
# O que NÃO faz (e não pode fazer sem Developer ID + notarize):
#   • remover a quarentena de um download futuro (isso é no install, ver install-macos.sh)
#   • passar no Gatekeeper com double-click limpo pra sempre
#
# Uso:
#   bash scripts/macos-adhoc-codesign.sh /caminho/OmniRift.app
#   bash scripts/macos-adhoc-codesign.sh   # procura o .app sob apps/desktop/src-tauri/target

set -euo pipefail

APP="${1:-}"

if [[ -z "$APP" ]]; then
  # Preferir o bundle de release; cai pro debug se não houver.
  APP="$(find apps/desktop/src-tauri/target -type d -name 'OmniRift.app' 2>/dev/null \
    | grep -E '/release/|/debug/' \
    | head -n 1 || true)"
fi

if [[ -z "$APP" || ! -d "$APP" ]]; then
  echo "❌ OmniRift.app não encontrado. Passe o path: $0 /caminho/OmniRift.app" >&2
  exit 1
fi

echo "→ Ad-hoc codesign: $APP"
# --deep: sidecars (omnicompress*, omnifs-mcp) e frameworks
# --sign - : identidade ad-hoc (sem certificado pago)
# --timestamp=none: ad-hoc não usa timestamp Apple
# --options runtime omitido de propósito — hardened runtime exige entitlements
#   e cert; ad-hoc sem options evita falha no CI sem Developer ID.
codesign --force --deep --sign - "$APP"

echo "→ Verificando…"
codesign --verify --deep --strict "$APP"
codesign -dv --verbose=2 "$APP" 2>&1 | head -n 20

# spctl em ad-hoc quase sempre falha (expected). Só avisa.
if spctl -a -vv "$APP" 2>&1 | grep -qi 'accepted'; then
  echo "✓ spctl accepted"
else
  echo "ℹ spctl rejeita ad-hoc (esperado sem Developer ID/notarize)."
  echo "  O 'is damaged' por assinatura incompleta, porém, fica resolvido."
fi

echo "✓ Ad-hoc seal OK"
