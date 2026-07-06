import os
import sys

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks"))
import userprompt_correction_detector as m


def test_detecta_correcoes():
    for prompt in ["tá errado isso", "está errado", "não é assim que faz",
                   "regressão de novo", "você quebrou o build", "voltou o erro",
                   "continua quebrado", "de novo isso??", "nao era isso"]:
        assert m.is_correction(prompt), prompt


def test_ignora_prompts_normais():
    for prompt in ["cria o endpoint de auth", "roda os testes",
                   "explica esse erro pra mim", "o que é regressão linear?"]:
        assert not m.is_correction(prompt), prompt


def test_build_instruction_menciona_failbase():
    out = m.build_instruction()
    assert "failbase" in out.lower()
    assert "human-feedback" in out
