#!/usr/bin/env python3
import json
import os
import re
import sys

sys.path.append(os.path.expanduser("~/.claude/failbase"))

import failbase  # noqa: E402


_ENVIRONMENT_RE = re.compile(
    r"index\.lock|"
    r"Another git process|"
    r"Host key verification failed|"
    r"Permanently added|"
    r"Author identity unknown|"
    r"could not lock config file|"
    r"Read-only file system|"
    r"No space left on device",
    re.IGNORECASE,
)

_SUCCESS_RE = re.compile(
    r"test result: ok|"
    r"No syntax errors detected|"
    r"\d+ passed[;,]?\s*0 failed|"
    r"^RC=0|"
    r"0 failed|"
    r"all tests passed|"
    r"build succeeded",
    re.IGNORECASE | re.MULTILINE,
)


def classify(symptom: str) -> str:
    if _SUCCESS_RE.search(symptom or ""):
        return "not_a_failure"
    if _ENVIRONMENT_RE.search(symptom or ""):
        return "environment"
    return "failure"


def main() -> None:
    dry_run = "--dry-run" in sys.argv

    fb = failbase.FailBase()

    rows = fb.db.execute(
        "SELECT id, symptom FROM failures WHERE COALESCE(error_class, '') = ''"
    ).fetchall()

    counts = {
        "scanned": len(rows),
        "not_a_failure": 0,
        "environment": 0,
        "failure": 0,
    }
    updates = []

    for row in rows:
        cls = classify(row["symptom"])
        counts[cls] += 1
        updates.append((cls, row["id"]))

    if not dry_run and updates:
        fb.db.executemany(
            "UPDATE failures SET error_class = ? WHERE id = ?", updates
        )
        fb.db.commit()

    counts["dry_run"] = dry_run
    print(json.dumps(counts))


if __name__ == "__main__":
    main()
