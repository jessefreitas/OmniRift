"""Camada 1 do gate claim->evidencia: lint estatico de teste-mentiroso.

Um teste verde nao e evidencia se ele nao exercita o caminho real. Casos reais
colhidos em 2026-07-18 (sessao memory_claude_codex):

  - test_living_context_wiring passava keyword sintetico ("nginx proxy_pass")
    direto na funcao de deteccao. O keyword veio da tabela interna do proprio
    modulo (_TRIGGER_KEYWORDS) — o teste provava que a constante casa consigo
    mesma. O trafego REAL de producao nao continha keyword nenhum: fire_rate 0.0.
  - testes que mockam a propria funcao sob teste e depois afirmam sobre o mock.

Contrato: lint_source(test_code, subject_code="") -> list[dict], cada achado com
{"kind", "test", "line", "message"}. Fail-open: codigo que nao parseia devolve [].
"""

import os
import sys

sys.path.insert(
    0, os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
)
from evidence_lint import lint_source  # noqa: E402


def _kinds(findings):
    return {f["kind"] for f in findings}


def test_detecta_teste_sem_assert():
    src = """
def test_faz_coisa():
    resultado = calcular(2)
    print(resultado)
"""
    assert "no_assert" in _kinds(lint_source(src))


def test_detecta_assert_trivial():
    src = """
def test_sempre_passa():
    assert True
"""
    assert "trivial_assert" in _kinds(lint_source(src))


def test_detecta_assert_tautologico():
    src = """
def test_tautologia():
    x = 5
    assert x == x
"""
    assert "trivial_assert" in _kinds(lint_source(src))


def test_detecta_mock_do_proprio_sujeito():
    """Mockar a funcao sob teste e depois afirmar sobre ela = testar o mock."""
    src = """
def test_detect_trigger(monkeypatch):
    monkeypatch.setattr(mod, "_detect_trigger", lambda *a: "after_edit")
    assert mod._detect_trigger("x") == "after_edit"
"""
    assert "mocks_subject" in _kinds(lint_source(src))


def test_detecta_input_sintetico_vindo_das_internas_do_modulo():
    """Caso real do prefetch: literal do teste sai da tabela interna do modulo."""
    subject = """
_TRIGGER_KEYWORDS = [
    ("after_nginx", ("nginx", "proxy_pass", "ssl")),
    ("after_docker", ("docker", "compose")),
]

def _detect_trigger(tool_name, *texts):
    blob = " ".join(texts).lower()
    for trigger, kws in _TRIGGER_KEYWORDS:
        if any(kw in blob for kw in kws):
            return trigger
    return None
"""
    test_src = """
def test_trigger_dispara():
    assert _detect_trigger("save_memory", "nginx proxy_pass ajustado") is not None
"""
    # heuristica experimental: ~0% precisao em suites reais, off por padrao
    assert "synthetic_input" not in _kinds(lint_source(test_src, subject))
    assert "synthetic_input" in _kinds(
        lint_source(test_src, subject, experimental=True))


def test_teste_honesto_nao_gera_achado():
    """Input realista (nao vindo das internas) + assert sobre efeito real: limpo."""
    subject = """
_TRIGGER_KEYWORDS = [("after_nginx", ("nginx", "proxy_pass"))]

def _detect_trigger(tool_name, *texts):
    return None
"""
    test_src = """
def test_trigger_com_trafego_real():
    resultado = _detect_trigger("search_memories", "returned 5 results - top: cafe")
    assert resultado is not None
"""
    assert lint_source(test_src, subject) == []


def test_fail_open_em_codigo_invalido():
    """Lint nunca pode explodir e travar o fluxo."""
    assert lint_source("def (((") == []