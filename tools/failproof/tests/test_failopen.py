"""Invariante crítico: hook NUNCA quebra a sessão — input corrompido → exit 0."""
import glob
import os
import subprocess
import sys

import pytest

HOOKS = sorted(glob.glob(os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "hooks", "*.py")))

BAD_INPUTS = [b"", b"not json {{{", b'{"tool_name": null}', b'[]',
              b'{"transcript_path": "/nao/existe"}']


@pytest.mark.parametrize("hook", HOOKS)
@pytest.mark.parametrize("bad", BAD_INPUTS)
def test_hook_falha_aberto(hook, bad, tmp_path):
    env = dict(os.environ, FAILBASE_HOME=str(tmp_path))
    proc = subprocess.run([sys.executable, hook], input=bad, env=env,
                          capture_output=True, timeout=10)
    assert proc.returncode == 0, "{} saiu com {} para input {!r}".format(
        hook, proc.returncode, bad)


# A contagem e travada de proposito: hook novo entra no parametrize acima (fail-open)
# so se alguem lembrar de atualizar aqui — e a falha deste assert e o lembrete.
ESPERADOS = {
    "posttool_failure_capture.py",
    "sessionstart_known_failures.py",
    "stop_evidence_gate.py",
    "userprompt_correction_detector.py",
    "watch_cleanup.py",
    "watch_register.py",
}


def test_conjunto_de_hooks_e_o_esperado():
    achados = {os.path.basename(h) for h in HOOKS}
    assert achados == ESPERADOS, "hooks divergiram: {}".format(achados ^ ESPERADOS)
