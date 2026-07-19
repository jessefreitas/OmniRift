#!/usr/bin/env python3
"""Stop: bloqueia declaracao de sucesso sem execucao verde apos a ultima edicao.

Camada 2 do gate claim->evidencia: nao basta existir um tool_result verde depois
da edicao — a evidencia precisa COBRIR a claim. Comandos de leitura/inspecao
(ls, cat, grep, find) e validacoes fracas (py_compile, python -c) provam pouco:
py_compile confirma SINTAXE, nao resolucao de nomes nem comportamento.

Politica: blacklist de validacao insuficiente (nao whitelist). Evidencia
desconhecida continua liberando — o gate e fail-open.
"""
import json
import re
import sys

_SUCCESS_RE = re.compile(
    r"corrigid|resolvid|funcionando|funciona agora|conclu[ií]d"
    r"|\bpronto\b|\bfixed\b|\bdone\b|\bworking now\b|passou a funcionar",
    re.IGNORECASE,
)

# Evita marcar vermelho frases como "no error" / "sem erros".
_RED_RE = re.compile(
    r"exit_code: [1-9]|traceback|(?:^|\n)\s*(?:error|fatal|failed)\b",
    re.IGNORECASE,
)

# Comandos que NAO sustentam uma claim de sucesso.
_INSUFFICIENT_RE = re.compile(
    r"^\s*(?:sudo\s+)?(?:ls|cat|head|tail|grep|rg|find|stat|wc|echo|pwd|which|file|tree|du|df|env|printenv)\b"
    r"|python3?\s+-m\s+py_compile\b"
    r"|python3?\s+-c\s+",
    re.IGNORECASE | re.MULTILINE,
)

_EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
_READ_TOOLS = {"Read", "Glob", "Grep"}
_TAIL_EVENTS = 200


def claims_success(text: str) -> bool:
    return bool(_SUCCESS_RE.search(text or ""))


def is_insufficient(cmd: str, tool_name: str = "") -> bool:
    """True se a evidencia nao cobre uma claim de sucesso."""
    if tool_name in _READ_TOOLS:
        return True
    return bool(cmd and _INSUFFICIENT_RE.search(cmd))


def parse_transcript(path: str):
    events = []
    try:
        with open(path, encoding="utf-8") as fh:
            lines = fh.readlines()  # materializa: iterar fh fora do with = handle fechado
    except OSError:
        return events

    for line in lines:
        line = line.strip()
        if not line:
            continue
        try:
            entry = json.loads(line)
        except json.JSONDecodeError:
            continue

        message = entry.get("message") or {}
        content = message.get("content") or []
        if not isinstance(content, list):
            continue

        for block in content:
            if not isinstance(block, dict):
                continue
            kind = block.get("type")

            if kind == "tool_use":
                tool_input = block.get("input") or {}
                cmd = ""
                if isinstance(tool_input, dict):
                    cmd = tool_input.get("command") or ""
                events.append({
                    "kind": "tool_use",
                    "name": block.get("name", ""),
                    "cmd": cmd,
                    "text": "",
                })

            elif kind == "tool_result":
                raw = block.get("content", "")
                text = raw if isinstance(raw, str) else json.dumps(raw, ensure_ascii=False)
                events.append({
                    "kind": "tool_result",
                    "name": "",
                    "cmd": "",
                    "text": text,
                })

            elif kind == "text":
                events.append({
                    "kind": "text",
                    "name": "",
                    "cmd": "",
                    "text": block.get("text", "") or "",
                })

    return events[-_TAIL_EVENTS:] if len(events) > _TAIL_EVENTS else events


def _originating_use(tail, idx):
    """tool_use mais proximo antes de tail[idx] que produziu o resultado."""
    for j in range(idx - 1, -1, -1):
        if tail[j]["kind"] == "tool_use":
            return tail[j]
    return None


def should_block(events) -> bool:
    last_text = next(
        (e["text"] for e in reversed(events) if e["kind"] == "text"),
        "",
    )
    if not claims_success(last_text):
        return False

    last_edit = None
    for i, e in enumerate(events):
        if e["kind"] == "tool_use" and e["name"] in _EDIT_TOOLS:
            last_edit = i
    if last_edit is None:
        return False

    tail = events[last_edit + 1:]
    for i, e in enumerate(tail):
        if e["kind"] != "tool_result" or not e["text"]:
            continue

        if _RED_RE.search(e["text"]):
            continue

        use = _originating_use(tail, i)
        if use and is_insufficient(use.get("cmd", ""), use.get("name", "")):
            continue

        return False

    return True


def decide(payload: dict):
    if payload.get("stop_hook_active"):
        return None

    path = payload.get("transcript_path")
    if not path:
        return None

    try:
        events = parse_transcript(path)
    except Exception:
        return None

    try:
        if should_block(events):
            return {
                "decision": "block",
                "reason": (
                    "[failproof] Voce declarou sucesso mas nao ha execucao verde "
                    "que cubra a afirmacao depois da ultima edicao. Leitura "
                    "(ls/cat/grep/Read) e checagens fracas (py_compile, python -c) "
                    "nao contam: py_compile prova sintaxe, nao que funciona. "
                    "Rode a validacao real (teste/build/lint/execucao) — ou "
                    "reformule sem afirmar que esta corrigido."
                ),
            }
    except Exception:
        return None

    return None


def main():
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return

    out = decide(payload)
    if out:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)