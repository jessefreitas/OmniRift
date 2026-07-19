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


def test_flush_to_brain_noop_sem_env(monkeypatch, tmp_path):
    # sem FAILPROOF_SYNC_CMD (default cliente/dev) → não sincroniza nada = privado.
    monkeypatch.delenv("FAILPROOF_SYNC_CMD", raising=False)
    m = _mod(monkeypatch, tmp_path)
    import failbase
    failbase.FailBase().add(symptom="erro local", command="x")
    assert m.flush_to_brain() == 0


def test_flush_to_brain_sincroniza_e_marca_synced(monkeypatch, tmp_path):
    # com FAILPROOF_SYNC_CMD (dev da empresa) → empurra falhas novas e marca synced=1.
    monkeypatch.setenv("FAILPROOF_SYNC_CMD", "cat >/dev/null")  # consome stdin, exit 0
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    fb.add(symptom="erro pra sincronizar", command="y")
    assert m.flush_to_brain() == 1
    row = fb.db.execute("SELECT synced FROM failures WHERE symptom LIKE 'erro pra sincronizar%'").fetchone()
    assert row[0] == 1
    assert m.flush_to_brain() == 0  # nada novo na 2ª passada

def test_kill_pid_ausente_nao_sigterma_process_group(monkeypatch, tmp_path):
    # pid faltando → os.kill(0) mandaria SIGTERM pro grupo do próprio watchdog (fix #1).
    m = _mod(monkeypatch, tmp_path)
    chamado = []
    monkeypatch.setattr(m.os, "kill", lambda p, s: chamado.append(p))
    ex = m.Executor(dry_run=False, notify_fn=lambda msg: None)
    ex.kill(None)
    ex.kill(0)
    assert chamado == []                                  # nunca chamou os.kill
    assert [a[0] for a in ex.actions] == ["kill_skipped", "kill_skipped"]
    ex.kill(12345)
    assert chamado == [12345]                             # pid real ainda mata


def test_stale_min_ajustavel_por_env(monkeypatch):
    """O default subiu de 20 para 40 porque o transcript so recebe o resultado de uma
    ferramenta QUANDO ELA TERMINA — um build longo deixa o arquivo parado sem que nada
    esteja travado, e com 20 min um turno saudavel era morto. Fica ajustavel por env, e
    valor invalido tem que cair no default: config quebrada nao pode derrubar o watchdog.
    """
    import importlib
    m = importlib.import_module("watchdog")

    monkeypatch.delenv("FAILPROOF_STALE_MIN", raising=False)
    assert m._stale_min() == 40

    monkeypatch.setenv("FAILPROOF_STALE_MIN", "90")
    assert m._stale_min() == 90

    for ruim in ("abc", "", "0", "-5"):
        monkeypatch.setenv("FAILPROOF_STALE_MIN", ruim)
        assert m._stale_min() == 40, "env {!r} deveria cair no default".format(ruim)
