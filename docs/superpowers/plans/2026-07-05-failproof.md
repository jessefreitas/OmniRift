# failproof Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sistema de busca de erros e correções que torna sessões Claude Code (Opus) à prova de falhas: failbase SQLite local (erro→fix), hooks de disciplina e watchdog progressivo — 100% standalone, sem dependência de OmniMemory.

**Architecture:** 3 camadas independentes que falham isoladas. Camada 1: biblioteca+CLI `failbase.py` (SQLite + FTS5, stdlib only). Camada 2: 4 hooks Claude Code que leem/escrevem a failbase e falham-aberto sempre. Camada 3: `watchdog.py` externo que vigia sessões unattended registradas e escala strike 1→2→3. Plugins (notify, sync-omnimemory) detectados em runtime — ausência nunca quebra nada.

**Tech Stack:** Python 3.10+ stdlib only (sqlite3, fts5, argparse, urllib), bash (install), pytest (dev-only, testes).

**Spec:** `docs/superpowers/specs/2026-07-05-failproof-design.md`

---

## Estrutura de arquivos

```
tools/failproof/
  failbase.py                              # Camada 1: lib + CLI (única fonte de acesso ao DB)
  hooks/
    posttool_failure_capture.py            # PostToolUse (Bash): par falha→fix + fix conhecido
    userprompt_correction_detector.py      # UserPromptSubmit: correção humana
    stop_evidence_gate.py                  # Stop: bloqueia "corrigido" sem execução verde
    sessionstart_known_failures.py         # SessionStart: injeta erros conhecidos do projeto
  watchdog.py                              # Camada 3: vigia + escala progressiva
  failbase_ci.py                           # captura CI red→green
  plugins/
    notify.py                              # ntfy/Telegram, fallback arquivo
    sync_omnimemory.py                     # espelha failbase → cluster (opcional)
  install.sh / uninstall.sh                # instalação portátil com merge de settings.json
  tests/
    conftest.py
    test_failbase.py
    test_cli.py
    test_hook_posttool.py
    test_hook_correction.py
    test_hook_stop_gate.py
    test_hook_sessionstart.py
    test_watchdog.py
    test_ci.py
    test_plugins.py
    test_failopen.py
    test_install.py
  README.md
```

**Convenções fixas (valem para TODAS as tasks):**
- `FAILBASE_HOME` (env) aponta o diretório de dados; default `~/.claude/failbase`. Testes SEMPRE setam `FAILBASE_HOME` para tmp_path via monkeypatch.
- Hooks importam `failbase` assim (bootstrap padrão, repetido no topo de cada hook):
  ```python
  import os, sys
  _HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
  _REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
  for _p in (_HOME, _REPO):
      if _p not in sys.path:
          sys.path.insert(0, _p)
  import failbase
  ```
- TODO hook tem `main()` embrulhado em try/except → `sys.exit(0)` (falha-aberto). Nunca exit ≠ 0 por erro interno.
- Rodar testes: `cd tools/failproof && python3 -m pytest tests/ -v`

---

### Task 1: Núcleo FailBase — schema, signature, add/lookup

**Files:**
- Create: `tools/failproof/failbase.py`
- Create: `tools/failproof/tests/conftest.py`
- Create: `tools/failproof/tests/test_failbase.py`

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/conftest.py`:
```python
import os, sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def fb(tmp_path, monkeypatch):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import failbase
    return failbase.FailBase(db_path=str(tmp_path / "fb.db"))
```

`tools/failproof/tests/test_failbase.py`:
```python
import failbase


def test_normalize_signature_ignora_paths_numeros_e_hashes():
    a = failbase.normalize_signature(
        "FileNotFoundError: /home/user/proj/app.py line 42 (run 8f3a9b2c1d)", "python3 app.py")
    b = failbase.normalize_signature(
        "FileNotFoundError: /tmp/other/app.py line 99 (run aa11bb22cc)", "python3 app.py")
    assert a == b
    assert len(a) == 16


def test_normalize_signature_muda_com_comando_diferente():
    a = failbase.normalize_signature("connection refused", "curl http://x")
    b = failbase.normalize_signature("connection refused", "psql -h x")
    assert a != b


def test_add_e_lookup(fb):
    fid = fb.add(symptom="pytest: 1 failed", fix="corrigiu import", command="pytest",
                 source="session", project="omnirift", fix_validated=True)
    sig = failbase.normalize_signature("pytest: 1 failed", "pytest")
    row = fb.lookup(sig)
    assert row["id"] == fid
    assert row["fix"] == "corrigiu import"
    assert row["fix_validated"] == 1
    assert row["hits"] == 1


def test_add_duplicado_incrementa_hits_e_preserva_fix(fb):
    fb.add(symptom="erro X", fix="fix bom", command="make", fix_validated=True)
    fb.add(symptom="erro X", command="make")  # sem fix — não pode apagar o existente
    sig = failbase.normalize_signature("erro X", "make")
    row = fb.lookup(sig)
    assert row["hits"] == 2
    assert row["fix"] == "fix bom"
    assert row["fix_validated"] == 1


def test_symptom_truncado_em_2kb(fb):
    fb.add(symptom="x" * 10000, command="cmd")
    sig = failbase.normalize_signature("x" * 10000, "cmd")
    assert len(fb.lookup(sig)["symptom"]) <= 2048


def test_lookup_inexistente_retorna_none(fb):
    assert fb.lookup("deadbeef00000000") is None
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_failbase.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'failbase'`

- [ ] **Step 3: Implementar o núcleo**

`tools/failproof/failbase.py`:
```python
#!/usr/bin/env python3
"""failproof failbase — base local de erros→correções. Stdlib only, falha-aberto."""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys


def failbase_home():
    return os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")


def default_db_path():
    return os.path.join(failbase_home(), "failbase.db")


_PATH_RE = re.compile(r"(/[\w.\-~+]+)+")
_HEX_RE = re.compile(r"\b[0-9a-f]{8,}\b", re.IGNORECASE)
_NUM_RE = re.compile(r"\b\d+\b")
_WS_RE = re.compile(r"\s+")


def normalize_signature(error_text, command=""):
    """Assinatura estável: mesmo erro com paths/números/hashes diferentes → mesmo hash."""
    head = (command.strip().split() or [""])[0]
    text = (error_text or "")[:1000].lower()
    text = _PATH_RE.sub("<path>", text)
    text = _HEX_RE.sub("<hex>", text)
    text = _NUM_RE.sub("<n>", text)
    text = _WS_RE.sub(" ", text).strip()[:400]
    return hashlib.sha1("{}|{}".format(head, text).encode()).hexdigest()[:16]


SCHEMA = """
CREATE TABLE IF NOT EXISTS failures (
  id            INTEGER PRIMARY KEY,
  signature     TEXT NOT NULL,
  error_class   TEXT DEFAULT '',
  symptom       TEXT NOT NULL,
  root_cause    TEXT DEFAULT '',
  fix           TEXT DEFAULT '',
  fix_validated INTEGER DEFAULT 0,
  source        TEXT DEFAULT 'session',
  project       TEXT DEFAULT '',
  hits          INTEGER DEFAULT 1,
  synced        INTEGER DEFAULT 0,
  created_at    TEXT DEFAULT (datetime('now')),
  last_seen_at  TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_failures_signature ON failures(signature);
CREATE VIRTUAL TABLE IF NOT EXISTS failures_fts
  USING fts5(symptom, root_cause, fix, failure_id UNINDEXED);
"""


class FailBase:
    def __init__(self, db_path=None):
        self.db_path = db_path or default_db_path()
        os.makedirs(os.path.dirname(self.db_path) or ".", exist_ok=True)
        self.db = sqlite3.connect(self.db_path, timeout=2)
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)

    def add(self, symptom, fix="", root_cause="", source="session", project="",
            error_class="", fix_validated=False, signature=None, command=""):
        sig = signature or normalize_signature(symptom, command)
        symptom = (symptom or "")[:2048]
        row = self.lookup(sig)
        if row:
            self.db.execute(
                "UPDATE failures SET hits=hits+1, last_seen_at=datetime('now'), synced=0,"
                " fix=CASE WHEN ?!='' THEN ? ELSE fix END,"
                " root_cause=CASE WHEN ?!='' THEN ? ELSE root_cause END,"
                " fix_validated=MAX(fix_validated, ?) WHERE id=?",
                (fix, fix, root_cause, root_cause, int(fix_validated), row["id"]))
            self.db.execute("DELETE FROM failures_fts WHERE failure_id=?", (row["id"],))
            fresh = self.lookup(sig)
            self.db.execute(
                "INSERT INTO failures_fts (symptom, root_cause, fix, failure_id) VALUES (?,?,?,?)",
                (fresh["symptom"], fresh["root_cause"], fresh["fix"], row["id"]))
            self.db.commit()
            return row["id"]
        cur = self.db.execute(
            "INSERT INTO failures (signature, error_class, symptom, root_cause, fix,"
            " fix_validated, source, project) VALUES (?,?,?,?,?,?,?,?)",
            (sig, error_class, symptom, root_cause, fix, int(fix_validated), source, project))
        self.db.execute(
            "INSERT INTO failures_fts (symptom, root_cause, fix, failure_id) VALUES (?,?,?,?)",
            (symptom, root_cause, fix, cur.lastrowid))
        self.db.commit()
        return cur.lastrowid

    def lookup(self, signature):
        r = self.db.execute("SELECT * FROM failures WHERE signature=?", (signature,)).fetchone()
        return dict(r) if r else None
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_failbase.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/failbase.py tools/failproof/tests/
git commit -m "feat(failproof): núcleo failbase — schema, signature normalizada, add/lookup"
```

---

### Task 2: Busca FTS, ranking por projeto e stats

**Files:**
- Modify: `tools/failproof/failbase.py` (adicionar métodos à classe `FailBase`)
- Modify: `tools/failproof/tests/test_failbase.py` (acrescentar testes)

- [ ] **Step 1: Escrever testes que falham** (acrescentar em `test_failbase.py`)

```python
def test_search_fts_encontra_por_texto(fb):
    fb.add(symptom="psycopg2 connection refused host pg", fix="usar service name via core-net",
           command="python3 x.py")
    hits = fb.search("connection refused")
    assert len(hits) == 1
    assert "core-net" in hits[0]["fix"]


def test_search_sanitiza_query_com_pontuacao(fb):
    fb.add(symptom="erro: foo() quebrou", command="pytest")
    assert fb.search('foo() "quebrou:!') != []  # não pode explodir sintaxe FTS5


def test_top_for_project_prioriza_hits_e_inclui_globais(fb):
    fb.add(symptom="erro raro", command="a", project="omnirift")
    for _ in range(5):
        fb.add(symptom="erro frequente", command="b", project="omnirift")
    fb.add(symptom="erro global", command="c", project="")
    top = fb.top_for_project("omnirift", limit=10)
    assert top[0]["symptom"] == "erro frequente"
    assert any(r["symptom"] == "erro global" for r in top)
    assert all(r["project"] in ("omnirift", "") for r in top)


def test_stats(fb):
    fb.add(symptom="a", command="x", fix="f", fix_validated=True)
    fb.add(symptom="b", command="y", source="ci")
    s = fb.stats()
    assert s["total"] == 2
    assert s["validated"] == 1
    assert s["by_source"] == {"session": 1, "ci": 1}
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_failbase.py -v`
Expected: 4 novos FAIL — `AttributeError: 'FailBase' object has no attribute 'search'`

- [ ] **Step 3: Implementar** (métodos na classe `FailBase`)

```python
    def search(self, query, limit=5):
        safe = re.sub(r"[^\w\s]", " ", query).strip()
        if not safe:
            return []
        rows = self.db.execute(
            "SELECT f.* FROM failures_fts t JOIN failures f ON f.id = t.failure_id"
            " WHERE failures_fts MATCH ? ORDER BY rank LIMIT ?", (safe, limit)).fetchall()
        return [dict(r) for r in rows]

    def top_for_project(self, project, limit=10):
        rows = self.db.execute(
            "SELECT *, hits / (1.0 + julianday('now') - julianday(last_seen_at)) AS score"
            " FROM failures WHERE project IN (?, '')"
            " ORDER BY score DESC, last_seen_at DESC LIMIT ?", (project, limit)).fetchall()
        return [dict(r) for r in rows]

    def stats(self):
        total = self.db.execute("SELECT COUNT(*) FROM failures").fetchone()[0]
        validated = self.db.execute(
            "SELECT COUNT(*) FROM failures WHERE fix_validated=1").fetchone()[0]
        by_source = dict(self.db.execute(
            "SELECT source, COUNT(*) FROM failures GROUP BY source").fetchall())
        return {"total": total, "validated": validated, "by_source": by_source}
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_failbase.py -v`
Expected: 10 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/failbase.py tools/failproof/tests/test_failbase.py
git commit -m "feat(failproof): busca FTS5, ranking hits×recência por projeto, stats"
```

---

### Task 3: CLI da failbase

**Files:**
- Modify: `tools/failproof/failbase.py` (adicionar `main()`)
- Create: `tools/failproof/tests/test_cli.py`

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_cli.py`:
```python
import json
import failbase


def test_cli_add_e_search(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    rc = failbase.main(["add", "--symptom", "docker: network core-net not found",
                        "--fix", "docker network create --driver overlay core-net",
                        "--source", "human-feedback", "--project", "omnirift"])
    assert rc == 0
    rc = failbase.main(["search", "network not found"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out[0]["source"] == "human-feedback"


def test_cli_stats(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    failbase.main(["add", "--symptom", "x"])
    failbase.main(["stats"])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["total"] == 1


def test_cli_export(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    failbase.main(["add", "--symptom", "y", "--fix", "z"])
    failbase.main(["export"])
    lines = [l for l in capsys.readouterr().out.strip().splitlines() if l]
    assert json.loads(lines[-1])["symptom"] == "y"
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_cli.py -v`
Expected: FAIL — `AttributeError: module 'failbase' has no attribute 'main'`

- [ ] **Step 3: Implementar** (final de `failbase.py`)

```python
def main(argv=None):
    p = argparse.ArgumentParser(prog="failbase", description="failproof — base erro→correção")
    sub = p.add_subparsers(dest="cmd", required=True)

    pa = sub.add_parser("add")
    pa.add_argument("--symptom", required=True)
    pa.add_argument("--fix", default="")
    pa.add_argument("--root-cause", default="")
    pa.add_argument("--source", default="session",
                    choices=["session", "human-feedback", "ci", "watchdog"])
    pa.add_argument("--project", default="")
    pa.add_argument("--error-class", default="")
    pa.add_argument("--command", default="")
    pa.add_argument("--validated", action="store_true")

    ps = sub.add_parser("search")
    ps.add_argument("query")
    ps.add_argument("--limit", type=int, default=5)

    sub.add_parser("stats")
    sub.add_parser("export")

    args = p.parse_args(argv)
    fb = FailBase()
    if args.cmd == "add":
        fid = fb.add(symptom=args.symptom, fix=args.fix, root_cause=args.root_cause,
                     source=args.source, project=args.project, error_class=args.error_class,
                     command=args.command, fix_validated=args.validated)
        print(json.dumps({"id": fid}))
    elif args.cmd == "search":
        print(json.dumps(fb.search(args.query, args.limit), ensure_ascii=False))
    elif args.cmd == "stats":
        print(json.dumps(fb.stats(), ensure_ascii=False))
    elif args.cmd == "export":
        for row in fb.db.execute("SELECT * FROM failures ORDER BY id"):
            print(json.dumps(dict(row), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/ -v`
Expected: 13 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/failbase.py tools/failproof/tests/test_cli.py
git commit -m "feat(failproof): CLI failbase — add/search/stats/export"
```

---

### Task 4: Hook PostToolUse — captura par falha→fix e devolve fix conhecido

**Files:**
- Create: `tools/failproof/hooks/posttool_failure_capture.py`
- Create: `tools/failproof/tests/test_hook_posttool.py`

Contrato do hook (Claude Code): recebe JSON no stdin com `session_id`, `tool_name`, `tool_input` (`{"command": ...}`), `tool_response`, `cwd`. Para injetar contexto, imprime JSON `{"hookSpecificOutput": {"hookEventName": "PostToolUse", "additionalContext": "..."}}` e sai 0.

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_hook_posttool.py`:
```python
import importlib
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import posttool_failure_capture as m
    importlib.reload(m)
    return m


def _payload(cmd, output, exit_code, session="s1"):
    return {"session_id": session, "tool_name": "Bash", "cwd": "/tmp/proj",
            "tool_input": {"command": cmd},
            "tool_response": {"stdout": output, "exit_code": exit_code}}


def test_detect_failure(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.detect_failure({"stdout": "boom", "exit_code": 1}) is True
    assert m.detect_failure({"stdout": "ok", "exit_code": 0}) is False
    assert m.detect_failure({"stdout": "Traceback (most recent call last):\n..."}) is True
    assert m.detect_failure({"stdout": "all good"}) is False


def test_par_falha_fix_e_gravado_validado(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    m.process(_payload("pytest tests/", "1 failed: ImportError foo", 1))
    m.process(_payload("pytest tests/", "5 passed", 0))
    fb = failbase.FailBase()
    row = fb.search("ImportError")[0]
    assert row["fix_validated"] == 1
    assert "pytest tests/" in row["fix"]
    assert row["project"] == "proj"


def test_falha_conhecida_devolve_fix_no_contexto(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    fb.add(symptom="1 failed: ImportError foo", fix="pip install foo", command="pytest",
           fix_validated=True)
    ctx = m.process(_payload("pytest tests/", "1 failed: ImportError foo", 1))
    assert ctx is not None and "pip install foo" in ctx


def test_falha_sem_fix_conhecido_nao_injeta(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.process(_payload("make", "erro inédito xyz", 1)) is None


def test_sucesso_sem_falha_pendente_e_noop(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.process(_payload("ls", "arquivos", 0)) is None
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_posttool.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'posttool_failure_capture'`

- [ ] **Step 3: Implementar**

`tools/failproof/hooks/posttool_failure_capture.py`:
```python
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


def detect_failure(tool_response):
    if isinstance(tool_response, dict):
        code = tool_response.get("exit_code")
        if isinstance(code, int):
            return code != 0
        text = json.dumps(tool_response, ensure_ascii=False)
    else:
        text = str(tool_response)
    return bool(_ERROR_MARKERS.search(text))


def _buffer_path(session_id):
    d = os.path.join(failbase.failbase_home(), "session_buffer")
    os.makedirs(d, exist_ok=True)
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
    failed = detect_failure(response)
    sig = failbase.normalize_signature(output, command)
    buf_path = _buffer_path(session)
    entries = _read_buffer(buf_path)
    context = None
    fb = failbase.FailBase()

    if failed:
        known = fb.lookup(sig)
        if known and known["fix_validated"] and known["fix"]:
            fb.add(symptom=output, signature=sig, command=command, project=project)
            context = ("💡 Failbase: erro conhecido (visto {}x). Fix que funcionou antes:\n{}"
                       .format(known["hits"] + 1, known["fix"]))
    else:
        resolved_any = False
        for e in reversed(entries[-_PAIR_WINDOW:]):
            if e.get("failed") and not e.get("resolved") and _same_family(e["command"], command):
                fb.add(symptom=e["output"], fix=command, command=e["command"],
                       source="session", project=project, fix_validated=True)
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
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_posttool.py -v`
Expected: 5 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/hooks/posttool_failure_capture.py tools/failproof/tests/test_hook_posttool.py
git commit -m "feat(failproof): hook PostToolUse — par falha→fix automático + fix conhecido no tool result"
```

---

### Task 5: Hook UserPromptSubmit — detector de correção humana

**Files:**
- Create: `tools/failproof/hooks/userprompt_correction_detector.py`
- Create: `tools/failproof/tests/test_hook_correction.py`

Contrato: recebe JSON com `prompt`, `session_id`, `cwd`. Stdout em texto puro vira contexto adicional da conversa.

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_hook_correction.py`:
```python
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
import userprompt_correction_detector as m


def test_detecta_correcoes():
    for prompt in ["tá errado isso", "está errado", "não é assim que faz",
                   "regressão de novo", "você quebrou o build", "voltou o erro",
                   "continua quebrado", "de novo isso??", "nao era isso"]:
        assert m.is_correction(prompt), prompt


def test_ignora_prompts_normais():
    for prompt in ["cria o endpoint de auth", "roda os testes",
                   "explica esse erro pra mim", "o que é regressão linear?"]:
        assert not m.is_correction(prompt), prompt


def test_build_instruction_menciona_failbase():
    out = m.build_instruction()
    assert "failbase" in out.lower()
    assert "human-feedback" in out
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_correction.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implementar**

`tools/failproof/hooks/userprompt_correction_detector.py`:
```python
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
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_correction.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/hooks/userprompt_correction_detector.py tools/failproof/tests/test_hook_correction.py
git commit -m "feat(failproof): hook UserPromptSubmit — correção humana vira registro na failbase"
```

---

### Task 6: Hook Stop — gate de evidência

**Files:**
- Create: `tools/failproof/hooks/stop_evidence_gate.py`
- Create: `tools/failproof/tests/test_hook_stop_gate.py`

Contrato: recebe JSON com `session_id`, `transcript_path`, `stop_hook_active`. Para bloquear: imprime `{"decision": "block", "reason": "..."}` e sai 0. `stop_hook_active=true` significa que já bloqueamos neste turno → NUNCA bloquear de novo (anti-loop).

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_hook_stop_gate.py`:
```python
import json
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
import stop_evidence_gate as m

# eventos simplificados: (kind, name, text)
EDIT = {"kind": "tool_use", "name": "Edit", "text": ""}
GREEN = {"kind": "tool_result", "name": "Bash", "text": "5 passed\nexit_code: 0"}
RED = {"kind": "tool_result", "name": "Bash", "text": "1 failed\nexit_code: 1"}


def _claim(text="Pronto, corrigido e funcionando."):
    return {"kind": "text", "name": "", "text": text}


def test_claims_success():
    assert m.claims_success("corrigido!")
    assert m.claims_success("está funcionando agora")
    assert m.claims_success("pronto, resolvido")
    assert not m.claims_success("vou investigar o erro")
    assert not m.claims_success("o teste falhou")


def test_bloqueia_claim_sem_execucao_apos_edit():
    events = [EDIT, _claim()]
    assert m.should_block(events) is True


def test_libera_claim_com_execucao_verde_apos_edit():
    events = [EDIT, GREEN, _claim()]
    assert m.should_block(events) is False


def test_bloqueia_se_execucao_apos_edit_foi_vermelha():
    events = [EDIT, RED, _claim()]
    assert m.should_block(events) is True


def test_libera_sem_claim_de_sucesso():
    events = [EDIT, _claim("ainda estou debugando")]
    assert m.should_block(events) is False


def test_libera_sem_nenhuma_edicao():
    events = [_claim()]
    assert m.should_block(events) is False


def test_parse_transcript(tmp_path):
    t = tmp_path / "t.jsonl"
    lines = [
        {"type": "assistant", "message": {"content": [
            {"type": "tool_use", "name": "Edit", "input": {}}]}},
        {"type": "user", "message": {"content": [
            {"type": "tool_result", "content": "5 passed"}]}},
        {"type": "assistant", "message": {"content": [
            {"type": "text", "text": "corrigido"}]}},
    ]
    t.write_text("\n".join(json.dumps(l) for l in lines))
    events = m.parse_transcript(str(t))
    assert [e["kind"] for e in events] == ["tool_use", "tool_result", "text"]
    assert events[0]["name"] == "Edit"


def test_stop_hook_active_nunca_bloqueia(tmp_path):
    t = tmp_path / "t.jsonl"
    t.write_text(json.dumps({"type": "assistant", "message": {"content": [
        {"type": "tool_use", "name": "Edit", "input": {}}]}}) + "\n" +
        json.dumps({"type": "assistant", "message": {"content": [
            {"type": "text", "text": "corrigido"}]}}))
    out = m.decide({"transcript_path": str(t), "stop_hook_active": True})
    assert out is None
    out = m.decide({"transcript_path": str(t), "stop_hook_active": False})
    assert out["decision"] == "block"
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_stop_gate.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implementar**

`tools/failproof/hooks/stop_evidence_gate.py`:
```python
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
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_stop_gate.py -v`
Expected: 8 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/hooks/stop_evidence_gate.py tools/failproof/tests/test_hook_stop_gate.py
git commit -m "feat(failproof): hook Stop — gate de evidência anti falso-sucesso (1 bloqueio/turno)"
```

---

### Task 7: Hook SessionStart — injeta erros conhecidos do projeto

**Files:**
- Create: `tools/failproof/hooks/sessionstart_known_failures.py`
- Create: `tools/failproof/tests/test_hook_sessionstart.py`

Contrato: recebe JSON com `session_id`, `cwd`. Stdout vira contexto da sessão.

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_hook_sessionstart.py`:
```python
import importlib
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import sessionstart_known_failures as m
    importlib.reload(m)
    return m


def test_base_vazia_retorna_vazio(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.build_context("omnirift") == ""


def test_injeta_top_erros_com_fix(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    fb.add(symptom="docker network not found", fix="criar overlay core-net",
           command="docker", project="omnirift", fix_validated=True)
    fb.add(symptom="erro sem fix", command="x", project="omnirift")
    ctx = m.build_context("omnirift")
    assert "não repita" in ctx.lower()
    assert "core-net" in ctx
    assert len(ctx) <= m.MAX_CHARS


def test_cap_de_tamanho(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    for i in range(30):
        fb.add(symptom="erro {} ".format(i) + "y" * 300, fix="z" * 300,
               command="c{}".format(i), project="p", fix_validated=True)
    assert len(m.build_context("p")) <= m.MAX_CHARS
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_sessionstart.py -v`
Expected: FAIL — `ModuleNotFoundError`

- [ ] **Step 3: Implementar**

`tools/failproof/hooks/sessionstart_known_failures.py`:
```python
#!/usr/bin/env python3
"""SessionStart: injeta os erros mais recorrentes do projeto no contexto."""
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


def build_context(project):
    fb = failbase.FailBase()
    rows = fb.top_for_project(project, limit=TOP_N)
    if not rows:
        return ""
    lines = ["[failproof] Erros já conhecidos neste projeto — não repita:"]
    for r in rows:
        item = "- ({}x) {}".format(r["hits"], r["symptom"][:150].replace("\n", " "))
        if r["fix_validated"] and r["fix"]:
            item += " → FIX: {}".format(r["fix"][:150].replace("\n", " "))
        if len("\n".join(lines + [item])) > MAX_CHARS:
            break
        lines.append(item)
    return "\n".join(lines) if len(lines) > 1 else ""


def main():
    payload = json.load(sys.stdin)
    project = os.path.basename(payload.get("cwd") or os.getcwd())
    ctx = build_context(project)
    if ctx:
        print(ctx)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_hook_sessionstart.py -v`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/hooks/sessionstart_known_failures.py tools/failproof/tests/test_hook_sessionstart.py
git commit -m "feat(failproof): hook SessionStart — top-10 erros do projeto no contexto (cap 2KB)"
```

---

### Task 8: Watchdog — detecção, escala progressiva e postmortem

**Files:**
- Create: `tools/failproof/watchdog.py`
- Create: `tools/failproof/tests/test_watchdog.py`

Modelo: sessões unattended se registram criando `$FAILBASE_HOME/watch/<session_id>.json` com `{"session_id", "transcript_path", "pid", "relaunch_cmd"}` (o launcher do FleetView/cron faz isso; `relaunch_cmd` pode conter `{postmortem}` como placeholder). Estado de strikes em `$FAILBASE_HOME/watchdog_state.json`. Lógica pura separada de efeitos (Executor com `dry_run`).

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_watchdog.py`:
```python
import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import watchdog as m
    importlib.reload(m)
    return m


def _transcript(tmp_path, sigs):
    """Gera transcript com tool_results de Bash cujas signatures são as dadas."""
    t = tmp_path / "tr.jsonl"
    lines = []
    for s in sigs:
        lines.append(json.dumps({"type": "user", "message": {"content": [
            {"type": "tool_result", "content": "error: {}".format(s)}]}}))
    t.write_text("\n".join(lines))
    return str(t)


def test_detect_stale(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.detect_stale(mtime=1000.0, now=1000.0 + 21 * 60, threshold_min=20) is True
    assert m.detect_stale(mtime=1000.0, now=1000.0 + 5 * 60, threshold_min=20) is False


def test_detect_loop_mesma_falha_3x(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.detect_loop_from_transcript(_transcript(tmp_path, ["A", "A", "A"])) is True
    assert m.detect_loop_from_transcript(_transcript(tmp_path, ["A", "B", "A"])) is False
    assert m.detect_loop_from_transcript(_transcript(tmp_path, ["A", "A"])) is False


def test_escala_de_strikes(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    state = {}
    assert m.next_strike(state, "s1") == 1
    assert m.next_strike(state, "s1") == 2
    assert m.next_strike(state, "s1") == 3
    assert m.next_strike(state, "s1") == 3  # teto
    assert m.next_strike(state, "s2") == 1  # sessões independentes


def test_postmortem_resume_erros(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    pm = m.build_postmortem(_transcript(tmp_path, ["timeout ssh", "timeout ssh"]), "s1")
    assert "timeout ssh" in pm
    assert "s1" in pm


def test_executor_dry_run_escala(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    entry = {"session_id": "s1", "transcript_path": _transcript(tmp_path, ["A", "A", "A"]),
             "pid": 999999, "relaunch_cmd": "echo relaunch {postmortem}"}
    ex = m.Executor(dry_run=True)
    m.handle(entry, strike=1, executor=ex)
    m.handle(entry, strike=3, executor=ex)
    kinds = [a[0] for a in ex.actions]
    assert "relaunch" in kinds       # strike 1 relança com contexto
    assert "notify" in kinds         # strike 3 notifica
    assert "failbase_add" in kinds   # strike 3 grava postmortem na base


def test_strike3_grava_na_failbase(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    entry = {"session_id": "s1", "transcript_path": _transcript(tmp_path, ["boom", "boom", "boom"]),
             "pid": 999999, "relaunch_cmd": ""}
    m.handle(entry, strike=3, executor=m.Executor(dry_run=False, notify_fn=lambda msg: None))
    fb = failbase.FailBase()
    assert fb.stats()["by_source"].get("watchdog") == 1
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_watchdog.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'watchdog'`

- [ ] **Step 3: Implementar**

`tools/failproof/watchdog.py`:
```python
#!/usr/bin/env python3
"""failproof watchdog — vigia sessões unattended e escala strike 1→2→3.

Rodar a cada 5 min via systemd user timer ou cron:
    */5 * * * * python3 ~/.claude/failbase/watchdog.py
Sessões se registram criando $FAILBASE_HOME/watch/<session_id>.json.
"""
import json
import os
import signal
import subprocess
import sys
import time

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
if _HOME not in sys.path:
    sys.path.insert(0, _HOME)
_REPO = os.path.dirname(os.path.abspath(__file__))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)
import failbase

STALE_MIN_DEFAULT = 20
LOOP_REPEATS = 3


def detect_stale(mtime, now, threshold_min=STALE_MIN_DEFAULT):
    return (now - mtime) > threshold_min * 60


def _tail_error_sigs(transcript_path, limit=30):
    sigs = []
    try:
        with open(transcript_path) as f:
            lines = f.readlines()[-limit * 3:]
    except OSError:
        return []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        for block in ((entry.get("message") or {}).get("content") or []):
            if isinstance(block, dict) and block.get("type") == "tool_result":
                raw = block.get("content", "")
                text = raw if isinstance(raw, str) else json.dumps(raw)
                if "error" in text.lower() or "failed" in text.lower():
                    sigs.append(failbase.normalize_signature(text))
    return sigs[-limit:]


def detect_loop_from_transcript(transcript_path):
    sigs = _tail_error_sigs(transcript_path)
    return len(sigs) >= LOOP_REPEATS and len(set(sigs[-LOOP_REPEATS:])) == 1


def next_strike(state, session_id):
    cur = state.get(session_id, {}).get("strikes", 0)
    cur = min(cur + 1, 3)
    state[session_id] = {"strikes": cur, "ts": time.time()}
    return cur


def build_postmortem(transcript_path, session_id):
    sigs = _tail_error_sigs(transcript_path)
    fb = failbase.FailBase()
    lines = ["[failproof postmortem] sessão {} travada/em loop.".format(session_id),
             "Últimos erros (signatures): {}".format(", ".join(sigs[-5:]) or "nenhum")]
    try:
        with open(transcript_path) as f:
            tail = f.readlines()[-5:]
        for line in tail:
            entry = json.loads(line)
            for block in ((entry.get("message") or {}).get("content") or []):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    raw = block.get("content", "")
                    lines.append("- " + (raw if isinstance(raw, str)
                                         else json.dumps(raw))[:300])
    except (OSError, ValueError):
        pass
    for s in set(sigs[-5:]):
        known = fb.lookup(s)
        if known and known["fix_validated"] and known["fix"]:
            lines.append("FIX CONHECIDO para {}: {}".format(s, known["fix"][:200]))
    lines.append("Não repita a mesma estratégia — mude a abordagem.")
    return "\n".join(lines)


class Executor:
    def __init__(self, dry_run=False, notify_fn=None):
        self.dry_run = dry_run
        self.actions = []
        if notify_fn is None:
            try:
                sys.path.insert(0, os.path.join(_REPO, "plugins"))
                from notify import notify as notify_fn
            except Exception:
                notify_fn = lambda msg: None
        self.notify_fn = notify_fn

    def kill(self, pid):
        self.actions.append(("kill", pid))
        if not self.dry_run:
            try:
                os.kill(pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass

    def relaunch(self, cmd, postmortem_path):
        self.actions.append(("relaunch", cmd))
        if not self.dry_run and cmd:
            subprocess.Popen(cmd.format(postmortem=postmortem_path), shell=True)

    def notify(self, msg):
        self.actions.append(("notify", msg))
        if not self.dry_run:
            self.notify_fn(msg)

    def failbase_add(self, postmortem, session_id):
        self.actions.append(("failbase_add", session_id))
        if not self.dry_run:
            failbase.FailBase().add(symptom=postmortem, source="watchdog",
                                    project=session_id, command="watchdog")


def handle(entry, strike, executor):
    sid = entry["session_id"]
    pm = build_postmortem(entry["transcript_path"], sid)
    pm_dir = os.path.join(failbase.failbase_home(), "postmortems")
    os.makedirs(pm_dir, exist_ok=True)
    pm_path = os.path.join(pm_dir, "{}.txt".format(sid))
    with open(pm_path, "w") as f:
        f.write(pm)
    if strike in (1, 2):
        executor.kill(entry.get("pid") or 0)
        executor.relaunch(entry.get("relaunch_cmd", ""), pm_path)
    else:
        executor.kill(entry.get("pid") or 0)
        executor.failbase_add(pm, sid)
        executor.notify("[failproof] sessão {} parada após 3 strikes. Postmortem: {}"
                        .format(sid, pm_path))
        watch_file = os.path.join(failbase.failbase_home(), "watch", "{}.json".format(sid))
        if os.path.exists(watch_file):
            os.remove(watch_file)


def _load_state():
    p = os.path.join(failbase.failbase_home(), "watchdog_state.json")
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(state):
    p = os.path.join(failbase.failbase_home(), "watchdog_state.json")
    with open(p, "w") as f:
        json.dump(state, f)


def main():
    watch_dir = os.path.join(failbase.failbase_home(), "watch")
    if not os.path.isdir(watch_dir):
        return 0
    state = _load_state()
    now = time.time()
    executor = Executor()
    for name in os.listdir(watch_dir):
        try:
            with open(os.path.join(watch_dir, name)) as f:
                entry = json.load(f)
            tp = entry["transcript_path"]
            stale = os.path.exists(tp) and detect_stale(os.path.getmtime(tp), now)
            loop = os.path.exists(tp) and detect_loop_from_transcript(tp)
            if stale or loop:
                strike = next_strike(state, entry["session_id"])
                handle(entry, strike, executor)
        except Exception:
            continue  # uma sessão quebrada nunca derruba o watchdog
    _save_state(state)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_watchdog.py -v`
Expected: 6 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/watchdog.py tools/failproof/tests/test_watchdog.py
git commit -m "feat(failproof): watchdog — detecção stale/loop, escala strike 1-3, postmortem na failbase"
```

---

### Task 9: failbase_ci.py + plugins (notify e sync stub)

**Files:**
- Create: `tools/failproof/failbase_ci.py`
- Create: `tools/failproof/plugins/notify.py`
- Create: `tools/failproof/plugins/sync_omnimemory.py`
- Create: `tools/failproof/tests/test_ci.py`
- Create: `tools/failproof/tests/test_plugins.py`

- [ ] **Step 1: Escrever testes que falham**

`tools/failproof/tests/test_ci.py`:
```python
import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import failbase_ci as m
    importlib.reload(m)
    return m


def test_red_registra_e_green_fecha_par(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    log = tmp_path / "job.log"
    log.write_text("FAIL: test_auth — assertion error")
    m.main(["red", "--job", "pytest", "--branch", "feat/x", "--log", str(log)])
    diff = tmp_path / "fix.diff"
    diff.write_text("--- a/auth.py\n+++ b/auth.py\n+    return token")
    m.main(["green", "--job", "pytest", "--branch", "feat/x", "--diff", str(diff)])
    fb = failbase.FailBase()
    row = fb.search("assertion error")[0]
    assert row["fix_validated"] == 1
    assert "return token" in row["fix"]
    assert row["source"] == "ci"


def test_green_sem_red_anterior_e_noop(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    assert m.main(["green", "--job", "pytest", "--branch", "feat/y"]) == 0
    assert failbase.FailBase().stats()["total"] == 0
```

`tools/failproof/tests/test_plugins.py`:
```python
import importlib
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "plugins"))


def test_notify_fallback_grava_arquivo(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    monkeypatch.delenv("FAILPROOF_NTFY_URL", raising=False)
    monkeypatch.delenv("FAILPROOF_TELEGRAM_TOKEN", raising=False)
    import notify as m
    importlib.reload(m)
    channel = m.notify("alerta de teste")
    assert channel == "file"
    alerts = os.listdir(tmp_path / "alerts")
    assert len(alerts) == 1
    assert "alerta de teste" in (tmp_path / "alerts" / alerts[0]).read_text()


def test_sync_omnimemory_indisponivel_e_noop(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    monkeypatch.delenv("FAILPROOF_SYNC_CMD", raising=False)
    import sync_omnimemory as m
    importlib.reload(m)
    assert m.available() is False
    assert m.sync() == 0  # nunca explode sem cluster
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_ci.py tests/test_plugins.py -v`
Expected: FAIL — `ModuleNotFoundError` (failbase_ci, notify, sync_omnimemory)

- [ ] **Step 3: Implementar**

`tools/failproof/failbase_ci.py`:
```python
#!/usr/bin/env python3
"""Captura CI: `red` registra job vermelho; `green` fecha o par com o diff que corrigiu.

Uso em pipeline:
  falhou:  python3 failbase_ci.py red --job pytest --branch $BRANCH --log out.log
  passou:  python3 failbase_ci.py green --job pytest --branch $BRANCH --diff fix.diff
"""
import argparse
import json
import os
import sys

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
_REPO = os.path.dirname(os.path.abspath(__file__))
for _p in (_HOME, _REPO):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import failbase


def _pending_path(job, branch):
    d = os.path.join(failbase.failbase_home(), "ci_pending")
    os.makedirs(d, exist_ok=True)
    safe = "{}__{}".format(job, branch).replace("/", "_")
    return os.path.join(d, safe + ".json")


def main(argv=None):
    p = argparse.ArgumentParser(prog="failbase-ci")
    sub = p.add_subparsers(dest="cmd", required=True)
    for name in ("red", "green"):
        sp = sub.add_parser(name)
        sp.add_argument("--job", required=True)
        sp.add_argument("--branch", required=True)
        sp.add_argument("--log", default="")
        sp.add_argument("--diff", default="")
        sp.add_argument("--project", default="")
    args = p.parse_args(argv)
    pending = _pending_path(args.job, args.branch)

    if args.cmd == "red":
        symptom = ""
        if args.log and os.path.exists(args.log):
            with open(args.log) as f:
                symptom = f.read()[-2048:]
        with open(pending, "w") as f:
            json.dump({"symptom": symptom or "CI red: {}".format(args.job),
                       "job": args.job, "project": args.project}, f)
    else:  # green
        if not os.path.exists(pending):
            return 0
        with open(pending) as f:
            data = json.load(f)
        fix = "CI voltou a passar"
        if args.diff and os.path.exists(args.diff):
            with open(args.diff) as f:
                fix = f.read()[:2048]
        failbase.FailBase().add(symptom=data["symptom"], fix=fix, source="ci",
                                project=data.get("project", ""), command=data["job"],
                                fix_validated=True)
        os.remove(pending)
    return 0


if __name__ == "__main__":
    sys.exit(main())
```

`tools/failproof/plugins/notify.py`:
```python
#!/usr/bin/env python3
"""Notificação do watchdog: ntfy → Telegram → arquivo. Detecção por env, nunca explode."""
import os
import time
import urllib.parse
import urllib.request


def _home():
    return os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")


def notify(msg):
    """Retorna o canal usado: 'ntfy' | 'telegram' | 'file'."""
    ntfy = os.environ.get("FAILPROOF_NTFY_URL")
    if ntfy:
        try:
            urllib.request.urlopen(urllib.request.Request(
                ntfy, data=msg.encode(), method="POST"), timeout=5)
            return "ntfy"
        except Exception:
            pass
    token = os.environ.get("FAILPROOF_TELEGRAM_TOKEN")
    chat = os.environ.get("FAILPROOF_TELEGRAM_CHAT")
    if token and chat:
        try:
            url = "https://api.telegram.org/bot{}/sendMessage?chat_id={}&text={}".format(
                token, chat, urllib.parse.quote(msg))
            urllib.request.urlopen(url, timeout=5)
            return "telegram"
        except Exception:
            pass
    d = os.path.join(_home(), "alerts")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "{}.txt".format(int(time.time() * 1000))), "w") as f:
        f.write(msg)
    return "file"
```

`tools/failproof/plugins/sync_omnimemory.py`:
```python
#!/usr/bin/env python3
"""Sync opcional failbase → OmniMemory. Detecção por env FAILPROOF_SYNC_CMD.

O comando recebe no stdin um JSONL das rows com synced=0 e, se sair 0,
elas são marcadas synced=1. Exemplo de cmd (padrão file-based do CLAUDE.md):
  FAILPROOF_SYNC_CMD='ssh omnimemory-01 "sudo docker run -i --rm --network core-net ... python3 /tmp/ingest.py"'
Sem a env: plugin indisponível, sync() é no-op e retorna 0.
"""
import json
import os
import subprocess
import sys

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
_REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
for _p in (_HOME, _REPO):
    if _p not in sys.path:
        sys.path.insert(0, _p)
import failbase


def available():
    return bool(os.environ.get("FAILPROOF_SYNC_CMD"))


def sync():
    """Retorna quantas rows foram sincronizadas. Nunca levanta exceção."""
    if not available():
        return 0
    try:
        fb = failbase.FailBase()
        rows = [dict(r) for r in fb.db.execute("SELECT * FROM failures WHERE synced=0")]
        if not rows:
            return 0
        payload = "\n".join(json.dumps(r, ensure_ascii=False) for r in rows)
        proc = subprocess.run(os.environ["FAILPROOF_SYNC_CMD"], shell=True,
                              input=payload.encode(), timeout=60, capture_output=True)
        if proc.returncode == 0:
            fb.db.execute("UPDATE failures SET synced=1 WHERE synced=0")
            fb.db.commit()
            return len(rows)
    except Exception:
        pass
    return 0


if __name__ == "__main__":
    print(sync())
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && python3 -m pytest tests/test_ci.py tests/test_plugins.py -v`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/failbase_ci.py tools/failproof/plugins/ tools/failproof/tests/test_ci.py tools/failproof/tests/test_plugins.py
git commit -m "feat(failproof): captura CI red/green + plugins notify e sync-omnimemory (detecção runtime)"
```

---

### Task 10: Invariante falha-aberto (todos os hooks)

**Files:**
- Create: `tools/failproof/tests/test_failopen.py`

- [ ] **Step 1: Escrever o teste**

`tools/failproof/tests/test_failopen.py`:
```python
"""Invariante crítico: hook NUNCA quebra a sessão — input corrompido → exit 0."""
import glob
import os
import subprocess
import sys

import pytest

HOOKS = sorted(glob.glob(os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "*.py")))

BAD_INPUTS = [b"", b"not json {{{", b'{"tool_name": null}', b'[]',
              b'{"transcript_path": "/nao/existe"}']


@pytest.mark.parametrize("hook", HOOKS)
@pytest.mark.parametrize("bad", BAD_INPUTS)
def test_hook_falha_aberto(hook, bad, tmp_path):
    env = dict(os.environ, FAILBASE_HOME=str(tmp_path))
    proc = subprocess.run([sys.executable, hook], input=bad, env=env,
                          capture_output=True, timeout=10)
    assert proc.returncode == 0, "{} saiu com {} para input {!r}".format(
        hook, proc.returncode, bad)


def test_existem_4_hooks():
    assert len(HOOKS) == 4
```

- [ ] **Step 2: Rodar e confirmar verde direto** (os hooks já foram escritos com try/except → exit 0; se algum falhar aqui, é bug — corrigir o hook, não o teste)

Run: `cd tools/failproof && python3 -m pytest tests/test_failopen.py -v`
Expected: 21 passed (4 hooks × 5 inputs + contagem)

- [ ] **Step 3: Rodar a suíte inteira**

Run: `cd tools/failproof && python3 -m pytest tests/ -v`
Expected: todos passed, zero failed

- [ ] **Step 4: Commit**

```bash
git add tools/failproof/tests/test_failopen.py
git commit -m "test(failproof): invariante falha-aberto — hook nunca quebra sessão"
```

---

### Task 11: install.sh / uninstall.sh + teste de fumaça

**Files:**
- Create: `tools/failproof/install.sh`
- Create: `tools/failproof/uninstall.sh`
- Create: `tools/failproof/tests/test_install.py`

- [ ] **Step 1: Escrever teste de fumaça que falha**

`tools/failproof/tests/test_install.py`:
```python
import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run_install(home):
    return subprocess.run(["bash", os.path.join(ROOT, "install.sh")],
                          env=dict(os.environ, HOME=str(home)),
                          capture_output=True, text=True, timeout=60)


def test_install_cria_estrutura_e_registra_hooks(tmp_path):
    proc = _run_install(tmp_path)
    assert proc.returncode == 0, proc.stderr
    claude = tmp_path / ".claude"
    assert (claude / "failbase" / "failbase.py").exists()
    assert (claude / "failbase" / "watchdog.py").exists()
    assert (claude / "hooks" / "failproof_posttool_failure_capture.py").exists()
    settings = json.loads((claude / "settings.json").read_text())
    assert any("failproof_stop_evidence_gate" in json.dumps(h)
               for h in settings["hooks"]["Stop"])
    assert any("failproof_posttool_failure_capture" in json.dumps(h)
               for h in settings["hooks"]["PostToolUse"])


def test_install_preserva_settings_existentes(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "settings.json").write_text(json.dumps(
        {"model": "opus", "hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "meu_hook_existente.py"}]}]}}))
    proc = _run_install(tmp_path)
    assert proc.returncode == 0, proc.stderr
    settings = json.loads((claude / "settings.json").read_text())
    assert settings["model"] == "opus"
    assert any("meu_hook_existente" in json.dumps(h) for h in settings["hooks"]["Stop"])
    assert any("failproof_stop_evidence_gate" in json.dumps(h)
               for h in settings["hooks"]["Stop"])


def test_install_e_idempotente(tmp_path):
    _run_install(tmp_path)
    _run_install(tmp_path)
    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    stops = json.dumps(settings["hooks"]["Stop"])
    assert stops.count("failproof_stop_evidence_gate") == 1


def test_uninstall_remove_tudo_e_preserva_alheio(tmp_path):
    _run_install(tmp_path)
    proc = subprocess.run(["bash", os.path.join(ROOT, "uninstall.sh")],
                          env=dict(os.environ, HOME=str(tmp_path)),
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    claude = tmp_path / ".claude"
    assert not list((claude / "hooks").glob("failproof_*"))
    settings = json.loads((claude / "settings.json").read_text())
    assert "failproof" not in json.dumps(settings)
```

- [ ] **Step 2: Rodar e confirmar falha**

Run: `cd tools/failproof && python3 -m pytest tests/test_install.py -v`
Expected: FAIL — install.sh não existe

- [ ] **Step 3: Implementar**

`tools/failproof/install.sh`:
```bash
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
  systemctl --user daemon-reload && systemctl --user enable --now failproof-watchdog.timer || true
  echo "watchdog: systemd user timer ativo"
else
  echo "watchdog: systemd indisponível — adicione ao cron:"
  echo "  */5 * * * * python3 $FB/watchdog.py"
fi

# plugins: detecção informativa
[ -n "${FAILPROOF_SYNC_CMD:-}" ] && echo "plugin sync-omnimemory: ATIVO" || echo "plugin sync-omnimemory: inativo (sem FAILPROOF_SYNC_CMD)"
[ -n "${FAILPROOF_NTFY_URL:-}${FAILPROOF_TELEGRAM_TOKEN:-}" ] && echo "plugin notify: ATIVO" || echo "plugin notify: fallback arquivo (~/.claude/failbase/alerts/)"

echo "failproof instalado. Base: $FB/failbase.db"
```

`tools/failproof/uninstall.sh`:
```bash
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
```

- [ ] **Step 4: Rodar e confirmar verde**

Run: `cd tools/failproof && chmod +x install.sh uninstall.sh && python3 -m pytest tests/test_install.py -v`
Expected: 4 passed

Nota: no ambiente de teste `systemctl --user status` falha dentro do HOME fake — o install cai no ramo do cron e imprime a instrução; isso é o comportamento esperado (portabilidade).

- [ ] **Step 5: Commit**

```bash
git add tools/failproof/install.sh tools/failproof/uninstall.sh tools/failproof/tests/test_install.py
git commit -m "feat(failproof): installer portátil — merge settings.json idempotente, timer/cron, uninstall limpo"
```

---

### Task 12: README + suíte final + push

**Files:**
- Create: `tools/failproof/README.md`

- [ ] **Step 1: Escrever o README**

`tools/failproof/README.md` — conteúdo: título "failproof"; descrição de 1 parágrafo (3 camadas independentes, stdlib only, OmniMemory opcional); seção Instalação (`cd tools/failproof && ./install.sh`, requisito Python 3.10+); tabela das 3 camadas (Failbase / Hooks / Watchdog, o quê e onde); seção CLI com os 3 comandos (`add --symptom ... --fix ... --source human-feedback`, `search "connection refused"`, `stats`); seção CI com os comandos red/green; seção Watchdog mostrando o JSON de registro em `~/.claude/failbase/watch/<session_id>.json` (campos session_id, transcript_path, pid, relaunch_cmd com placeholder `{postmortem}`); tabela de plugins (notify via `FAILPROOF_NTFY_URL` ou `FAILPROOF_TELEGRAM_TOKEN`+`FAILPROOF_TELEGRAM_CHAT` com fallback arquivo; sync-omnimemory via `FAILPROOF_SYNC_CMD`); seção Testes (`python3 -m pytest tests/ -v`); seção Desinstalar (`./uninstall.sh` preserva o DB).

- [ ] **Step 2: Rodar a suíte completa uma última vez**

Run: `cd tools/failproof && python3 -m pytest tests/ -v`
Expected: todos passed, zero failed

- [ ] **Step 3: Commit e push**

```bash
git add tools/failproof/README.md
git commit -m "docs(failproof): README — instalação, camadas, CLI, CI, watchdog, plugins"
git push origin main
```

---

## Verificação final (pós-implementação)

1. `./install.sh` numa máquina real → hooks registrados, sessão nova mostra contexto `[failproof]` quando houver erros na base.
2. Forçar um erro num Bash da sessão, corrigir → `failbase.py stats` mostra o par capturado com `fix_validated=1`.
3. Repetir o mesmo erro → tool result traz `💡 Failbase: erro conhecido`.
4. Declarar "corrigido" sem rodar nada após editar arquivo → Stop gate bloqueia 1x.
5. Registrar sessão fake em `watch/` com transcript velho → watchdog aplica strike e gera postmortem.
