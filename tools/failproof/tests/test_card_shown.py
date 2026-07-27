import os
import sys
import pytest

sys.path.insert(0, os.path.expanduser("~/.claude/failbase"))
import failbase


@pytest.fixture
def fb(tmp_path, monkeypatch):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    return failbase.FailBase(db_path=str(tmp_path / "t.db"))


def test_record_cards_shown_grava(fb):
    inserted = fb.record_cards_shown(["sigA", "sigB"], project="p")
    assert inserted == 2
    rows = fb.db.execute("SELECT signature FROM card_shown").fetchall()
    assert len(rows) == 2
    assert {row["signature"] for row in rows} == {"sigA", "sigB"}


def test_precision_conta_recorrencia(fb):
    fid = fb.add(symptom="erro de teste", project="p")
    sig = fb.db.execute("SELECT signature FROM failures WHERE id=?", (fid,)).fetchone()["signature"]
    fb.record_cards_shown([sig], project="p")
    fb.db.execute("UPDATE card_shown SET shown_at = datetime('now','-1 hour')")
    fb.db.commit()
    fb.add(symptom="erro de teste", project="p", signature=sig)
    report = fb.precision()
    assert report["cards_shown"] >= 1
    assert report["recurred_after_shown"] >= 1
    assert report["recurrence_rate"] > 0.0
    assert "caveat" in report


def test_precision_base_vazia(fb):
    report = fb.precision()
    assert report["cards_shown"] == 0
    assert report["recurrence_rate"] == 0.0
    assert "caveat" in report
