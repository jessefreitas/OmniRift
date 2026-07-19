"""
Testa o ciclo de vida do arquivo watch/<session_id>.json do sistema failproof.

Fixa o contrato do watch file. Antes destes hooks, watch/ nunca era populado
(o watchdog era no-op) e nada removia o registro -- sessao encerrada virava
watch file orfao, ficava stale em 20 min e o watchdog matava um pid possivelmente
reciclado pelo SO.
"""
import json
import os
import subprocess
import sys
from os.path import abspath, dirname

ROOT = dirname(dirname(abspath(__file__)))
REGISTER = os.path.join(ROOT, "hooks", "watch_register.py")
CLEANUP = os.path.join(ROOT, "hooks", "watch_cleanup.py")


def _run(hook, payload, home, unattended):
    env = dict(os.environ, FAILBASE_HOME=str(home))
    env.pop("OMNI_UNATTENDED", None)
    if unattended:
        env["OMNI_UNATTENDED"] = "1"
    return subprocess.run(
        [sys.executable, hook],
        input=json.dumps(payload).encode(),
        env=env,
        capture_output=True,
        timeout=10,
    )


def _payload(tmp_path, sid="sess-1"):
    transcript = tmp_path / "transcript.jsonl"
    transcript.write_text("{}\n")
    return {
        "session_id": sid,
        "transcript_path": str(transcript),
        "cwd": str(tmp_path),
    }


def _watch_files(home):
    watch_dir = home / "watch"
    if not watch_dir.exists():
        return []
    return [p for p in watch_dir.iterdir() if p.suffix == ".json"]


def test_nao_registra_sessao_interativa(tmp_path):
    payload = _payload(tmp_path)
    proc = _run(REGISTER, payload, tmp_path, unattended=False)
    assert proc.returncode == 0
    # cuidado: o diretorio pode nem existir; trate isso sem estourar
    assert _watch_files(tmp_path) == []


def test_registra_unattended_com_contrato_completo(tmp_path):
    payload = _payload(tmp_path, sid="sess-1")
    proc = _run(REGISTER, payload, tmp_path, unattended=True)
    assert proc.returncode == 0

    watch_files = _watch_files(tmp_path)
    assert len(watch_files) == 1
    watch_file = watch_files[0]

    data = json.loads(watch_file.read_text())
    # precisa casar com o nome do arquivo porque o strike 3 usa isso para limpar
    assert data["session_id"] == "sess-1"
    assert os.path.exists(data["transcript_path"])
    # vazio de proposito, o watchdog executa com shell=True
    assert data["relaunch_cmd"] == ""


def test_nao_registra_sem_campo_obrigatorio(tmp_path):
    for campo in ("session_id", "transcript_path"):
        payload = _payload(tmp_path)
        del payload[campo]
        proc = _run(REGISTER, payload, tmp_path, unattended=True)
        assert proc.returncode == 0
        assert _watch_files(tmp_path) == []


def test_cleanup_remove_arquivo_e_strike_preservando_alheio(tmp_path):
    # registra
    payload = _payload(tmp_path, sid="sess-1")
    _run(REGISTER, payload, tmp_path, unattended=True)
    assert _watch_files(tmp_path)

    state_path = tmp_path / "watchdog_state.json"
    state_path.write_text(json.dumps({
        "sess-1": {"strike": 2},
        "outra-sessao": {"strike": 1},
    }))

    proc = _run(CLEANUP, {"session_id": "sess-1"}, tmp_path, unattended=True)
    assert proc.returncode == 0

    assert _watch_files(tmp_path) == []
    state = json.loads(state_path.read_text())
    assert "sess-1" not in state
    # nao pode levar junto strike de sessao viva
    assert state["outra-sessao"] == {"strike": 1}


def test_cleanup_e_idempotente(tmp_path):
    proc1 = _run(CLEANUP, {"session_id": "sess-inexistente"}, tmp_path, unattended=True)
    assert proc1.returncode == 0

    proc2 = _run(CLEANUP, {"session_id": "sess-inexistente"}, tmp_path, unattended=True)
    assert proc2.returncode == 0
