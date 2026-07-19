import difflib
import itertools
import os

import pytest

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
HOME_FB = os.environ.get("FAILBASE_SRC_HOME") or os.path.expanduser("~/.claude/failbase")
TESTE_BASENAME = os.path.basename(__file__)

# Pastas que sao estado local/maquina ou artefatos de ferramentas: nunca codigo compartilhado.
COMPONENTES_IGNORADOS = frozenset({
    "__pycache__",
    ".pytest_cache",
    "session_buffer",
    "watch",
    "alerts",
    "postmortems",
    ".git",
    "node_modules",
    "venv",
})

# Se o home global nao existe, nao falhamos: CI/maquina nova simplesmente nao tem a segunda copia.
pytestmark = pytest.mark.skipif(
    not os.path.isdir(HOME_FB),
    reason="HOME_FB nao existe neste ambiente; ausencia nao e falha.",
)

"""
Teste de paridade entre duas copias do failproof.

A versao anterior usava uma lista fixa de arquivos "criticos". Essa lista ja provou ser
perigosa: copias do mesmo projeto divergiram em silencio — uma delas perdeu um teste de
regressao de fix de seguranca, outra ficou sem a redacao de segredos, outra sem a flag
`--validated`. Como o que falhou nao estava na lista, o teste passou verde enquanto o
codigo real estava diferente.

Por isso a comparacao agora e exaustiva: descobrimos os arquivos, nao os enumeramos.
Comparamos todo .py sob as duas raizes, listamos quem existe so de um lado para saber o
sentido da propagacao, e verificamos byte a byte (via diff) quem existe dos dois lados.
"""

def _arquivos_py(raiz):
    """
    Retorna um set com os caminhos relativos (com '/') de todos os .py sob a raiz,
    aplicando os filtros de diretorios de lixo/estado local e ignorando o proprio
    arquivo deste teste.
    """
    if not os.path.isdir(raiz):
        return set()

    encontrados = set()

    for dirpath, dirnames, filenames in os.walk(raiz):
        # Poda antecipada: nao descemos em diretorios que so contem ruido local.
        dirnames[:] = [d for d in dirnames if d not in COMPONENTES_IGNORADOS]

        for nome in filenames:
            if not nome.endswith(".py"):
                continue
            # Este teste pode existir legitmamente so de um lado enquanto e propagado.
            if nome == TESTE_BASENAME:
                continue

            caminho_abs = os.path.join(dirpath, nome)
            rel = os.path.relpath(caminho_abs, raiz).replace(os.sep, "/")
            encontrados.add(rel)

    return encontrados


def test_mesmo_conjunto_de_arquivos():
    """
    Garante que as duas copias possuem exatamente os mesmos arquivos .py.
    Saber qual lado tem o arquivo a mais indica a direcao da propagacao.
    """
    repo = _arquivos_py(REPO)
    home = _arquivos_py(HOME_FB)

    so_no_repo = sorted(repo - home)
    so_no_home = sorted(home - repo)

    assert not (so_no_repo or so_no_home), (
        "Os conjuntos de arquivos .py divergem entre REPO e HOME_FB.\n"
        "A lista fixa do passado escondia divergencias silenciosas; por isso listamos os dois lados.\n"
        f"So no repo ({len(so_no_repo)}):\n" + "\n".join(so_no_repo) + "\n"
        f"So no home ({len(so_no_home)}):\n" + "\n".join(so_no_home)
    )


@pytest.mark.parametrize(
    "rel",
    sorted(_arquivos_py(REPO) & _arquivos_py(HOME_FB)),
)
def test_conteudo_identico(rel):
    """
    Para cada arquivo presente nas duas copias, verifica se o conteudo e identico.
    A ausencia de arquivo ja e tratada por test_mesmo_conjunto_de_arquivos, entao aqui
    testamos apenas a intersecao, evitando duplicar a mesma falha.
    """
    repo_path = os.path.join(REPO, *rel.split("/"))
    home_path = os.path.join(HOME_FB, *rel.split("/"))

    with open(repo_path, encoding="utf-8", errors="replace") as f:
        repo_text = f.read()
    with open(home_path, encoding="utf-8", errors="replace") as f:
        home_text = f.read()

    if repo_text != home_text:
        diff = difflib.unified_diff(
            repo_text.splitlines(),
            home_text.splitlines(),
            fromfile=f"repo/{rel}",
            tofile=f"home/{rel}",
            lineterm="",
        )
        primeiras = list(itertools.islice(diff, 20))
        pytest.fail(f"Conteudo diverge para {rel}:\n" + "\n".join(primeiras))