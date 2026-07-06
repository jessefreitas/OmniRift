import importlib
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import failbase_ci as m
    importlib.reload(m)
    return m


def test_red_registra_e_green_fecha_par(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    log = tmp_path / "job.log"
    log.write_text("FAIL: test_auth — assertion error")
    m.main(["red", "--job", "pytest", "--branch", "feat/x", "--log", str(log)])
    diff = tmp_path / "fix.diff"
    diff.write_text("--- a/auth.py\n+++ b/auth.py\n+    return token")
    m.main(["green", "--job", "pytest", "--branch", "feat/x", "--diff", str(diff)])
    fb = failbase.FailBase()
    row = fb.search("assertion error")[0]
    assert row["fix_validated"] == 1
    assert "return token" in row["fix"]
    assert row["source"] == "ci"


def test_green_sem_red_anterior_e_noop(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    assert m.main(["green", "--job", "pytest", "--branch", "feat/y"]) == 0
    assert failbase.FailBase().stats()["total"] == 0
