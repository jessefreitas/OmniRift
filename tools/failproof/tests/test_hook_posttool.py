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


def test_par_falha_fix_e_gravado_observado_nao_validado(monkeypatch, tmp_path):
    # correlação temporal (falha→sucesso na mesma família) é OBSERVAÇÃO, não prova:
    # o fix é guardado como candidato (fix_validated=0), nunca como confirmado.
    m = _mod(monkeypatch, tmp_path)
    import failbase
    m.process(_payload("pytest tests/", "1 failed: ImportError foo", 1))
    m.process(_payload("pytest tests/", "5 passed", 0))
    fb = failbase.FailBase()
    row = fb.search("ImportError")[0]
    assert row["fix_validated"] == 0            # observado, não validado
    assert "pytest tests/" in row["fix"]        # mas o candidato foi guardado
    assert row["project"] == "proj"


def test_fix_validado_injeta_com_framing_confirmado(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    fb.add(symptom="1 failed: ImportError foo", fix="pip install foo", command="pytest",
           fix_validated=True)
    ctx = m.process(_payload("pytest tests/", "1 failed: ImportError foo", 1))
    assert ctx is not None and "pip install foo" in ctx
    assert "confirmado" in ctx.lower()          # sinal forte → framing firme
    assert "não confirmado" not in ctx.lower()


def test_fix_observado_injeta_como_pista_nao_confirmada(monkeypatch, tmp_path):
    # fix observado (fix_validated=0) TAMBÉM é surfaceado, mas como pista a confirmar —
    # nunca como verdade. Regressão do concern #1 (autoridade indevida).
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    fb.add(symptom="1 failed: ImportError foo", fix="pip install foo", command="pytest",
           fix_validated=False)
    ctx = m.process(_payload("pytest tests/", "1 failed: ImportError foo", 1))
    assert ctx is not None and "pip install foo" in ctx
    assert "não confirmado" in ctx.lower()      # observado → framing de pista


def test_falha_sem_fix_conhecido_nao_injeta(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.process(_payload("make", "erro inédito xyz", 1)) is None


def test_sucesso_sem_falha_pendente_e_noop(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.process(_payload("ls", "arquivos", 0)) is None
