import importlib.util
import os
import sys

sys.path.insert(0, os.path.expanduser("~/.claude/failbase"))
_H = os.path.expanduser("~/.claude/hooks/failproof_posttool_failure_capture.py")
_S = importlib.util.spec_from_file_location("capture_hook", _H)
cap = importlib.util.module_from_spec(_S)
_S.loader.exec_module(cap)


def test_sucesso_com_exit_code_zero_nao_e_falha():
    assert cap.classify_capture({"exit_code": 0, "output": "1 failed, 0 passed"}) == "not_a_failure"


def test_texto_de_erro_sem_exit_code_nao_e_falha():
    assert cap.classify_capture({"output": "Error: no such table\nFAILED foo"}) == "not_a_failure"


def test_teste_verde_nao_vira_falha():
    assert cap.classify_capture({"output": "test result: ok. 654 passed; 0 failed"}) == "not_a_failure"


def test_erro_ambiental_e_classificado_como_environment():
    assert cap.classify_capture({"exit_code": 1, "output": "fatal: Unable to create '/x/.git/index.lock': Arquivo existe"}) == "environment"


def test_falha_real_continua_sendo_falha():
    assert cap.classify_capture({"exit_code": 1, "output": "AssertionError: 1 != 2"}) == "failure"
    assert cap.detect_failure({"exit_code": 1, "output": "boom"}) is True
