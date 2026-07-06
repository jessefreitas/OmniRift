import importlib
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "plugins"))


def test_notify_fallback_grava_arquivo(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    monkeypatch.delenv("FAILPROOF_NTFY_URL", raising=False)
    monkeypatch.delenv("FAILPROOF_TELEGRAM_TOKEN", raising=False)
    import notify as m
    importlib.reload(m)
    channel = m.notify("alerta de teste")
    assert channel == "file"
    alerts = os.listdir(tmp_path / "alerts")
    assert len(alerts) == 1
    assert "alerta de teste" in (tmp_path / "alerts" / alerts[0]).read_text()


def test_sync_omnimemory_indisponivel_e_noop(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    monkeypatch.delenv("FAILPROOF_SYNC_CMD", raising=False)
    import sync_omnimemory as m
    importlib.reload(m)
    assert m.available() is False
    assert m.sync() == 0  # nunca explode sem cluster
