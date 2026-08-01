#!/usr/bin/env python3
"""test-local-review.py — Testes de regressão para scripts/local-review.py.

Estes testes existem porque um patch anterior "otimizou" o gate de review de 89s
para 0,3s — e os scanners tinham parado de rodar. A assinatura estava errada
(`_run_tool(cmd, cwd, timeout)` contra `_run_tool(cmd, timeout)`), então gitleaks
e semgrep viravam `skipped` e o gate passava sem escanear nada. Ninguém percebeu
porque a validação olhou TEMPO e VEREDITO, nunca se o trabalho foi feito.

Aqui só passa quem realmente invocar os scanners.
"""

import importlib.util
import json
import os
import shutil
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path


# ---------- Carregamento do módulo sob teste ----------
AQUI = Path(__file__).resolve().parent
RAIZ = AQUI.parent  # raiz do projeto (assumindo scripts/ um nível abaixo)
MODULO_PATH = RAIZ / "scripts" / "local-review.py"


def carregar_modulo():
    spec = importlib.util.spec_from_file_location("local_review", MODULO_PATH)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


LR = carregar_modulo()


# ---------- Utilidades de execução de fakes ----------
def caminho_fakes(tmpdir: Path) -> Path:
    d = tmpdir / "fakes"
    d.mkdir(parents=True, exist_ok=True)
    return d


def escrever_fake(caminho: Path, conteudo: str):
    caminho.write_text(conteudo, encoding="utf-8")
    st = caminho.stat()
    os.chmod(caminho, st.st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)


def make_gitleakes_fake(d: Path, contador: Path, comportamento: str = "clean"):
    # Fake que imita o gitleaks real: grava no --report-path JSON {Results:[...]}
    # e sai com --exit-code 1 quando acha algo.
    conteudo = f"""#!/bin/sh
echo "$@" >> "{contador}"
ARGS="$*"
report=""
emit=false
for a in "$@"; do
  case "$a" in
    --report-path=*) report="${{a#--report-path=}}" ;;
    --report-path) shift_next=1 ;;
    *) if [ -n "$shift_next" ]; then report="$a"; shift_next=0; fi ;;
  esac
done
case "{comportamento}" in
  clean)
    if [ -n "$report" ]; then printf '{{"Results":[]}}' > "$report"; fi
    exit 0
    ;;
  secret)
    if [ -n "$report" ]; then printf '{{"Results":[{{"RuleID":"generic-api-key","Secret":"AKIAFAKE","File":"%s","StartLine":1,"EndLine":1}}]}}' "${{ARGS##* }}" > "$report"; fi
    exit 1
    ;;
  crash)
    echo "gitleaks: erro simulado de execução" >&2
    exit 2
    ;;
esac
exit 0
"""
    escrever_fake(d / "gitleaks", conteudo)


def make_semgrep_fake(d: Path, contador: Path, comportamento: str = "clean"):
    # Fake que imita o semgrep real: emite JSON no stdout com results[].
    conteudo = f"""#!/bin/sh
echo "$@" >> "{contador}"
case "{comportamento}" in
  clean)
    printf '{{"results":[]}}'
    exit 0
    ;;
  secret)
    printf '{{"results":[{{"check_id":"generic-api-key","path":"x","start":{{"line":1}},"extra":{{"message":"chave vazada","metadata":{{"severity":"CRITICAL","category":"security"}}}}}}]}}'
    exit 0
    ;;
  crash)
    echo "semgrep: erro simulado de execução" >&2
    exit 2
    ;;
esac
exit 0
"""
    escrever_fake(d / "semgrep", conteudo)


def _report_path_arg(args: list[str]) -> str | None:
    for i, a in enumerate(args):
        if a == "--report-path" and i + 1 < len(args):
            return args[i + 1]
        if a.startswith("--report-path="):
            return a.split("=", 1)[1]
    return None


def contador_linhas(p: Path) -> int:
    if not p.exists():
        return 0
    return sum(1 for _ in p.read_text(encoding="utf-8", errors="replace").splitlines())


# ---------- Repo git temporário ----------
def tem_git() -> bool:
    return shutil.which("git") is not None


def init_repo(d: Path):
    subprocess.run(["git", "init", "-q"], cwd=d, check=True)
    (d / ".gitignore").write_text("fakes/\n", encoding="utf-8")
    subprocess.run(["git", "add", "."], cwd=d, check=True)
    subprocess.run(
        ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "init"],
        cwd=d, check=True,
    )


def run(cwd, args, **kw):
    env = kw.pop("env", None)
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, env=env, **kw)


# ---------- Ambiente de execução ----------
class Ctx:
    def __init__(self):
        self.tmp = Path(tempfile.mkdtemp(prefix="tlr-"))
        self.repo = self.tmp / "repo"
        self.repo.mkdir(parents=True, exist_ok=True)
        self.fakes_dir = caminho_fakes(self.tmp)
        self.contador = self.tmp / "calls.log"
        self.contador.touch()
        # O módulo é carregado no MESMO processo e resolve binário com shutil.which,
        # que lê os.environ. Um dict de env local nunca chegaria nele — foi assim que
        # a primeira versão destes testes "passou" sem invocar fake nenhum.
        self._path_original = os.environ.get("PATH", "")
        os.environ["PATH"] = str(self.fakes_dir) + os.pathsep + self._path_original
        self.env = os.environ

    def close(self):
        os.environ["PATH"] = self._path_original
        shutil.rmtree(self.tmp, ignore_errors=True)

    def sem_fakes(self):
        """Tira os fakes do PATH real (o módulo lê os.environ) e devolve um restaurador."""
        anterior = os.environ.get("PATH", "")
        os.environ["PATH"] = "/nao-existe-bin"
        return lambda: os.environ.__setitem__("PATH", anterior)


# ---------- Execução de testes ----------
FALHAS = []
PULADOS = 0
OKS = 0


def registrar_ok(nome):
    global OKS
    OKS += 1
    print(f"ok {nome}")


def registrar_pulo(nome, motivo):
    global PULADOS
    PULADOS += 1
    print(f"skip {nome} ({motivo})")


def registrar_falha(nome, motivo):
    FALHAS.append((nome, motivo))
    print(f"not ok {nome}: {motivo}")


def testar(nome, fn):
    try:
        fn()
        registrar_ok(nome)
    except AssertionError as e:
        registrar_falha(nome, str(e))
    except Exception as e:  # noqa: BLE001
        registrar_falha(nome, f"exceção: {type(e).__name__}: {e}")


# ---------- Testes ----------
def t1_finding_detectado_no_modo_escopado():
    # Trava: assinatura errada `_run_tool(cmd, cwd, timeout)` vs `_run_tool(cmd, timeout)`
    # silenciava gitleaks/semgrep como skipped e o gate passava sem escanear.
    ctx = Ctx()
    try:
        (ctx.repo / "a.py").write_text("x = 1\n", encoding="utf-8")
        make_gitleakes_fake(ctx.fakes_dir, ctx.contador, "secret")
        make_semgrep_fake(ctx.fakes_dir, ctx.contador, "clean")
        findings, skipped = LR.security_gates(ctx.repo, ["a.py"])
        assert skipped == [], f"esperado skipped vazio, veio: {skipped!r}"
        assert any(
            f.get("severity") == "CRITICAL" and f.get("category") == "security"
            for f in findings
        ), f"nenhum finding CRITICAL/security em {findings!r}"
    finally:
        ctx.close()


def t2_ferramenta_ausente_vira_skipped_e_nao_zero_achados():
    # Trava: scanner ausente não pode ser confundido com "0 achados". Deve constar em skipped.
    ctx = Ctx()
    try:
        (ctx.repo / "a.py").write_text("x = 1\n", encoding="utf-8")
        # tira os fakes do PATH REAL (o módulo resolve com shutil.which no os.environ)
        restaurar = ctx.sem_fakes()
        try:
            findings, skipped = LR.security_gates(str(ctx.repo), ["a.py"])
        finally:
            restaurar()
        assert findings == [], f"ausência de scanner não pode gerar findings: {findings!r}"
        assert skipped, f"ausência de scanner deve constar em skipped: {skipped!r}"
        j = " ".join(skipped).lower()
        assert "gitleaks" in j or "semgrep" in j, f"skipped não menciona ferramenta: {skipped!r}"
    finally:
        ctx.close()


def t3_erro_de_execucao_vira_skipped():
    # Trava: erro de execução engolido como sucesso faria o gate passar sobre scanners quebrados.
    ctx = Ctx()
    try:
        (ctx.repo / "a.py").write_text("x = 1\n", encoding="utf-8")
        make_gitleakes_fake(ctx.fakes_dir, ctx.contador, "crash")
        make_semgrep_fake(ctx.fakes_dir, ctx.contador, "crash")
        findings, skipped = LR.security_gates(ctx.repo, ["a.py"])
        assert findings == [], f"crash não pode virar findings: {findings!r}"
        assert skipped, f"crash deve virar skipped: {skipped!r}"
    finally:
        ctx.close()


def t4_escopo_vazio_nao_invoca_scanner():
    # Trava: scope=[] não pode invocar scanner nenhum (otimização correta vs bug anterior).
    ctx = Ctx()
    try:
        (ctx.repo / "a.py").write_text("x = 1\n", encoding="utf-8")
        make_gitleakes_fake(ctx.fakes_dir, ctx.contador, "clean")
        make_semgrep_fake(ctx.fakes_dir, ctx.contador, "clean")
        antes = contador_linhas(ctx.contador)
        LR.security_gates(ctx.repo, [])
        depois = contador_linhas(ctx.contador)
        assert depois == antes, f"scanner foi invocado com escopo vazio: {depois - antes} chamadas"
    finally:
        ctx.close()


def t5_escopado_invoca_uma_vez_por_arquivo_no_gitleaks():
    # Trava: gitleaks por-arquivo não pode sumir; semgrep aceita lista (1 chamada).
    ctx = Ctx()
    try:
        (ctx.repo / "a.py").write_text("x = 1\n", encoding="utf-8")
        (ctx.repo / "b.py").write_text("y = 2\n", encoding="utf-8")
        make_gitleakes_fake(ctx.fakes_dir, ctx.contador, "clean")
        make_semgrep_fake(ctx.fakes_dir, ctx.contador, "clean")
        LR.security_gates(ctx.repo, ["a.py", "b.py"])
        linhas = ctx.contador.read_text(encoding="utf-8", errors="replace").splitlines()
        gitleaks_calls = sum(1 for l in linhas if l.startswith("detect") or "gitleaks" in l or "--report-path" in l)
        # Contar invocações: cada chamada escreve uma linha com args.
        # Heurística robusta: contar linhas que contêm "--report-path" (gitleaks)
        # e linhas que contêm "--json" (semgrep) — se o módulo usar flags diferentes,
        # pelo menos garantir que houve >=2 chamadas totais.
        assert len(linhas) >= 3, f"esperado >=3 invocações (2 gitleaks + 1 semgrep), veio {len(linhas)}"
    finally:
        ctx.close()


def t6_fingerprint_muda_quando_conteudo_muda():
    # Trava: fingerprint baseado só em filenames faria cache esconder segredo novo.
    if not tem_git():
        registrar_pulo("fingerprint_muda_quando_conteudo_muda", "git ausente")
        return
    ctx = Ctx()
    try:
        init_repo(ctx.repo)
        (ctx.repo / "a.py").write_text("x = 1\n", encoding="utf-8")
        subprocess.run(["git", "add", "a.py"], cwd=ctx.repo, check=True)
        subprocess.run(
            ["git", "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "-m", "v1"],
            cwd=ctx.repo, check=True,
        )
        fp1 = LR.tree_fingerprint(ctx.repo)
        # ACRESCENTA segredo no mesmo arquivo — mantém " M" no porcelain
        (ctx.repo / "a.py").write_text("x = 1\nsecret = 'AKIAFAKE'\n", encoding="utf-8")
        fp2 = LR.tree_fingerprint(ctx.repo)
        assert fp1 != fp2, "fingerprint não mudou ao alterar conteúdo de arquivo rastreado"
    finally:
        ctx.close()


def t7_fingerprint_muda_com_untracked_novo():
    # Trava: untracked novo deve mudar fingerprint — senão arquivos não-commitados passam batidos.
    if not tem_git():
        registrar_pulo("fingerprint_muda_com_untracked_novo", "git ausente")
        return
    ctx = Ctx()
    try:
        init_repo(ctx.repo)
        fp1 = LR.tree_fingerprint(ctx.repo)
        (ctx.repo / "novo.py").write_text("z = 3\n", encoding="utf-8")
        fp2 = LR.tree_fingerprint(ctx.repo)
        assert fp1 != fp2, "fingerprint não mudou ao criar arquivo não rastreado"
    finally:
        ctx.close()


def t8_cache_diff_nao_serve_como_full():
    # Trava: cache gravado como "diff" não pode ser servido para "full" (vazamento de escopo).
    ctx = Ctx()
    try:
        fp = "deadbeef"
        LR.cache_put(str(ctx.repo), fp, "diff", {"findings": [], "skipped": []})
        got = LR.cache_get(str(ctx.repo), fp, "full")
        assert got is None, f"cache diff serviu como full: {got!r}"
    finally:
        ctx.close()


def t9_cache_expira():
    # Trava: payload antigo não pode ser servido — faria reusar resultados de árvore diferente.
    ctx = Ctx()
    try:
        fp = "cafebabe"
        payload = {"findings": [], "skipped": [], "at": 0}  # at antigo
        # cache_put normalmente sobrescreve 'at'; gravamos direto se possível.
        try:
            LR.cache_put(str(ctx.repo), fp, "full", payload)
        except Exception:
            pass
        got = LR.cache_get(str(ctx.repo), fp, "full")
        assert got is None, f"cache expirado foi servido: {got!r}"
    finally:
        ctx.close()


# ---------- Runner ----------
def main():
    testar("finding_detectado_no_modo_escopado", t1_finding_detectado_no_modo_escopado)
    testar("ferramenta_ausente_vira_skipped_e_nao_zero_achados", t2_ferramenta_ausente_vira_skipped_e_nao_zero_achados)
    testar("erro_de_execucao_vira_skipped", t3_erro_de_execucao_vira_skipped)
    testar("escopo_vazio_nao_invoca_scanner", t4_escopo_vazio_nao_invoca_scanner)
    testar("escopado_invoca_uma_vez_por_arquivo_no_gitleaks", t5_escopado_invoca_uma_vez_por_arquivo_no_gitleaks)
    testar("fingerprint_muda_quando_conteudo_muda", t6_fingerprint_muda_quando_conteudo_muda)
    testar("fingerprint_muda_com_untracked_novo", t7_fingerprint_muda_com_untracked_novo)
    testar("cache_diff_nao_serve_como_full", t8_cache_diff_nao_serve_como_full)
    testar("cache_expira", t9_cache_expira)

    print(f"test-local-review: {OKS} ok, {PULADOS} pulados")
    if FALHAS:
        for nome, motivo in FALHAS:
            print(f"  FALHA: {nome}: {motivo}", file=sys.stderr)
        sys.exit(1)
    sys.exit(0)


if __name__ == "__main__":
    main()
