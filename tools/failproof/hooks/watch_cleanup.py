
#!/usr/bin/env python3
"""Remove o registro de sessao do watchdog ao termino normal da sessao."""

import json
import hashlib
import os
import sys

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")


def _ler_payload():
    """Le o payload JSON da stdin; em qualquer erro retorna dict vazio."""
    try:
        raw = sys.stdin.read()
        if not raw:
            return {}
        return json.loads(raw)
    except Exception:
        return {}


def _escrever_atomico(caminho, dados):
    """Grava JSON de forma atomica usando arquivo temporario e os.replace."""
    tmp = caminho + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(dados, fh, indent=2)
        fh.flush()
        os.fsync(fh.fileno())
    os.replace(tmp, caminho)


def main():
    payload = _ler_payload()
    session_id = payload.get("session_id")

    # Sem session_id nao ha o que limpar.
    if not session_id:
        return

    key = hashlib.sha256(str(session_id).encode()).hexdigest()[:24]
    watch_file = os.path.join(_HOME, "watch", f"{key}.json")
    try:
        if os.path.exists(watch_file):
            os.remove(watch_file)
    except Exception:
        pass

    # Sem esta remocao o watch file vira orfao, fica stale em ~20 min,
    # e o watchdog pode matar um pid reciclado por engano.
    state_file = os.path.join(_HOME, "watchdog_state.json")
    try:
        if not os.path.exists(state_file):
            return
        with open(state_file, "r", encoding="utf-8") as fh:
            state = json.load(fh)
        if not isinstance(state, dict):
            return
        if session_id in state:
            del state[session_id]
            _escrever_atomico(state_file, state)
    except Exception:
        pass


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
