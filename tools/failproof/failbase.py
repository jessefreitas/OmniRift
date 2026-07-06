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
