import importlib
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import watchdog as m
    importlib.reload(m)
    return m


def _transcript(tmp_path, sigs):
    """Gera transcript com tool_results de Bash cujas signatures são as dadas."""
    t = tmp_path / "tr.jsonl"
    lines = []
    for s in sigs:
        lines.append(json.dumps({"type": "user", "message": {"content": [
            {"type": "tool_result", "content": "error: {}".format(s)}]}}))
    t.write_text("\n".join(lines))
    return str(t)


def test_detect_stale(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.detect_stale(mtime=1000.0, now=1000.0 + 21 * 60, threshold_min=20) is True
    assert m.detect_stale(mtime=1000.0, now=1000.0 + 5 * 60, threshold_min=20) is False


def test_detect_loop_mesma_falha_3x(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.detect_loop_from_transcript(_transcript(tmp_path, ["A", "A", "A"])) is True
    assert m.detect_loop_from_transcript(_transcript(tmp_path, ["A", "B", "A"])) is False
    assert m.detect_loop_from_transcript(_transcript(tmp_path, ["A", "A"])) is False


def test_escala_de_strikes(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    state = {}
    assert m.next_strike(state, "s1") == 1
    assert m.next_strike(state, "s1") == 2
    assert m.next_strike(state, "s1") == 3
    assert m.next_strike(state, "s1") == 3  # teto
    assert m.next_strike(state, "s2") == 1  # sessões independentes


def test_postmortem_resume_erros(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    pm = m.build_postmortem(_transcript(tmp_path, ["timeout ssh", "timeout ssh"]), "s1")
    assert "timeout ssh" in pm
    assert "s1" in pm


def test_executor_dry_run_escala(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    entry = {"session_id": "s1", "transcript_path": _transcript(tmp_path, ["A", "A", "A"]),
             "pid": 999999, "relaunch_cmd": "echo relaunch {postmortem}"}
    ex = m.Executor(dry_run=True)
    m.handle(entry, strike=1, executor=ex)
    m.handle(entry, strike=3, executor=ex)
    kinds = [a[0] for a in ex.actions]
    assert "relaunch" in kinds       # strike 1 relança com contexto
    assert "notify" in kinds         # strike 3 notifica
    assert "failbase_add" in kinds   # strike 3 grava postmortem na base


def test_strike3_grava_na_failbase(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    entry = {"session_id": "s1", "transcript_path": _transcript(tmp_path, ["boom", "boom", "boom"]),
             "pid": 999999, "relaunch_cmd": ""}
    m.handle(entry, strike=3, executor=m.Executor(dry_run=False, notify_fn=lambda msg: None))
    fb = failbase.FailBase()
    assert fb.stats()["by_source"].get("watchdog") == 1
