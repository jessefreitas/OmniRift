#!/usr/bin/env bash
# failproof installer — portátil, idempotente, merge (nunca sobrescreve settings alheios).
set -euo pipefail
SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLAUDE="$HOME/.claude"
FB="$CLAUDE/failbase"

mkdir -p "$FB" "$CLAUDE/hooks" "$FB/watch" "$FB/alerts" "$FB/postmortems"

# núcleo + watchdog + ci + plugins vivem em ~/.claude/failbase
cp "$SRC/failbase.py" "$SRC/watchdog.py" "$SRC/failbase_ci.py" "$FB/"
mkdir -p "$FB/plugins" && cp "$SRC"/plugins/*.py "$FB/plugins/"

# hooks com prefixo failproof_ em ~/.claude/hooks
for h in "$SRC"/hooks/*.py; do
  cp "$h" "$CLAUDE/hooks/failproof_$(basename "$h")"
done

# merge de settings.json (python stdlib, idempotente)
python3 - "$CLAUDE/settings.json" <<'PY'
import json, os, sys
path = sys.argv[1]
settings = {}
if os.path.exists(path):
    with open(path) as f:
        settings = json.load(f)
hooks = settings.setdefault("hooks", {})
WANTED = {
    "PostToolUse": ("Bash", "failproof_posttool_failure_capture.py"),
    "UserPromptSubmit": (None, "failproof_userprompt_correction_detector.py"),
    "Stop": (None, "failproof_stop_evidence_gate.py"),
    "SessionStart": (None, "failproof_sessionstart_known_failures.py"),
}
for event, (matcher, script) in WANTED.items():
    entries = hooks.setdefault(event, [])
    cmd = "python3 ~/.claude/hooks/{}".format(script)
    if any(cmd in json.dumps(e) for e in entries):
        continue
    entry = {"hooks": [{"type": "command", "command": cmd, "timeout": 10}]}
    if matcher:
        entry["matcher"] = matcher
    entries.append(entry)
with open(path, "w") as f:
    json.dump(settings, f, indent=2, ensure_ascii=False)
print("settings.json: hooks failproof registrados")
PY

# watchdog: systemd user timer se disponível, senão instrução de cron
if command -v systemctl >/dev/null 2>&1 && systemctl --user status >/dev/null 2>&1; then
  mkdir -p "$HOME/.config/systemd/user"
  cat > "$HOME/.config/systemd/user/failproof-watchdog.service" <<EOF
[Unit]
Description=failproof watchdog
[Service]
Type=oneshot
ExecStart=$(command -v python3) $FB/watchdog.py
EOF
  cat > "$HOME/.config/systemd/user/failproof-watchdog.timer" <<EOF
[Unit]
Description=failproof watchdog a cada 5 min
[Timer]
OnBootSec=2min
OnUnitActiveSec=5min
[Install]
WantedBy=timers.target
EOF
  if systemctl --user daemon-reload && systemctl --user enable --now failproof-watchdog.timer; then
    echo "watchdog: systemd user timer ativo"
  else
    echo "watchdog: systemd falhou ao ativar o timer — adicione ao cron:"
    echo "  */5 * * * * python3 $FB/watchdog.py"
  fi
else
  echo "watchdog: systemd indisponível — adicione ao cron:"
  echo "  */5 * * * * python3 $FB/watchdog.py"
fi

# plugins: detecção informativa
[ -n "${FAILPROOF_SYNC_CMD:-}" ] && echo "plugin sync-omnimemory: ATIVO" || echo "plugin sync-omnimemory: inativo (sem FAILPROOF_SYNC_CMD)"
[ -n "${FAILPROOF_NTFY_URL:-}${FAILPROOF_TELEGRAM_TOKEN:-}" ] && echo "plugin notify: ATIVO" || echo "plugin notify: fallback arquivo (~/.claude/failbase/alerts/)"

echo "failproof instalado. Base: $FB/failbase.db"
