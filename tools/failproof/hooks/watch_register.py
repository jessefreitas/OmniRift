#!/usr/bin/env python3
"""Registra sessoes unattended para vigilancia do watchdog da failbase."""

import json
import hashlib
import os
import sys
import time

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


def _e_unattended():
    """Detecção standalone; helper OmniForge é apenas fallback opcional."""
    if str(os.environ.get("OMNI_UNATTENDED", "")).strip().lower() in {"1", "true", "yes", "on"}:
        return True
    lib_dir = os.path.expanduser("~/.claude/hooks/lib")
    if lib_dir not in sys.path:
        sys.path.insert(0, lib_dir)
    try:
        from unattended import is_unattended
        return bool(is_unattended())
    except Exception:
        return False


def _pid_identity(pid):
    """Identidade Linux do processo para rejeitar PID reciclado no momento do kill."""
    try:
        with open("/proc/{}/stat".format(pid), encoding="utf-8") as fh:
            start_time = fh.read().split()[21]
        with open("/proc/{}/cmdline".format(pid), "rb") as fh:
            cmdline = fh.read()
        return {
            "pid_start_time": start_time,
            "pid_cmdline_sha256": hashlib.sha256(cmdline).hexdigest(),
        }
    except Exception:
        return {}


def _pid_do_claude():
    """Retorna o PPID somente se o processo pai for realmente o Claude.

    A checagem inspeciona argv[0] e, quando o executor e um runtime conhecido,
    argv[1]. Nao se busca a substring "claude" em toda a linha de comando porque
    o proprio hook reside em ~/.claude/failbase/hooks/; um shell, python3 ou outro
    processo invocado por caminho absoluto que contenha ".claude" casaria com a
    substring, fazendo com que o PID errado fosse gravado. O watchdog depois usaria
    esse PID em os.kill(...), podendo matar o shell do usuario ou um PID reciclado
    de outro processo.
    """
    try:
        ppid = os.getppid()
        if ppid <= 1:
            return None

        with open(f"/proc/{ppid}/cmdline", "rb") as fh:
            cmdline_bin = fh.read()

        # /proc/<pid>/cmdline usa NUL como separador de argumentos
        tokens = [t for t in cmdline_bin.split(b"\x00") if t]
        if not tokens:
            return None

        argv = [t.decode("utf-8", errors="replace") for t in tokens]

        runtimes = {
            "node", "nodejs", "bun", "deno",
            "python", "python3",
            "sh", "bash", "zsh",
        }

        def _e_claude(token):
            base = os.path.basename(token)
            return (
                base == "claude"
                or base.startswith("claude-")
                or token.endswith("/claude")
            )

        argv0 = argv[0]
        base0 = os.path.basename(argv0)

        # Pai executando o binario do Claude diretamente
        if base0 == "claude" or base0.startswith("claude-"):
            return ppid

        # Pai e um runtime que pode estar rodando o Claude como script/argumento
        if base0 in runtimes and len(argv) > 1:
            if _e_claude(argv[1]):
                return ppid

        return None
    except Exception:
        return None

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
    transcript_path = payload.get("transcript_path")

    # Contrato exige ambos os campos; se faltar algum, nao registra.
    if not session_id or not transcript_path:
        return

    # So registra sessoes unattended; fora isso, nao faz nada.
    if not _e_unattended():
        return

    watch_dir = os.path.join(_HOME, "watch")
    os.makedirs(watch_dir, mode=0o700, exist_ok=True)

    registro = {
        "session_id": session_id,
        "transcript_path": transcript_path,
        "relaunch_cmd": "",
        "registered_at": int(time.time()),
    }

    # So grava o pid se o pai for comprovadamente um processo claude. Se o hook
    # for invocado por um shell wrapper, o ppid e o shell -- que morre logo e tem
    # o numero reciclado pelo SO. O watchdog faz kill(pid): pid errado mata
    # processo de terceiro. Sem a chave, o watchdog registra kill_skipped e se
    # limita a gerar o postmortem, que e o comportamento seguro.
    pid = _pid_do_claude()
    if pid:
        registro["pid"] = pid
        registro.update(_pid_identity(pid))

    # relaunch_cmd fica vazio de proposito: o watchdog executa com shell=True,
    # entao o relancamento automatico so deve ser ligado por decisao explicita.
    # Hash evita traversal se um runtime fornecer session_id hostil.
    key = hashlib.sha256(str(session_id).encode()).hexdigest()[:24]
    destino = os.path.join(watch_dir, f"{key}.json")
    _escrever_atomico(destino, registro)
    os.chmod(destino, 0o600)


if __name__ == "__main__":
    try:
        main()
    except Exception:
        pass
    sys.exit(0)
