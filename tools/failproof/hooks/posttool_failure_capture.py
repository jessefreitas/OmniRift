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

_PAIR_WINDOW = 10          # quantas entradas do buffer olhar pra trás
_PAIR_SECONDS = 15 * 60    # correlação velha não é correção do erro atual
_OUTPUT_TAIL = 1500        # bytes do output guardados


_ENVIRONMENT_RE = re.compile(
    r"index\.lock|Another git process|Host key verification failed|"
    r"Permanently added|Author identity unknown|could not lock config file|"
    r"Read-only file system|No space left on device",
    re.IGNORECASE
)

_SUCCESS_RE = re.compile(
    r"test result: ok|No syntax errors detected|"
    r"\d+ passed[;,]?\s*0 failed|"
    r"RC=0|0 failed|all tests passed|build succeeded",
    re.IGNORECASE
)


def classify_capture(tool_response, command=""):
    if isinstance(tool_response, dict):
        text = json.dumps(tool_response, ensure_ascii=False)
    else:
        text = str(tool_response)

    if _ENVIRONMENT_RE.search(text):
        return "environment"

    if isinstance(tool_response, dict):
        for key in ("exit_code", "exitCode", "returnCode"):
            code = tool_response.get(key)
            if isinstance(code, int):
                if code != 0:
                    return "failure"
                return "not_a_failure"
        if tool_response.get("is_error") is True:
            return "failure"

    if _SUCCESS_RE.search(text):
        return "not_a_failure"

    return "not_a_failure"


def detect_failure(tool_response, command=""):
    return classify_capture(tool_response, command) == "failure"


def _buffer_path(session_id):
    d = os.path.join(failbase.failbase_home(), "session_buffer")
    os.makedirs(d, mode=0o700, exist_ok=True)  # buffer guarda comandos → só o dono lê
    return os.path.join(d, "{}.jsonl".format(failbase.safe_session_key(session_id)))


def _read_buffer(path):
    if not os.path.exists(path):
        return []
    entries = []
    with open(path) as f:
        for line in f:
            try:
                if line.strip():
                    entries.append(json.loads(line))
            except (TypeError, ValueError):
                continue
    return entries


def _response_text(response):
    if not isinstance(response, dict):
        return str(response)
    values = []
    for key in ("stdout", "stderr", "output", "content"):
        value = response.get(key)
        if value:
            values.append(value if isinstance(value, str)
                          else json.dumps(value, ensure_ascii=False))
    return "\n".join(values) or json.dumps(response, ensure_ascii=False)


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
    output = _response_text(response)[-_OUTPUT_TAIL:]
    capture = classify_capture(response, command)
    failed = capture == "failure"
    sig = failbase.normalize_signature(output, command)
    buf_path = _buffer_path(session)
    entries = _read_buffer(buf_path)
    context = None
    fb = failbase.FailBase()

    if capture == "environment":
        fb.add(symptom=output, signature=sig, command=command, project=project,
               error_class="environment")
    elif failed:
        known = fb.lookup(sig, project)
        # Toda falha entra na base, mesmo antes de existir um fix.
        fb.add(symptom=output, signature=sig, command=command, project=project,
               error_class=capture)
        if known and known["fix"]:
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
                    and time.time() - float(e.get("ts") or 0) <= _PAIR_SECONDS
                    and _same_family(e["command"], command)
                    and e["command"].strip() != command.strip()):
                # correlação temporal ≠ prova. Guarda como OBSERVADO (fix_validated=False);
                # só human-feedback/CI promovem a validado.
                fb.add(symptom=e["output"], fix=command, command=e["command"],
                       signature=e.get("sig") or None,
                       source="session", project=project, fix_validated=False)
                e["resolved"] = True
                resolved_any = True
                break
        if resolved_any:
            with open(buf_path, "w") as f:
                for x in entries:
                    f.write(json.dumps(x, ensure_ascii=False) + "\n")

    with open(buf_path, "a") as f:
        f.write(json.dumps({"ts": time.time(), "command": failbase.redact_secrets(command),
                            "sig": sig, "failed": failed,
                            "output": failbase.redact_secrets(output), "resolved": False},
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
