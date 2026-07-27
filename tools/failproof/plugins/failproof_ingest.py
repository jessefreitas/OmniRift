#!/usr/bin/env python3
import os
import sys
import json
import time
import urllib.request
import urllib.error


URL = os.environ.get("OMNIMEMORY_URL", "https://memory.omnimemory.com.br").rstrip("/")
TOKEN = os.environ.get("OMNIMEMORY_TOKEN", "")
ENDPOINT = URL + "/actions/omnimemory/v1/save_project_memory"

DEFAULT_PROJECT = "memory_claude_codex"
FORBIDDEN_PROJECTS = {"bin", "tmp", "scratchpad", "root", "unknown", "."}

SENSITIVE_KEYWORDS = ("sensivel", "sensitive")

if not TOKEN:
    sys.stderr.write("OMNIMEMORY_TOKEN nao configurado\n")
    sys.exit(2)


sys.path.insert(0, os.path.expanduser("~/.claude/failbase"))
try:
    import failbase

    _redact_fn = getattr(failbase, "redact_secrets", None)
except Exception:
    _redact_fn = None


def redact(value):
    if _redact_fn is None or not isinstance(value, str):
        return value
    try:
        return _redact_fn(value)
    except Exception as exc:
        sys.stderr.write(f"aviso: redacao falhou: {exc}\n")
        return value


def normalize_project(raw):
    original = raw if isinstance(raw, str) else ""
    norm = original.strip().lower()
    if not norm or norm in FORBIDDEN_PROJECTS:
        return DEFAULT_PROJECT, original
    return original, original


def first_nonempty_line(text):
    if not isinstance(text, str):
        return ""
    for line in text.splitlines():
        stripped = line.strip()
        if stripped:
            return stripped
    return ""


def build_payload(row):
    raw_project = row.get("project")
    project, original_project = normalize_project(raw_project)

    symptom = redact(row.get("symptom", ""))
    root_cause = redact(row.get("root_cause", ""))
    fix = redact(row.get("fix", ""))
    validated_source = redact(row.get("validated_source", ""))

    signature = str(row.get("signature", ""))
    sig16 = signature[:16]

    summary_raw = first_nonempty_line(symptom)
    summary = "[failproof] " + summary_raw
    if len(summary) > 120:
        summary = summary[:120]

    tags = ["failproof", "error-lesson", "sig:" + sig16]
    if row.get("fix_validated"):
        tags.append("fix-validated")
    error_class = row.get("error_class")
    if isinstance(error_class, str) and error_class.strip():
        tags.append("class:" + error_class.strip())

    sections = []
    if symptom.strip():
        sections.append("## Sintoma\n\n" + symptom.strip())
    if root_cause.strip():
        sections.append("## Causa raiz\n\n" + root_cause.strip())
    if fix.strip():
        sections.append("## Correcao\n\n" + fix.strip())
    if validated_source.strip():
        sections.append("## Evidencia de validacao\n\n" + validated_source.strip())

    hits = row.get("hits", "")
    command_family = row.get("command_family", "")
    last_seen_at = row.get("last_seen_at", "")

    footer = (
        "---\n"
        f"assinatura: {signature} | ocorrencias: {hits} | comando: {command_family}\n"
        f"origem: failbase local (projeto {original_project}) | visto por ultimo: {last_seen_at}\n"
    )

    content = "\n\n".join(sections + [footer])

    return {
        "content": content,
        "project": project,
        "category": "error_lesson",
        "summary": summary,
        "source": "failproof-sync",
        "tags": tags,
    }, sig16, original_project


def is_sensitive_error(status, body_text):
    if status != 400:
        return False
    lowered = body_text.lower()
    return any(kw in lowered for kw in SENSITIVE_KEYWORDS)


def parse_retry_after(body_text):
    try:
        data = json.loads(body_text)
        val = data.get("retry_after", 60)
        return max(1, int(val))
    except Exception:
        return 60


def do_http_request(payload, sig16, attempt, first_request_flag):
    if not first_request_flag[0]:
        time.sleep(1.1)
    first_request_flag[0] = False

    headers = {
        "Authorization": f"Bearer {TOKEN}",
        "Content-Type": "application/json",
        "User-Agent": "Mozilla/5.0 (compatible; OmniMemory-CLI/1.0)",
    }
    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        ENDPOINT, data=data, headers=headers, method="POST"
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            resp.read()
            return True, resp.status, ""
    except urllib.error.HTTPError as e:
        body_bytes = e.read()
        body_text = body_bytes.decode("utf-8", errors="replace")
        return False, e.code, body_text
    except urllib.error.URLError as e:
        return False, -1, str(e)
    except Exception as e:
        return False, -1, str(e)


def process_row(row, first_request_flag):
    try:
        payload, sig16, original_project = build_payload(row)
    except Exception as exc:
        sys.stderr.write(f"ERRO montando payload: {exc}\n")
        return False

    for attempt in range(1, 4):
        success, status, body_text = do_http_request(
            payload, sig16, attempt, first_request_flag
        )
        if success:
            return True

        if status == 429:
            retry_after = parse_retry_after(body_text)
            sys.stderr.write(
                f"RATE LIMIT sig={sig16} aguardando {retry_after}s "
                f"(tentativa {attempt}/3)\n"
            )
            time.sleep(retry_after + 1)
            continue

        if is_sensitive_error(status, body_text):
            sys.stderr.write(
                f"BLOQUEADO sig={sig16} projeto={original_project} "
                f"motivo=conteudo sensivel (revisar manualmente)\n"
            )
            return False

        sys.stderr.write(
            f"ERRO sig={sig16} status={status} body={body_text[:500]}\n"
        )
        return False

    sys.stderr.write(
        f"ERRO sig={sig16} esgotadas 3 tentativas por rate limit\n"
    )
    return False


def main():
    ok = 0
    failed = 0
    total = 0
    synced_ids = []
    first_request_flag = [True]

    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue

        total += 1
        try:
            row = json.loads(line)
        except json.JSONDecodeError as exc:
            sys.stderr.write(f"JSON invalido: {exc}\n")
            failed += 1
            continue

        row_id = row.get("id")
        success = process_row(row, first_request_flag)
        if success:
            ok += 1
            synced_ids.append(row_id)
        else:
            failed += 1

    result = {
        "ok": ok,
        "failed": failed,
        "total": total,
        "synced_ids": synced_ids,
    }
    sys.stdout.write(json.dumps(result, ensure_ascii=False) + "\n")
    sys.stdout.flush()

    if total == 0 or ok > 0:
        sys.exit(0)
    sys.exit(1)


if __name__ == "__main__":
    main()