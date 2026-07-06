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
