"""Camada 3 do gate claim->evidencia: juiz LLM sobre a transcricao.

Camadas 1 e 2 sao deterministicas (AST e estrutura de eventos). Elas nao pegam
divergencia SEMANTICA: "rodei a suite inteira" quando so um arquivo foi testado,
"corrigi os tres problemas" quando dois foram tocados.

O juiz recebe FATOS extraidos deterministicamente da transcricao — nao a
narrativa do agente — e pergunta se a claim se sustenta. Caso real (2026-07-18):
"Task 1 verde" enquanto a suite era 7/8.

Contrato:
  extract_facts(events) -> dict     (deterministico, a prova de manipulacao)
  build_judge_prompt(claim, facts) -> str
  judge(claim, facts, call_llm) -> {"sustained": bool, "confidence": float,
                                    "issues": [str]}
Fail-open: LLM indisponivel/resposta invalida -> sustained=True (nunca trava).
"""

import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from claim_judge import build_judge_prompt, extract_facts, judge  # noqa: E402


def _use(name: str, cmd: str = "") -> dict:
    return {"kind": "tool_use", "name": name, "cmd": cmd, "text": ""}


def _out(text: str) -> dict:
    return {"kind": "tool_result", "name": "", "cmd": "", "text": text}


def _txt(text: str) -> dict:
    return {"kind": "text", "name": "", "cmd": "", "text": text}


EVENTS = [
    _use("Edit"),
    _use("Bash", "python3 -m pytest tests/test_a.py -q"),
    _out("7 passed, 1 failed\nexit_code: 1"),
    _txt("Task 1 verde, tudo funcionando."),
]


def test_extract_facts_counts_edits_and_commands():
    facts = extract_facts(EVENTS)
    assert facts["edits"] == 1
    assert any("pytest" in command for command in facts["commands"])


def test_extract_facts_detects_red_result():
    facts = extract_facts(EVENTS)
    assert facts["had_red_result"] is True


def test_extract_facts_ignores_agent_narrative():
    """A prosa do agente nao pode virar 'fato'."""
    facts = extract_facts(EVENTS)
    blob = json.dumps(facts).lower()
    assert "tudo funcionando" not in blob


def test_prompt_includes_claim_and_facts():
    prompt = build_judge_prompt(
        "Task 1 verde, tudo funcionando.", extract_facts(EVENTS)
    )
    assert "Task 1 verde" in prompt
    assert "pytest" in prompt
    assert "evid" in prompt.lower() or "fato" in prompt.lower()


def test_judge_parses_llm_verdict():
    def fake_llm(_prompt: str) -> str:
        return json.dumps(
            {
                "sustained": False,
                "confidence": 0.9,
                "issues": ["a suite teve 1 falha"],
            }
        )

    verdict = judge("Task 1 verde.", extract_facts(EVENTS), fake_llm)
    assert verdict["sustained"] is False
    assert verdict["confidence"] >= 0.7
    assert verdict["issues"]


def test_judge_accepts_json_wrapped_in_text():
    def fake_llm(_prompt: str) -> str:
        return (
            'Segue:\n```json\n'
            '{"sustained": true, "confidence": 0.8, "issues": []}'
            '\n```'
        )

    verdict = judge("ok", extract_facts(EVENTS), fake_llm)
    assert verdict["sustained"] is True


def test_judge_fails_open_when_llm_raises():
    def broken_llm(_prompt: str) -> str:
        raise RuntimeError("ollama offline")

    verdict = judge("ok", extract_facts(EVENTS), broken_llm)
    assert verdict["sustained"] is True
    assert verdict["confidence"] == 0.0


def test_judge_fails_open_with_invalid_response():
    verdict = judge("ok", extract_facts(EVENTS), lambda _p: "desculpe, nao entendi")
    assert verdict["sustained"] is True
    assert verdict["confidence"] == 0.0