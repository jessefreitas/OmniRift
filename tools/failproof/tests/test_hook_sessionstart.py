import importlib
import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))


def _mod(monkeypatch, tmp_path):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import sessionstart_known_failures as m
    importlib.reload(m)
    return m


def test_base_vazia_retorna_vazio(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    assert m.build_context("omnirift") == ""


def test_injeta_top_erros_com_fix(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    fb.add(symptom="docker network not found", fix="criar overlay core-net",
           command="docker", project="omnirift", fix_validated=True)
    fb.add(symptom="erro sem fix", command="x", project="omnirift")
    ctx = m.build_context("omnirift")
    assert "não repita" in ctx.lower()
    assert "core-net" in ctx
    assert len(ctx) <= m.MAX_CHARS


def test_cap_de_tamanho(monkeypatch, tmp_path):
    m = _mod(monkeypatch, tmp_path)
    import failbase
    fb = failbase.FailBase()
    for i in range(30):
        fb.add(symptom="erro {} ".format(i) + "y" * 300, fix="z" * 300,
               command="c{}".format(i), project="p", fix_validated=True)
    assert len(m.build_context("p")) <= m.MAX_CHARS
