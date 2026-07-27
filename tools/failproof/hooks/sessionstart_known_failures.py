#!/usr/bin/env python3
"""SessionStart: injeta os erros mais recorrentes do projeto no contexto."""
import hashlib
import json
import os
import sys

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (_HOME, _REPO):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import failbase

MAX_CHARS = 2000  # ~500 tokens
TOP_N = 10


def build_context(project, session_key=""):
    fb = failbase.FailBase()
    rows = fb.top_for_project(project, limit=TOP_N)
    if not rows:
        return ""
    lines = ["[failproof] Erros já conhecidos neste projeto — não repita:"]
    shown = []
    for r in rows:
        item = "- ({}x) {}".format(r["hits"], r["symptom"][:150].replace("\n", " "))
        if r["fix"]:
            # tag de confiança: confirmado (humano/CI) vs observado (heurística).
            tag = "FIX confirmado" if r["fix_validated"] else "fix observado (não confirmado)"
            item += " → {}: {}".format(tag, r["fix"][:150].replace("\n", " "))
        if len("\n".join(lines + [item])) > MAX_CHARS:
            break
        lines.append(item)
        shown.append(r["signature"])
    if shown:
        fb.record_cards_shown(shown, project=project, session_key=session_key)
    return "\n".join(lines) if len(lines) > 1 else ""


def main():
    payload = json.load(sys.stdin)
    project = os.path.basename(payload.get("cwd") or os.getcwd())
    session_key = hashlib.sha256(str(payload.get("session_id") or "").encode()).hexdigest()[:16]
    ctx = build_context(project, session_key)
    if ctx:
        print(ctx)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
