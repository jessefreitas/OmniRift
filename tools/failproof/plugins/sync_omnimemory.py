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
        # shell=True é o RECURSO, não um descuido: FAILPROOF_SYNC_CMD é uma linha de shell
        # que o próprio dono escreve na config dele (pipes, redirect). Quem controla a env
        # var já controla o processo — não há elevação de privilégio aqui.
        # nosemgrep: python.lang.security.audit.subprocess-shell-true.subprocess-shell-true
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
