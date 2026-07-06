#!/usr/bin/env python3
"""UserPromptSubmit: detecta correção humana e manda o modelo registrar na failbase."""
import json
import re
import sys

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


def build_instruction():
    return (
        "[failproof] O usuário está corrigindo você. Antes de refazer o trabalho: "
        "registre o erro na failbase com o comando "
        "`python3 ~/.claude/failbase/failbase.py add --source human-feedback "
        "--symptom \"<o que você fez de errado>\" --root-cause \"<por que errou>\" "
        "--fix \"<entendimento correto>\" --project <slug>`. "
        "Depois aplique a correção. Não repita o padrão que causou a correção.")


def main():
    payload = json.load(sys.stdin)
    if is_correction(payload.get("prompt", "")):
        print(build_instruction())


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
