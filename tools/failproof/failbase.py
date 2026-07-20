#!/usr/bin/env python3
"""failproof failbase — base local de erros→correções. Stdlib only, falha-aberto."""
import argparse
import hashlib
import json
import os
import re
import sqlite3
import sys

SCHEMA_VERSION = 2


def failbase_home():
    return os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")


def default_db_path():
    return os.path.join(failbase_home(), "failbase.db")


def safe_session_key(session_id):
    """Nome de arquivo estável sem permitir traversal via session_id."""
    return hashlib.sha256(str(session_id or "unknown").encode()).hexdigest()[:24]


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
CREATE TABLE IF NOT EXISTS failure_observations (
  id            INTEGER PRIMARY KEY,
  failure_id    INTEGER NOT NULL REFERENCES failures(id) ON DELETE CASCADE,
  source        TEXT NOT NULL,
  project       TEXT DEFAULT '',
  fix_validated INTEGER DEFAULT 0,
  observed_fix  TEXT DEFAULT '',
  observed_at   TEXT DEFAULT (datetime('now'))
);
"""


_SECRET_PREFIXED = re.compile(
    r"(?P<prefix>cfat_|ptr_|ghp_|gho_|ghs_|github_pat_)[A-Za-z0-9_-]{20,}"
)

_SECRET_SK = re.compile(r"(?P<prefix>sk-ant-|sk-)[A-Za-z0-9_-]{20,}")

_SECRET_SLACK = re.compile(r"(?P<prefix>xox[abprs]-)[A-Za-z0-9-]{10,}")

_SECRET_AKIA = re.compile(r"(?P<prefix>AKIA)[A-Z0-9]{16}")

# Redige NOME=VALOR preservando o nome, evitando placeholders e variáveis shell.
_SECRET_NOME_VALOR = re.compile(
    r"(?i)(?P<nome>\w*(?:TOKEN|SECRET|PASSWORD|SENHA|APIKEY|API_KEY|ACCESS_KEY|PRIVATE_KEY|PASSWD|CREDENTIAL)\w*)\s*=\s*"
    r"(?P<val>\"[^\"$]+\"|'[^'$]+'|(?!(?:xxx|\*\*\*|\[REDACTED\]|<[^>]+>)(?:\s|$))[^\s$]+)"
)

# Redige tokens em headers de autorização, preservando a palavra-chave.
# Só redige se o valor PARECER token (20+ chars). Sem isso, "token expirado" em
# prosa viraria "token [REDACTED]" e destruiria o diagnóstico.
_SECRET_BEARER_TOKEN = re.compile(
    r"(?i)(?P<prefix>(?:Bearer|token)\s+)(?P<val>(?!\$)[A-Za-z0-9_\-\.=]{20,})"
)

_SECRET_PEM = re.compile(
    r"-----BEGIN .*? PRIVATE KEY-----.*?-----END .*? PRIVATE KEY-----",
    re.DOTALL
)

# Chave Fernet isolada (base64 de 44 chars terminando em =) com word boundary.
_SECRET_FERNET = re.compile(r"(?<!\w)[A-Za-z0-9+/]{43}=(?!\w)")

_SECRET_REGEXES = [
    (_SECRET_PREFIXED, r"\g<prefix>[REDACTED]"),
    (_SECRET_SK, r"\g<prefix>[REDACTED]"),
    (_SECRET_SLACK, r"\g<prefix>[REDACTED]"),
    (_SECRET_AKIA, r"\g<prefix>[REDACTED]"),
    (_SECRET_NOME_VALOR, r"\g<nome>=[REDACTED]"),
    (_SECRET_BEARER_TOKEN, r"\g<prefix>[REDACTED]"),
    (_SECRET_PEM, "[REDACTED]"),
    (_SECRET_FERNET, "[REDACTED]"),
]

def redact_secrets(text):
    """Redige segredos no texto porque os hooks gravam comando cru."""
    if not text:
        return text
    try:
        for regex, replacement in _SECRET_REGEXES:
            text = regex.sub(replacement, text)
        return text
    except Exception:
        # Base é fail-open: nunca levanta exceção, retorna o que tiver.
        return text


class FailBase:
    def __init__(self, db_path=None):
        self.db_path = db_path or default_db_path()
        os.makedirs(os.path.dirname(self.db_path) or ".", mode=0o700, exist_ok=True)
        self.db = sqlite3.connect(self.db_path, timeout=2)
        # WAL: leitor não bloqueia escritor (várias sessões/agentes na mesma base).
        # busy_timeout: espera o lock em vez de estourar "database is locked".
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.execute("PRAGMA busy_timeout=3000")
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.row_factory = sqlite3.Row
        self.db.executescript(SCHEMA)
        self._migrate()

    def _migrate(self):
        """Migra bases V1 em lugar, sem apagar conhecimento existente."""
        cols = {r[1] for r in self.db.execute("PRAGMA table_info(failures)")}
        additions = {
            "validated_source": "TEXT DEFAULT ''",
            "validated_at": "TEXT",
            "command_family": "TEXT DEFAULT ''",
        }
        for name, definition in additions.items():
            if name not in cols:
                self.db.execute("ALTER TABLE failures ADD COLUMN {} {}".format(name, definition))

        # Bases antigas não tinham unicidade. Consolida duplicatas exatas antes
        # de criar o índice que torna add() seguro sob concorrência.
        duplicates = self.db.execute(
            "SELECT signature, project FROM failures GROUP BY signature, project HAVING COUNT(*)>1"
        ).fetchall()
        for signature, project in duplicates:
            rows = self.db.execute(
                "SELECT * FROM failures WHERE signature=? AND project=? "
                "ORDER BY fix_validated DESC, last_seen_at DESC, id ASC",
                (signature, project),
            ).fetchall()
            keeper = rows[0]
            total_hits = sum(int(r["hits"] or 0) for r in rows)
            self.db.execute("UPDATE failures SET hits=? WHERE id=?", (total_hits, keeper["id"]))
            for duplicate in rows[1:]:
                self.db.execute("DELETE FROM failures_fts WHERE failure_id=?", (duplicate["id"],))
                self.db.execute("DELETE FROM failures WHERE id=?", (duplicate["id"],))

        self.db.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_failures_signature_project "
            "ON failures(signature, project)"
        )
        self.db.execute("PRAGMA user_version={}".format(SCHEMA_VERSION))
        self.db.commit()

    def add(self, symptom, fix="", root_cause="", source="session", project="",
            error_class="", fix_validated=False, signature=None, command=""):
        sig = signature or normalize_signature(symptom, command)
        # Redige antes de gravar: os hooks capturam comando cru, que costuma trazer
        # token/senha inline. A assinatura é calculada acima, sobre o texto original,
        # para não mudar o agrupamento de falhas já existentes.
        symptom = redact_secrets(symptom)
        fix = redact_secrets(fix)
        root_cause = redact_secrets(root_cause)
        symptom = (symptom or "")[:2048]
        project = project or ""
        family = (command.strip().split() or [""])[0]
        validated = int(bool(fix_validated))
        self.db.execute(
            "INSERT INTO failures (signature, error_class, symptom, root_cause, fix,"
            " fix_validated, source, project, validated_source, validated_at, command_family) "
            "VALUES (?,?,?,?,?,?,?,?,?,CASE WHEN ?=1 THEN datetime('now') END,?) "
            "ON CONFLICT(signature, project) DO UPDATE SET "
            "hits=failures.hits+1, last_seen_at=datetime('now'), synced=0, "
            "error_class=CASE WHEN excluded.error_class!='' THEN excluded.error_class ELSE failures.error_class END, "
            "fix=CASE "
            "  WHEN excluded.fix_validated=1 AND excluded.fix!='' THEN excluded.fix "
            "  WHEN failures.fix_validated=0 AND excluded.fix!='' THEN excluded.fix "
            "  ELSE failures.fix END, "
            "root_cause=CASE "
            "  WHEN excluded.fix_validated=1 AND excluded.root_cause!='' THEN excluded.root_cause "
            "  WHEN failures.fix_validated=0 AND excluded.root_cause!='' THEN excluded.root_cause "
            "  ELSE failures.root_cause END, "
            "fix_validated=MAX(failures.fix_validated, excluded.fix_validated), "
            "validated_source=CASE WHEN excluded.fix_validated=1 THEN excluded.source ELSE failures.validated_source END, "
            "validated_at=CASE WHEN excluded.fix_validated=1 THEN datetime('now') ELSE failures.validated_at END, "
            "command_family=CASE WHEN excluded.command_family!='' THEN excluded.command_family ELSE failures.command_family END",
            (sig, error_class, symptom, root_cause, fix, validated, source, project,
             source if validated else "", validated, family),
        )
        row = self.lookup_exact(sig, project)
        fid = row["id"]
        self.db.execute("DELETE FROM failures_fts WHERE failure_id=?", (fid,))
        self.db.execute(
            "INSERT INTO failures_fts (symptom, root_cause, fix, failure_id) VALUES (?,?,?,?)",
            (row["symptom"], row["root_cause"], row["fix"], fid))
        self.db.execute(
            "INSERT INTO failure_observations "
            "(failure_id, source, project, fix_validated, observed_fix) VALUES (?,?,?,?,?)",
            (fid, source, project, validated, fix),
        )
        self.db.commit()
        return fid

    def lookup_exact(self, signature, project=""):
        r = self.db.execute(
            "SELECT * FROM failures WHERE signature=? AND project=?",
            (signature, project or ""),
        ).fetchone()
        return dict(r) if r else None

    def lookup(self, signature, project=None):
        if project is not None:
            r = self.db.execute(
                "SELECT * FROM failures WHERE signature=? AND project IN (?, '') "
                "ORDER BY CASE WHEN project=? THEN 0 ELSE 1 END, fix_validated DESC LIMIT 1",
                (signature, project or "", project or ""),
            ).fetchone()
        else:
            r = self.db.execute(
                "SELECT * FROM failures WHERE signature=? ORDER BY fix_validated DESC, last_seen_at DESC LIMIT 1",
                (signature,),
            ).fetchone()
        return dict(r) if r else None

    def search(self, query, limit=5):
        safe = re.sub(r"[^\w\s]", " ", query).strip()
        if not safe:
            return []
        # relevância FTS primeiro; entre empates, fix validado ganha do observado.
        rows = self.db.execute(
            "SELECT f.* FROM failures_fts t JOIN failures f ON f.id = t.failure_id"
            " WHERE failures_fts MATCH ? ORDER BY rank, f.fix_validated DESC LIMIT ?",
            (safe, limit)).fetchall()
        return [dict(r) for r in rows]

    def top_for_project(self, project, limit=10):
        # score = calor (hits/recência) com bônus por confiança do fix validado.
        rows = self.db.execute(
            "SELECT *, (hits + fix_validated * 3.0)"
            " / (1.0 + julianday('now') - julianday(last_seen_at)) AS score"
            " FROM failures WHERE project IN (?, '')"
            " ORDER BY score DESC, last_seen_at DESC LIMIT ?", (project, limit)).fetchall()
        return [dict(r) for r in rows]

    def stats(self):
        total = self.db.execute("SELECT COUNT(*) FROM failures").fetchone()[0]
        validated = self.db.execute(
            "SELECT COUNT(*) FROM failures WHERE fix_validated=1").fetchone()[0]
        by_source = dict(self.db.execute(
            "SELECT source, COUNT(*) FROM failures GROUP BY source").fetchall())
        return {"schema_version": SCHEMA_VERSION, "total": total,
                "validated": validated, "by_source": by_source}

    def doctor(self):
        integrity = self.db.execute("PRAGMA integrity_check").fetchone()[0]
        duplicates = self.db.execute(
            "SELECT COUNT(*) FROM (SELECT signature, project FROM failures "
            "GROUP BY signature, project HAVING COUNT(*)>1)"
        ).fetchone()[0]
        secret_rows = 0
        for row in self.db.execute("SELECT symptom, root_cause, fix FROM failures"):
            if any(redact_secrets(value or "") != (value or "") for value in row):
                secret_rows += 1
        result = self.stats()
        result.update({"integrity": integrity, "duplicates": duplicates,
                       "secret_pattern_rows": secret_rows})
        return result

    def sanitize(self):
        """Redige segredos legados em transação e reconstrói o índice FTS."""
        changed_failures = 0
        changed_observations = 0
        self.db.execute("BEGIN IMMEDIATE")
        try:
            rows = self.db.execute(
                "SELECT id, symptom, root_cause, fix FROM failures").fetchall()
            for row in rows:
                cleaned = tuple(redact_secrets(row[name] or "")
                                for name in ("symptom", "root_cause", "fix"))
                original = tuple(row[name] or ""
                                 for name in ("symptom", "root_cause", "fix"))
                if cleaned != original:
                    self.db.execute(
                        "UPDATE failures SET symptom=?, root_cause=?, fix=?, synced=0 WHERE id=?",
                        cleaned + (row["id"],),
                    )
                    changed_failures += 1

            observations = self.db.execute(
                "SELECT id, observed_fix FROM failure_observations").fetchall()
            for row in observations:
                cleaned = redact_secrets(row["observed_fix"] or "")
                if cleaned != (row["observed_fix"] or ""):
                    self.db.execute(
                        "UPDATE failure_observations SET observed_fix=? WHERE id=?",
                        (cleaned, row["id"]),
                    )
                    changed_observations += 1

            self.db.execute("DELETE FROM failures_fts")
            self.db.execute(
                "INSERT INTO failures_fts (symptom, root_cause, fix, failure_id) "
                "SELECT symptom, root_cause, fix, id FROM failures"
            )
            self.db.commit()
        except Exception:
            self.db.rollback()
            raise
        return {"failures_redacted": changed_failures,
                "observations_redacted": changed_observations}


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
    pa.add_argument("--signature", default="")
    pa.add_argument("--validated", action="store_true")

    ps = sub.add_parser("search")
    ps.add_argument("query")
    ps.add_argument("--limit", type=int, default=5)

    sub.add_parser("stats")
    sub.add_parser("doctor")
    sub.add_parser("sanitize")
    sub.add_parser("export")

    args = p.parse_args(argv)
    fb = FailBase()
    if args.cmd == "add":
        fid = fb.add(symptom=args.symptom, fix=args.fix, root_cause=args.root_cause,
                     source=args.source, project=args.project, error_class=args.error_class,
                     command=args.command, signature=args.signature or None,
                     fix_validated=args.validated)
        print(json.dumps({"id": fid}))
    elif args.cmd == "search":
        print(json.dumps(fb.search(args.query, args.limit), ensure_ascii=False))
    elif args.cmd == "stats":
        print(json.dumps(fb.stats(), ensure_ascii=False))
    elif args.cmd == "doctor":
        print(json.dumps(fb.doctor(), ensure_ascii=False))
    elif args.cmd == "sanitize":
        print(json.dumps(fb.sanitize(), ensure_ascii=False))
    elif args.cmd == "export":
        for row in fb.db.execute("SELECT * FROM failures ORDER BY id"):
            print(json.dumps(dict(row), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
