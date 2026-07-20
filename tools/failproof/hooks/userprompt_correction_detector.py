#!/usr/bin/env python3
"""UserPromptSubmit: detecta correção humana e manda o modelo registrar na failbase."""
import json
import os
import re
import sys

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
if _HOME not in sys.path:
    sys.path.insert(0, _HOME)
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)
import failbase

_CORRECTION_RE = re.compile(
    r"((t[aá]|est[aá])\s+errad[oa])"
    r"|(n[aã]o\s+(é|e|era)\s+(assim|isso))"
    r"|(regress[aã]o)"
    r"|(voc[eê]\s+(errou|quebrou))"
    r"|(voltou\s+o\s+erro)"
    r"|(continua\s+(quebrad|errad|falhand))"
    r"|(de\s+novo\s+(isso|esse\s+erro))", re.IGNORECASE)

# padrões que indicam pergunta conceitual, não correção
_QUESTION_RE = re.compile(r"o\s+que\s+[eé]|explica|como\s+funciona", re.IGNORECASE)


def is_correction(prompt):
    if _QUESTION_RE.search(prompt or ""):
        return False
    return bool(_CORRECTION_RE.search(prompt or ""))


def _last_failure_signature(session_id):
    path = os.path.join(failbase.failbase_home(), "session_buffer",
                        failbase.safe_session_key(session_id) + ".jsonl")
    try:
        with open(path) as fh:
            entries = [json.loads(line) for line in fh if line.strip()]
        for entry in reversed(entries):
            if entry.get("failed"):
                return entry.get("sig") or ""
    except Exception:
        pass
    return ""


def build_instruction(signature="", project=""):
    identity = ""
    if signature:
        identity = " --signature \"{}\"".format(signature)
    return (
        "[failproof] O usuário está corrigindo você. Antes de refazer o trabalho: "
        "registre o erro na failbase com o comando "
        "`python3 ~/.claude/failbase/failbase.py add --source human-feedback --validated "
        "--symptom \"<o que você fez de errado>\" --root-cause \"<por que errou>\" "
        "--fix \"<entendimento correto>\" --project \"{}\"{}`. "
        "Depois aplique a correção. Não repita o padrão que causou a correção."
    ).format(project or "global", identity)


def main():
    payload = json.load(sys.stdin)
    if is_correction(payload.get("prompt", "")):
        project = os.path.basename(payload.get("cwd") or "")
        signature = _last_failure_signature(payload.get("session_id"))
        print(build_instruction(signature, project))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
