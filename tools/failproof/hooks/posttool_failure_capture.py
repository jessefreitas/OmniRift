#!/usr/bin/env python3
"""PostToolUse(Bash): captura pares falha→fix e devolve fixes conhecidos. Falha-aberto."""
import json
import os
import re
import sys
import time

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (_HOME, _REPO):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import failbase

_ERROR_MARKERS = re.compile(
    r"traceback \(most recent call last\)|command not found|permission denied"
    r"|fatal:|error:|failed|exit code [1-9]|panicked at|segmentation fault", re.IGNORECASE)
_PAIR_WINDOW = 10          # quantas entradas do buffer olhar pra trás
_OUTPUT_TAIL = 1500        # bytes do output guardados


# Comandos "leitores": o output deles é texto arbitrário (logs, código) — conter
# "error:"/"failed" NÃO indica falha do comando. Sem exit code, não classifica.
_READER_CMDS = {"grep", "rg", "egrep", "fgrep", "cat", "tail", "head", "less",
                "journalctl", "ag", "awk", "sed", "jq", "echo", "printf", "find"}


def detect_failure(tool_response, command=""):
    if isinstance(tool_response, dict):
        for key in ("exit_code", "exitCode", "returnCode"):
            code = tool_response.get(key)
            if isinstance(code, int):
                return code != 0
        if tool_response.get("is_error") is True:
            return True
        text = json.dumps(tool_response, ensure_ascii=False)
    else:
        text = str(tool_response)
    head = (command.strip().split() or [""])[0].rsplit("/", 1)[-1]
    if head in _READER_CMDS:
        return False
    return bool(_ERROR_MARKERS.search(text))


def _buffer_path(session_id):
    d = os.path.join(failbase.failbase_home(), "session_buffer")
    os.makedirs(d, mode=0o700, exist_ok=True)  # buffer guarda comandos → só o dono lê
    return os.path.join(d, "{}.jsonl".format(session_id))


def _read_buffer(path):
    if not os.path.exists(path):
        return []
    with open(path) as f:
        return [json.loads(l) for l in f if l.strip()]


def _same_family(cmd_a, cmd_b):
    ta, tb = cmd_a.strip().split(), cmd_b.strip().split()
    return bool(ta) and bool(tb) and ta[0] == tb[0]


def process(payload):
    """Retorna additionalContext (str) ou None."""
    if payload.get("tool_name") != "Bash":
        return None
    command = (payload.get("tool_input") or {}).get("command", "")
    response = payload.get("tool_response") or {}
    session = payload.get("session_id", "unknown")
    project = os.path.basename(payload.get("cwd") or "")
    output = (response.get("stdout", "") if isinstance(response, dict)
              else str(response))[-_OUTPUT_TAIL:]
    failed = detect_failure(response, command)
    sig = failbase.normalize_signature(output, command)
    buf_path = _buffer_path(session)
    entries = _read_buffer(buf_path)
    context = None
    fb = failbase.FailBase()

    if failed:
        known = fb.lookup(sig)
        if known and known["fix"]:
            fb.add(symptom=output, signature=sig, command=command, project=project)
            hits = known["hits"] + 1
            if known["fix_validated"]:
                # sinal forte (confirmado por humano/CI) — ainda assim peça confirmação.
                context = ("💡 Failbase: erro conhecido (visto {}x). Fix confirmado antes "
                           "— confirme que se aplica ao seu caso:\n{}").format(hits, known["fix"])
            else:
                # candidato observado por heurística — trate como pista, não como verdade.
                context = ("💡 Failbase: erro parecido já visto ({}x). Possível fix observado "
                           "num caso semelhante (NÃO confirmado) — avalie antes de aplicar:\n{}"
                           ).format(hits, known["fix"])
    else:
        resolved_any = False
        for e in reversed(entries[-_PAIR_WINDOW:]):
            # comando idêntico que passou na 2ª tentativa = flaky/retry, não é "fix".
            if (e.get("failed") and not e.get("resolved")
                    and _same_family(e["command"], command)
                    and e["command"].strip() != command.strip()):
                # correlação temporal ≠ prova. Guarda como OBSERVADO (fix_validated=False);
                # só human-feedback/CI promovem a validado.
                fb.add(symptom=e["output"], fix=command, command=e["command"],
                       source="session", project=project, fix_validated=False)
                e["resolved"] = True
                resolved_any = True
                break
        if resolved_any:
            with open(buf_path, "w") as f:
                for x in entries:
                    f.write(json.dumps(x, ensure_ascii=False) + "\n")

    with open(buf_path, "a") as f:
        f.write(json.dumps({"ts": time.time(), "command": command, "sig": sig,
                            "failed": failed, "output": output, "resolved": False},
                           ensure_ascii=False) + "\n")
    return context


def main():
    payload = json.load(sys.stdin)
    context = process(payload)
    if context:
        print(json.dumps({"hookSpecificOutput": {
            "hookEventName": "PostToolUse", "additionalContext": context}}))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
