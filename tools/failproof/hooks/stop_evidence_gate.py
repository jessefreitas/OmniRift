#!/usr/bin/env python3
"""Stop: bloqueia declaração de sucesso sem execução verde após a última edição."""
import json
import re
import sys

_SUCCESS_RE = re.compile(
    r"corrigid|resolvid|funcionando|conclu[ií]d|\bpronto\b|\bfixed\b|passou a funcionar",
    re.IGNORECASE)
_RED_RE = re.compile(
    r"exit_code: [1-9]|failed|error:|traceback|fatal:", re.IGNORECASE)
_EDIT_TOOLS = {"Edit", "Write", "NotebookEdit"}
_TAIL_EVENTS = 200  # só analisa o final do transcript


def claims_success(text):
    return bool(_SUCCESS_RE.search(text or ""))


def parse_transcript(path):
    events = []
    with open(path) as f:
        for line in f:
            try:
                entry = json.loads(line)
            except ValueError:
                continue
            content = ((entry.get("message") or {}).get("content")) or []
            if not isinstance(content, list):
                continue
            for block in content:
                if not isinstance(block, dict):
                    continue
                kind = block.get("type")
                if kind == "tool_use":
                    events.append({"kind": "tool_use", "name": block.get("name", ""),
                                   "text": ""})
                elif kind == "tool_result":
                    raw = block.get("content", "")
                    text = raw if isinstance(raw, str) else json.dumps(raw)
                    events.append({"kind": "tool_result", "name": "", "text": text})
                elif kind == "text":
                    events.append({"kind": "text", "name": "", "text": block.get("text", "")})
    return events[-_TAIL_EVENTS:]


def should_block(events):
    last_text = next((e["text"] for e in reversed(events) if e["kind"] == "text"), "")
    if not claims_success(last_text):
        return False
    last_edit = max((i for i, e in enumerate(events)
                     if e["kind"] == "tool_use" and e["name"] in _EDIT_TOOLS), default=None)
    if last_edit is None:
        return False
    for e in events[last_edit + 1:]:
        if e["kind"] == "tool_result" and e["text"] and not _RED_RE.search(e["text"]):
            return False  # houve execução verde depois da edição
    return True


def decide(payload):
    if payload.get("stop_hook_active"):
        return None  # já bloqueamos neste turno — nunca criar loop
    events = parse_transcript(payload["transcript_path"])
    if should_block(events):
        return {"decision": "block",
                "reason": ("[failproof] Você declarou sucesso mas não há execução verde "
                           "(teste/build/comando) depois da última edição de arquivo. "
                           "Rode a validação real antes de concluir — ou reformule sem "
                           "afirmar que está corrigido.")}
    return None


def main():
    payload = json.load(sys.stdin)
    out = decide(payload)
    if out:
        print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
