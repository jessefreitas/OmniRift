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


def test_detect_failure_reader_cmd_sem_exit_code_nao_e_falha(monkeypatch, tmp_path):
    # grep/journalctl que imprimem "error:" no output MAS terminaram bem não são falha.
    m = _mod(monkeypatch, tmp_path)
    resp = {"stdout": "app.log: 2 error: timeout\n5 failed logins"}  # sem exit_code
    assert m.detect_failure(resp, "grep -i error app.log") is False
    assert m.detect_failure(resp, "python build.py") is True  # comando não-leitor: heurística vale


def test_detect_failure_exit_code_camelcase_e_is_error(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.detect_failure({"stdout": "x", "exitCode": 2}) is True
    assert m.detect_failure({"stdout": "x", "is_error": True}) is True


def test_par_falha_fix_e_gravado_observado_nao_validado(monkeypatch, tmp_path):
    # correlação temporal (falha→sucesso na mesma família, comando DIFERENTE) é
    # OBSERVAÇÃO, não prova: guardado como candidato (fix_validated=0), nunca confirmado.
    m = _mod(monkeypatch, tmp_path)
    import failbase
    m.process(_payload("pytest tests/", "1 failed: ImportError foo", 1))
    m.process(_payload("pytest tests/ -p no:cacheprovider", "5 passed", 0))
    fb = failbase.FailBase()
    row = fb.search("ImportError")[0]
    assert row["fix_validated"] == 0            # observado, não validado
    assert "no:cacheprovider" in row["fix"]     # o candidato (comando de correção) guardado
    assert row["project"] == "proj"


def test_retry_comando_identico_nao_vira_fix(monkeypatch, tmp_path):
    # mesmo comando que passa na 2ª tentativa = flaky/retry, NÃO é correção.
    m = _mod(monkeypatch, tmp_path)
    import failbase
    m.process(_payload("pytest tests/", "1 failed: flaky", 1))
    m.process(_payload("pytest tests/", "5 passed", 0))
    fb = failbase.FailBase()
    rows = [r for r in fb.search("flaky") if r["fix"]]
    assert rows == []                           # nenhum fix gravado a partir de retry idêntico


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
