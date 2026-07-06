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


def test_existem_4_hooks():
    assert len(HOOKS) == 4
