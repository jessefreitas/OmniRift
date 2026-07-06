#!/usr/bin/env bash
# Remove hooks e timers do failproof. Preserva o DB (dados) e settings alheios.
set -euo pipefail
CLAUDE="$HOME/.claude"

rm -f "$CLAUDE"/hooks/failproof_*.py

python3 - "$CLAUDE/settings.json" <<'PY'
import json, os, sys
path = sys.argv[1]
if os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
    hooks = settings.get("hooks", {})
    for event in list(hooks):
        hooks[event] = [e for e in hooks[event] if "failproof_" not in json.dumps(e)]
        if not hooks[event]:
            del hooks[event]
    with open(path, "w") as f:
        json.dump(settings, f, indent=2, ensure_ascii=False)
PY

if command -v systemctl >/dev/null 2>&1; then
  systemctl --user disable --now failproof-watchdog.timer 2>/dev/null || true
  rm -f "$HOME/.config/systemd/user/failproof-watchdog".{service,timer}
  systemctl --user daemon-reload 2>/dev/null || true
fi
echo "failproof removido (DB preservado em ~/.claude/failbase/failbase.db)"
