import failbase


def test_normalize_signature_ignora_paths_numeros_e_hashes():
    a = failbase.normalize_signature(
        "FileNotFoundError: /home/user/proj/app.py line 42 (run 8f3a9b2c1d)", "python3 app.py")
    b = failbase.normalize_signature(
        "FileNotFoundError: /tmp/other/app.py line 99 (run aa11bb22cc)", "python3 app.py")
    assert a == b
    assert len(a) == 16


def test_normalize_signature_muda_com_comando_diferente():
    a = failbase.normalize_signature("connection refused", "curl http://x")
    b = failbase.normalize_signature("connection refused", "psql -h x")
    assert a != b


def test_add_e_lookup(fb):
    fid = fb.add(symptom="pytest: 1 failed", fix="corrigiu import", command="pytest",
                 source="session", project="omnirift", fix_validated=True)
    sig = failbase.normalize_signature("pytest: 1 failed", "pytest")
    row = fb.lookup(sig)
    assert row["id"] == fid
    assert row["fix"] == "corrigiu import"
    assert row["fix_validated"] == 1
    assert row["hits"] == 1


def test_add_duplicado_incrementa_hits_e_preserva_fix(fb):
    fb.add(symptom="erro X", fix="fix bom", command="make", fix_validated=True)
    fb.add(symptom="erro X", command="make")  # sem fix — não pode apagar o existente
    sig = failbase.normalize_signature("erro X", "make")
    row = fb.lookup(sig)
    assert row["hits"] == 2
    assert row["fix"] == "fix bom"
    assert row["fix_validated"] == 1


def test_symptom_truncado_em_2kb(fb):
    fb.add(symptom="x" * 10000, command="cmd")
    sig = failbase.normalize_signature("x" * 10000, "cmd")
    assert len(fb.lookup(sig)["symptom"]) <= 2048


def test_lookup_inexistente_retorna_none(fb):
    assert fb.lookup("deadbeef00000000") is None
