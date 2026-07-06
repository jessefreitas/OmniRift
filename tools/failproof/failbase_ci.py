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
