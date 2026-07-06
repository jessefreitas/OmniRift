import os, sys
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))


@pytest.fixture
def fb(tmp_path, monkeypatch):
    monkeypatch.setenv("FAILBASE_HOME", str(tmp_path))
    import failbase
    return failbase.FailBase(db_path=str(tmp_path / "fb.db"))
