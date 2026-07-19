#!/usr/bin/env python3
"""Camada 1 do gate claim->evidencia: lint estatico de teste-mentiroso.

Um teste verde so e evidencia se exercita o caminho real. Este modulo detecta,
por AST, quatro padroes em que o verde nao prova nada:

  no_assert       - funcao test_* que nao verifica coisa alguma.
  trivial_assert  - assert True / assert x == x: passa sempre.
  mocks_subject   - mocka um alvo e depois chama/afirma sobre o MESMO alvo:
                    o teste exercita o mock, nao o codigo.
  synthetic_input - literal do teste carrega token tirado das constantes internas
                    do modulo sob teste. Prova que a constante casa consigo mesma.
                    Caso real (2026-07-18): o teste do behavioral prefetch passava
                    "nginx proxy_pass" porque "nginx" estava em _TRIGGER_KEYWORDS;
                    o trafego real nao tinha keyword nenhum e fire_rate era 0.0.

Contrato: lint_source(test_code, subject_code="") -> list[dict] com
{"kind", "test", "line", "message"}. Fail-open: fonte que nao parseia devolve [].
Stdlib pura, sem dependencia externa.
"""
from __future__ import annotations

import ast
import string

__all__ = ["lint_source"]

_MOCK_FUNCS = frozenset({"setattr", "patch", "object"})
_ASSERTY_CALLS = frozenset({"raises", "warns"})
_MIN_TOKEN = 4  # tokens curtos dao ruido demais


def _tokenize(text: str) -> set[str]:
    """Retorna tokens com >= _MIN_TOKEN caracteres, normalizados em caixa baixa."""
    lowered = text.lower()
    # Substitui pontuacao por espaco para nao grudar tokens.
    cleaned = lowered.translate(str.maketrans(string.punctuation, " " * len(string.punctuation)))
    return {token for token in cleaned.split() if len(token) >= _MIN_TOKEN}


def _subject_tokens(subject_code: str) -> set[str]:
    if not subject_code:
        return set()
    try:
        tree = ast.parse(subject_code)
    except SyntaxError:
        return set()

    tokens: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Constant) and isinstance(node.value, str):
            tokens.update(_tokenize(node.value))
    return tokens


def _docstring_node(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> ast.Constant | None:
    if fn.body and isinstance(fn.body[0], ast.Expr):
        value = fn.body[0].value
        if isinstance(value, ast.Constant) and isinstance(value.value, str):
            return value
    return None


def _assert_message_nodes(fn: ast.AST) -> set[int]:
    """Identifica literais usados como mensagem de assert para nao confundi-los
    com dados de entrada do teste."""
    ids: set[int] = set()
    for node in ast.walk(fn):
        if not isinstance(node, ast.Assert):
            continue
        msg = node.msg
        if isinstance(msg, ast.Constant) and isinstance(msg.value, str):
            ids.add(id(msg))
    return ids


def _is_trivial_assert(node: ast.Assert) -> bool:
    test = node.test
    if isinstance(test, ast.Constant):
        # Constantes verdadeiras passam sempre; constantes falsas falham sempre,
        # portanto nao sao "trivialmente verdes".
        return bool(test.value)

    if isinstance(test, ast.Compare) and len(test.ops) == 1:
        op = test.ops[0]
        if not isinstance(op, (ast.Eq, ast.Is)):
            return False
        left = test.left
        right = test.comparators[0]
        if isinstance(left, ast.Name) and isinstance(right, ast.Name):
            return left.id == right.id
        if isinstance(left, ast.Constant) and isinstance(right, ast.Constant):
            return left.value == right.value
    return False


def _mocked_targets(fn: ast.AST) -> set[str]:
    """Nomes passados como alvo para monkeypatch.setattr / mock.patch /
    mock.patch.object."""
    targets: set[str] = set()
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue

        func = node.func
        if not isinstance(func, ast.Attribute) or func.attr not in _MOCK_FUNCS:
            continue

        kwargs = {kw.arg: kw.value for kw in node.keywords}
        target = kwargs.get("target")
        if isinstance(target, ast.Constant) and isinstance(target.value, str):
            targets.add(target.value.split(".")[-1])

        # O alvo mockado e o LITERAL entre os args, nao o objeto:
        #   patch("mod.func")            -> args[0] e o alvo
        #   monkeypatch.setattr(m, "f")  -> args[1] e o alvo (args[0] e o modulo)
        #   patch.object(obj, "metodo")  -> args[1] e o alvo
        for arg in node.args:
            if isinstance(arg, ast.Constant) and isinstance(arg.value, str):
                targets.add(arg.value.split(".")[-1])

    return targets


def _called_names(fn: ast.AST) -> set[str]:
    names: set[str] = set()
    for node in ast.walk(fn):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if isinstance(func, ast.Name):
            names.add(func.id)
        elif isinstance(func, ast.Attribute):
            names.add(func.attr)
    return names


def _has_assert_like(fn: ast.AST) -> bool:
    for node in ast.walk(fn):
        if isinstance(node, ast.Assert):
            return True
        if isinstance(node, ast.Call):
            func = node.func
            if isinstance(func, ast.Attribute):
                if func.attr.startswith("assert") or func.attr in _ASSERTY_CALLS:
                    return True
    return False


def lint_source(test_code: str, subject_code: str = "",
                experimental: bool = False) -> list[dict]:
    # synthetic_input e EXPERIMENTAL (off por padrao): ~0% de precisao medida em
    # 4 suites reais (2026-07-18) — acusa vocabulario legitimo do dominio.
    try:
        tree = ast.parse(test_code)
    except SyntaxError:
        return []

    subject_tokens = _subject_tokens(subject_code) if experimental else set()

    findings: list[dict] = []

    for fn in ast.walk(tree):
        if not isinstance(fn, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not fn.name.startswith("test"):
            continue

        if not _has_assert_like(fn):
            findings.append(
                {
                    "kind": "no_assert",
                    "test": fn.name,
                    "line": fn.lineno,
                    "message": "teste sem assert: nao verifica nada",
                }
            )

        for node in ast.walk(fn):
            if isinstance(node, ast.Assert) and _is_trivial_assert(node):
                findings.append(
                    {
                        "kind": "trivial_assert",
                        "test": fn.name,
                        "line": node.lineno,
                        "message": "assert trivial/tautologico: passa sempre",
                    }
                )

        overlap = _mocked_targets(fn) & _called_names(fn)
        if overlap:
            findings.append(
                {
                    "kind": "mocks_subject",
                    "test": fn.name,
                    "line": fn.lineno,
                    "message": (
                        "mocka e chama o mesmo alvo (%s): exercita o mock, nao o codigo"
                        % ", ".join(sorted(overlap))
                    ),
                }
            )

        if subject_tokens:
            skip_nodes = _assert_message_nodes(fn)
            doc_node = _docstring_node(fn)
            if doc_node is not None:
                skip_nodes.add(id(doc_node))

            for node in ast.walk(fn):
                if not isinstance(node, ast.Constant) or not isinstance(node.value, str):
                    continue
                if id(node) in skip_nodes:
                    continue
                if _tokenize(node.value) & subject_tokens:
                    findings.append(
                        {
                            "kind": "synthetic_input",
                            "test": fn.name,
                            "line": node.lineno,
                            "message": (
                                "input do teste usa token interno do modulo: "
                                "prova que a constante casa consigo mesma"
                            ),
                        }
                    )
                    break

    return findings