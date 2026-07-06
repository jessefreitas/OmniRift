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


def test_search_fts_encontra_por_texto(fb):
    fb.add(symptom="psycopg2 connection refused host pg", fix="usar service name via core-net",
           command="python3 x.py")
    hits = fb.search("connection refused")
    assert len(hits) == 1
    assert "core-net" in hits[0]["fix"]


def test_search_sanitiza_query_com_pontuacao(fb):
    fb.add(symptom="erro: foo() quebrou", command="pytest")
    assert fb.search('foo() "quebrou:!') != []  # não pode explodir sintaxe FTS5


def test_top_for_project_prioriza_hits_e_inclui_globais(fb):
    fb.add(symptom="erro raro", command="a", project="omnirift")
    for _ in range(5):
        fb.add(symptom="erro frequente", command="b", project="omnirift")
    fb.add(symptom="erro global", command="c", project="")
    top = fb.top_for_project("omnirift", limit=10)
    assert top[0]["symptom"] == "erro frequente"
    assert any(r["symptom"] == "erro global" for r in top)
    assert all(r["project"] in ("omnirift", "") for r in top)


def test_stats(fb):
    fb.add(symptom="a", command="x", fix="f", fix_validated=True)
    fb.add(symptom="b", command="y", source="ci")
    s = fb.stats()
    assert s["total"] == 2
    assert s["validated"] == 1
    assert s["by_source"] == {"session": 1, "ci": 1}


def test_wal_habilitado(fb):
    # WAL: leitor não bloqueia escritor (várias sessões na mesma base).
    mode = fb.db.execute("PRAGMA journal_mode").fetchone()[0]
    assert mode.lower() == "wal"


def test_top_for_project_valida_ganha_de_observado_com_mesmo_calor(fb):
    # mesmo calor (1 hit cada), mas o fix validado deve subir acima do observado.
    fb.add(symptom="erro observado", command="a", project="omnirift", fix="talvez", fix_validated=False)
    fb.add(symptom="erro validado", command="b", project="omnirift", fix="certo", fix_validated=True)
    top = fb.top_for_project("omnirift", limit=10)
    assert top[0]["symptom"] == "erro validado"
