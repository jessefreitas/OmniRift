import json
import os
import subprocess

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def _run_install(home):
    return subprocess.run(["bash", os.path.join(ROOT, "install.sh")],
                          env=dict(os.environ, HOME=str(home)),
                          capture_output=True, text=True, timeout=60)


def test_install_cria_estrutura_e_registra_hooks(tmp_path):
    proc = _run_install(tmp_path)
    assert proc.returncode == 0, proc.stderr
    claude = tmp_path / ".claude"
    assert (claude / "failbase" / "failbase.py").exists()
    assert (claude / "failbase" / "watchdog.py").exists()
    assert (claude / "hooks" / "failproof_posttool_failure_capture.py").exists()
    settings = json.loads((claude / "settings.json").read_text())
    assert any("failproof_stop_evidence_gate" in json.dumps(h)
               for h in settings["hooks"]["Stop"])
    assert any("failproof_posttool_failure_capture" in json.dumps(h)
               for h in settings["hooks"]["PostToolUse"])


def test_install_preserva_settings_existentes(tmp_path):
    claude = tmp_path / ".claude"
    claude.mkdir()
    (claude / "settings.json").write_text(json.dumps(
        {"model": "opus", "hooks": {"Stop": [{"hooks": [
            {"type": "command", "command": "meu_hook_existente.py"}]}]}}))
    proc = _run_install(tmp_path)
    assert proc.returncode == 0, proc.stderr
    settings = json.loads((claude / "settings.json").read_text())
    assert settings["model"] == "opus"
    assert any("meu_hook_existente" in json.dumps(h) for h in settings["hooks"]["Stop"])
    assert any("failproof_stop_evidence_gate" in json.dumps(h)
               for h in settings["hooks"]["Stop"])


def test_install_e_idempotente(tmp_path):
    _run_install(tmp_path)
    _run_install(tmp_path)
    settings = json.loads((tmp_path / ".claude" / "settings.json").read_text())
    stops = json.dumps(settings["hooks"]["Stop"])
    assert stops.count("failproof_stop_evidence_gate") == 1


def test_uninstall_remove_tudo_e_preserva_alheio(tmp_path):
    _run_install(tmp_path)
    proc = subprocess.run(["bash", os.path.join(ROOT, "uninstall.sh")],
                          env=dict(os.environ, HOME=str(tmp_path)),
                          capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    claude = tmp_path / ".claude"
    assert not list((claude / "hooks").glob("failproof_*"))
    settings = json.loads((claude / "settings.json").read_text())
    assert "failproof" not in json.dumps(settings)
