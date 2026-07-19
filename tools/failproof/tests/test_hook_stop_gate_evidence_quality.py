"""Suite de aceitacao do gate claim->evidencia (camada 2).

O gate atual libera a conclusao com QUALQUER tool_result nao-vermelho depois da
ultima edicao. Isso deixa passar "validacao insuficiente": um `ls`, um `cat` ou
um `py_compile` contam como "execucao verde" e a claim de sucesso e aprovada.

Casos reais colhidos em 2026-07-18 (sessao memory_claude_codex):
  - "server.py compila OK" via py_compile -> o modulo tinha import faltando
    (NameError em runtime). py_compile prova SINTAXE, nao resolucao de nomes.
  - "Task 1 verde" sem rodar a suite inteira -> 7/8, um teste vermelho.

Regra que estes testes travam: evidencia so conta se for VALIDACAO EXECUTAVEL
que cobre a claim (pytest/build/lint/run), nunca leitura/inspecao.
"""

import os
import sys

sys.path.insert(
    0,
    os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"),
)
import stop_evidence_gate as m  # noqa: E402

EDIT = {"kind": "tool_use", "name": "Edit", "cmd": "", "text": ""}


def _claim(text="Pronto, corrigido e funcionando."):
    return {"kind": "text", "name": "", "cmd": "", "text": text}


def _use(cmd):
    return {"kind": "tool_use", "name": "Bash", "cmd": cmd, "text": ""}


def _out(text):
    return {"kind": "tool_result", "name": "Bash", "cmd": "", "text": text}


def test_bloqueia_claim_validada_so_por_py_compile():
    """py_compile prova sintaxe, nao que o modulo funciona (caso real: import faltando)."""
    events = [EDIT, _use("python3 -m py_compile server.py"), _out("exit_code: 0"), _claim()]
    assert m.should_block(events) is True


def test_bloqueia_claim_validada_so_por_leitura():
    """ls/cat/grep sao inspecao, nao validacao."""
    events = [EDIT, _use("ls -la src/"), _out("total 42\nexit_code: 0"), _claim()]
    assert m.should_block(events) is True


def test_bloqueia_claim_validada_so_por_grep():
    """grep eh inspecao, nao validacao."""
    events = [EDIT, _use("grep -n 'def foo' src/a.py"), _out("12: def foo\nexit_code: 0"), _claim()]
    assert m.should_block(events) is True


def test_libera_claim_com_pytest_verde():
    """Validacao real e verde -> conclusao legitima passa."""
    events = [EDIT, _use("python3 -m pytest tests/ -q"), _out("5 passed\nexit_code: 0"), _claim()]
    assert m.should_block(events) is False


def test_libera_claim_com_build_verde():
    """Build verde -> conclusao legitima passa."""
    events = [EDIT, _use("npm run build"), _out("built in 3.2s\nexit_code: 0"), _claim()]
    assert m.should_block(events) is False


def test_bloqueia_quando_validacao_real_foi_vermelha():
    """Nao regride: pytest vermelho continua bloqueando."""
    events = [EDIT, _use("python3 -m pytest tests/ -q"), _out("1 failed\nexit_code: 1"), _claim()]
    assert m.should_block(events) is True


def test_leitura_depois_de_pytest_verde_nao_invalida():
    """Ordem nao pode derrubar evidencia boa ja produzida."""
    events = [
        EDIT,
        _use("python3 -m pytest tests/ -q"),
        _out("5 passed\nexit_code: 0"),
        _use("cat server.py"),
        _out("conteudo...\nexit_code: 0"),
        _claim(),
    ]
    assert m.should_block(events) is False