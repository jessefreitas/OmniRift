import json
import failbase


def test_cli_add_e_search(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    rc = failbase.main(["add", "--symptom", "docker: network core-net not found",
                        "--fix", "docker network create --driver overlay core-net",
                        "--source", "human-feedback", "--project", "omnirift"])
    assert rc == 0
    rc = failbase.main(["search", "network not found"])
    assert rc == 0
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out[0]["source"] == "human-feedback"


def test_cli_stats(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    failbase.main(["add", "--symptom", "x"])
    failbase.main(["stats"])
    out = json.loads(capsys.readouterr().out.strip().splitlines()[-1])
    assert out["total"] == 1


def test_cli_export(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    failbase.main(["add", "--symptom", "y", "--fix", "z"])
    failbase.main(["export"])
    lines = [l for l in capsys.readouterr().out.strip().splitlines() if l]
    assert json.loads(lines[-1])["symptom"] == "y"
