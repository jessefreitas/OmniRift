#!/usr/bin/env python3
"""local-review.py — review HEADLESS do diff de um worktree, BYOK.

Usado por:
  - o Stop hook injetado nos agentes claude (modo --hook): impede o agente de
    declarar "pronto" enquanto o review reprovar (NO-GO).
  - a tool MCP review_current (modo padrão: imprime o veredito em JSON).

Config: lê review-config.json (escrito pelo app OmniRift) com a LLM BYOK ativa
({provider, baseUrl, apiKey, model}) + as policies por escopo. Sem dependências
externas — só stdlib.
"""
import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.request

DEFAULT_CATEGORIES = [
    ("security", "Segurança", 10, True),
    ("quality", "Qualidade", 7, False),
    ("performance", "Performance", 6, False),
    ("testing", "Testes", 5, False),
    ("architecture", "Arquitetura", 4, False),
    ("style", "Estilo", 2, False),
]
DEFAULT_POLICY = {
    "enabled": True,
    "gate": "warn",
    "thresholds": {"maxCritical": 0, "maxWarning": 1},
    "coverage": 80,
    "contracts": "",
    "prLimits": {"maxFiles": 40, "maxLines": 800, "maxFileLines": 500},
}

SECRET_PATTERNS = [
    (r"(?i)(api[_-]?key|secret|password|passwd)\s*[:=]\s*['\"][^'\"]{8,}", "possível secret hardcoded"),
    (r"AKIA[0-9A-Z]{16}", "AWS access key"),
    (r"-----BEGIN (RSA |EC )?PRIVATE KEY-----", "private key"),
    (r"sk-[A-Za-z0-9]{20,}", "token estilo OpenAI"),
]
DANGER_PATTERNS = [
    (r"\beval\s*\(", "uso de eval()"),
    (r"shell\s*=\s*True", "subprocess shell=True"),
    (r"\bpickle\.load", "pickle.load (desserialização insegura)"),
    (r"yaml\.load\s*\((?!.*Loader)", "yaml.load sem Loader"),
]

# Achados RECONHECIDOS como aceitos (design intencional — .forgejo/review-context.md).
# Supressão determinística (a IA é volátil na severidade desses itens). Idêntico ao CI.
SUPPRESS = [
    ("license.rs", ["públic", "public", "hardcoded", "embutid", "ed25519", "fingerprint", "machine-id", "machine id", "fallback"]),
    ("mcp_servers.rs", ["ofusc", "obfusc", "xor", "credenci", "criptograf", "cifr", "armazen", "repouso", "texto claro", "plaintext", "token"]),
    ("registry.rs", ["ofusc", "obfusc", "xor", "credenci", "criptograf", "cifr", "armazen", "repouso", "texto claro", "plaintext", "token"]),
    ("gitremote.rs", ["injeção", "injection", "vaza", "token", "redig", "sanitiz", "argument"]),
    ("browser.rs", ["injeção", "injection", "sanitiz", "shell", "command", "subprocess"]),
    ("fs.rs", ["limite", "tamanho", "arbitrár"]),
]


def load_extra_suppress(base="."):
    """Regras de supressão geríveis pela UI (.forgejo/review-suppress.json)."""
    try:
        with open(os.path.join(base, ".forgejo", "review-suppress.json"), encoding="utf-8") as fh:
            data = json.load(fh)
        return [(r.get("file", "").lower(), [k.lower() for k in r.get("keywords", [])]) for r in data if r.get("file")]
    except Exception:
        return []


def suppressed(f, extra=()):
    fp = (f.get("file") or "").lower()
    title = (f.get("title") or "").lower()
    rules = SUPPRESS + list(extra)
    return any(fpat in fp and any(k in title for k in kws) for fpat, kws in rules)


def load_pathrules(base="."):
    """Regras por path geríveis pela UI (.forgejo/review-pathrules.json)."""
    try:
        with open(os.path.join(base, ".forgejo", "review-pathrules.json"), encoding="utf-8") as fh:
            return json.load(fh)
    except Exception:
        return []


def pathrule_findings(diff_text, rules):
    """Achados determinísticos por regra de path (exige teste / aviso de path)."""
    import fnmatch
    files = [ln[6:] for ln in diff_text.splitlines() if ln.startswith("+++ b/")]
    out = []
    for r in rules:
        glob = (r.get("glob") or "").strip()
        if not glob:
            continue
        sev = r.get("severity") if r.get("severity") in ("CRITICAL", "WARNING", "INFO") else "WARNING"
        msg = r.get("message") or f"regra de path: {glob}"
        for f in files:
            if not fnmatch.fnmatch(f, glob):
                continue
            if r.get("requireTest"):
                fl = f.lower()
                if "test" in fl or "spec" in fl:
                    continue  # o próprio arquivo já é um teste
                base = os.path.splitext(os.path.basename(f))[0].lower()
                has_test = any(base in t.lower() and ("test" in t.lower() or "spec" in t.lower()) for t in files if t != f)
                if not has_test:
                    out.append({"severity": sev, "category": "testing", "file": f, "title": f"{msg} — sem teste correspondente no diff", "suggestion": "Adicione/atualize o teste deste arquivo."})
            else:
                out.append({"severity": sev, "category": "quality", "file": f, "title": msg, "suggestion": None})
    return out


def load_config(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def pick_policy(cfg, cwd):
    """Policy do escopo que casa com o cwd (repoRoot), senão a global, mesclada."""
    policies = cfg.get("policies") or {}
    chosen = None
    if cwd:
        # escolhe a chave (repoRoot) mais específica que é prefixo do cwd
        match = [k for k in policies if k and k != "__global" and cwd.startswith(k)]
        if match:
            chosen = policies[max(match, key=len)]
    if chosen is None:
        chosen = policies.get("__global", {})
    pol = {**DEFAULT_POLICY, **(chosen or {})}
    pol["thresholds"] = {**DEFAULT_POLICY["thresholds"], **(chosen.get("thresholds") or {})}
    pol["prLimits"] = {**DEFAULT_POLICY["prLimits"], **(chosen.get("prLimits") or {})}
    return pol


def detect_base(cwd):
    def g(args):
        return subprocess.run(["git", "-C", cwd, *args], capture_output=True, text=True).stdout.strip()
    head = g(["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"])
    if head:
        return head.replace("refs/remotes/origin/", "origin/")
    for b in ("main", "master"):
        if g(["rev-parse", "--verify", "--quiet", b]):
            return b
    return ""


def git_diff(cwd, base):
    """Diff do worktree (committed + working tree) vs a base; vazio se nada."""
    base = base or detect_base(cwd)
    out = ""
    if base:
        out = subprocess.run(["git", "-C", cwd, "diff", base], capture_output=True, text=True).stdout
    if not out.strip():
        out = subprocess.run(["git", "-C", cwd, "diff", "HEAD"], capture_output=True, text=True).stdout
    return out


def preflight(diff_text, policy):
    findings = []
    # blob de secret/danger ignora os PRÓPRIOS arquivos de review (eles DEFINEM os
    # padrões — senão o checker se auto-flaga ao ver suas próprias regras no diff).
    self_files = ("scripts/ci-code-review.py", "scripts/local-review.py", ".forgejo/workflows/code-review-ai.yml")
    scan, cur, skip = [], None, False
    for ln in diff_text.splitlines():
        if ln.startswith("+++ b/"):
            cur = ln[6:]
            skip = any(cur.endswith(s) for s in self_files)
        elif ln.startswith("+") and not ln.startswith("+++") and not skip:
            scan.append(ln[1:])
    blob = "\n".join(scan)
    for pat, desc in SECRET_PATTERNS:
        if re.search(pat, blob):
            findings.append({"severity": "CRITICAL", "category": "security", "file": "(diff)", "title": desc, "suggestion": "Remova o segredo; use variável de ambiente/cofre."})
    for pat, desc in DANGER_PATTERNS:
        if re.search(pat, blob):
            findings.append({"severity": "WARNING", "category": "security", "file": "(diff)", "title": desc, "suggestion": "Evite o padrão perigoso."})
    per_file = {}
    cur = None
    for ln in diff_text.splitlines():
        if ln.startswith("+++ b/"):
            cur = ln[6:]
            per_file[cur] = 0
        elif cur and ln.startswith("+") and not ln.startswith("+++"):
            per_file[cur] += 1
    limits = policy.get("prLimits", {})
    max_fl = limits.get("maxFileLines") or 500
    for f, n in per_file.items():
        if n > max_fl:
            findings.append({"severity": "WARNING", "category": "quality", "file": f, "title": f"arquivo grande no diff (+{n} linhas)", "suggestion": "Considere quebrar em partes menores."})
    if limits.get("maxFiles") and len(per_file) > limits["maxFiles"]:
        findings.append({"severity": "WARNING", "category": "quality", "file": "(diff)", "title": f"{len(per_file)} arquivos no diff (> {limits['maxFiles']})", "suggestion": "PR muito grande; divida."})
    return findings


# ── Estágio 1 · pré-flight de segurança determinístico ──────────────────────────
#
# Espelho em Python do reforço já implementado no lado Rust
# (apps/desktop/src-tauri/src/mcp/tools.rs :: run_preflight / preflight_gitleaks /
# preflight_semgrep). Roda gitleaks + semgrep sobre o WORKING TREE do cwd (não sobre o
# diff — pega secret/regra mesmo que ainda não commitado). Degrada SEMPRE limpo: binário
# ausente / timeout / JSON inválido = registrado em `skipped` (NEUTRAL — não vira finding
# e não bloqueia o review). Sem libs externas: só subprocess/json/shutil/tempfile.

def _run_tool(cmd, timeout):
    """Roda um binário externo. Espelha o `ToolRun` do Rust (Ran/Missing/Failed):
    devolve ("ran", CompletedProcess) | ("missing", None) | ("failed", "<motivo>").
    Ferramenta ausente (`shutil.which` None ou FileNotFoundError) e timeout NUNCA
    derrubam o review — viram NEUTRAL no chamador."""
    if shutil.which(cmd[0]) is None:
        return "missing", None
    try:
        return "ran", subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except FileNotFoundError:
        return "missing", None
    except subprocess.TimeoutExpired:
        return "failed", f"timeout após {timeout}s"
    except Exception as e:  # qualquer falha de execução = NEUTRAL (não bloqueia)
        return "failed", str(e)


def _gitleaks_gate(cwd, findings, skipped, target=None):
    """gitleaks --no-git (só o working tree), report JSON em arquivo temp. Cada leak =
    1 CRITICAL `security` (arquivo:linha + RuleID). Fallback: exit 1 sem report legível
    = 1 CRITICAL genérico (não perde o gate). Ausente/erro/inconclusivo → skipped."""
    fd, report_path = tempfile.mkstemp(prefix="omnirift-gitleaks-", suffix=".json")
    os.close(fd)
    # `target` = escopo (um arquivo) no modo hook; None = árvore toda. O RESTO dos
    # argumentos é idêntico nos dois modos, de propósito: quando o escopado tinha um
    # comando próprio, ele perdeu --no-git/--redact/--config e passou a falhar calado.
    cmd = [
        "gitleaks", "detect", "--source", target or cwd, "--no-git", "--redact",
        "--report-format", "json", "--report-path", report_path, "--exit-code", "1",
    ]
    # `.gitleaks.toml` do repo: exclui node_modules/target/dist (1,3 GB de código de
    # terceiros) e os fixtures de segredo falso. Sem ele a varredura levava ~39s e
    # estourava o timeout de 60s sob carga — aí o gitleaks virava "skipped" e o review
    # seguia dando veredito SEM ter escaneado segredo nenhum. Com ele: ~6s.
    cfg = os.path.join(cwd, ".gitleaks.toml")
    if os.path.isfile(cfg):
        cmd += ["--config", cfg]
    # Timeout maior que o da varredura medida, com folga pra máquina sob carga: o custo
    # de um scan lento é esperar; o de pular o scan é achar que revisou e não ter revisado.
    kind, out = _run_tool(cmd, 180)
    try:
        if kind == "missing":
            skipped.append("gitleaks: ferramenta ausente")
            return
        if kind == "failed":
            skipped.append(f"gitleaks: {out}")
            return
        try:
            with open(report_path, encoding="utf-8") as fh:
                data = json.load(fh)
        except Exception:
            data = None
        leaks = []
        if isinstance(data, list):
            for f in data:
                if not isinstance(f, dict):
                    continue
                file = str(f.get("File") or "?")
                line = f.get("StartLine") or 0
                rule = f.get("RuleID") or f.get("Description") or "secret"
                leaks.append({
                    "severity": "CRITICAL", "category": "security",
                    "file": f"{file}:{line}",
                    "title": f"secret no working tree ({str(rule)[:80]})",
                    "suggestion": "Remova o segredo; use variável de ambiente/cofre.",
                })
        code = out.returncode
        if leaks:
            findings.extend(leaks)
        elif code == 1:
            findings.append({
                "severity": "CRITICAL", "category": "security", "file": "(working tree)",
                "title": "secret no working tree (gitleaks exit 1)",
                "suggestion": "Remova o segredo; use variável de ambiente/cofre.",
            })
        elif code != 0:
            skipped.append(f"gitleaks: execução inconclusiva (código {code})")
        # code == 0 sem achados → working tree limpo, nada a fazer.
    finally:
        try:
            os.remove(report_path)
        except OSError:
            pass


def _semgrep_gate(cwd, findings, skipped, targets=None):
    """semgrep p/security-audit + p/secrets (severity ERROR), saída --json. ERROR →
    CRITICAL, senão WARNING; file `arquivo:linha [regra]`. Saída não-JSON (falha de
    rede/download de regras) / ausente / timeout → skipped (NEUTRAL)."""
    # `targets` = arquivos do diff no modo hook; None = árvore toda. Mesmos rulesets e
    # mesma severidade nos dois modos — a versão escopada anterior tinha comando próprio
    # e perdeu p/security-audit, p/secrets e --error.
    cmd = [
        "semgrep", "scan", "--config", "p/security-audit", "--config", "p/secrets",
        "--severity", "ERROR", "--error", "--json", "--quiet", "--metrics=off",
        "--disable-version-check",
    ] + (list(targets) if targets else [cwd])
    kind, out = _run_tool(cmd, 120)
    if kind == "missing":
        skipped.append("semgrep: ferramenta ausente")
        return
    if kind == "failed":
        skipped.append(f"semgrep: {out}")
        return
    try:
        data = json.loads((out.stdout or "").strip())
    except Exception:
        err = (out.stderr or "").strip().splitlines()
        snip = (err[-1] if err else "saída não-JSON")[:100]
        skipped.append(f"semgrep: saída inconclusiva ({snip})")
        return
    results = data.get("results") if isinstance(data, dict) else None
    if not isinstance(results, list):
        skipped.append("semgrep: saída inconclusiva (sem results)")
        return
    for r in results:
        if not isinstance(r, dict):
            continue
        path = str(r.get("path") or "?")
        start = r.get("start")
        line = start.get("line", 0) if isinstance(start, dict) else 0
        rule = str(r.get("check_id") or "semgrep")
        extra = r.get("extra") if isinstance(r.get("extra"), dict) else {}
        sev_raw = str(extra.get("severity") or "ERROR").upper()
        msg = str(extra.get("message") or rule)
        severity = "CRITICAL" if sev_raw == "ERROR" else "WARNING"
        short = (msg.splitlines()[0] if msg.strip() else msg)[:140]
        findings.append({
            "severity": severity, "category": "security",
            "file": f"{path}:{line} [{rule[:80]}]",
            "title": short, "suggestion": None,
        })


_GITLEAKS_MAX_FILES = 40


def _changed_files(cwd, base):
    """Arquivos alterados (relativos ao cwd) para o escopo do hook.
    base vazio -> diff contra HEAD. Usa saída NUL-delimited para nomes com espaço,
    aspas, rename ou newline. Inclui untracked via `git ls-files`.

    Retorna None em erro: falhar ao descobrir o escopo NÃO pode parecer diff vazio;
    o chamador cai para a árvore inteira nesse caso.
    """
    if not cwd or not os.path.isdir(cwd):
        return None
    ref = base or "HEAD"
    try:
        changed = subprocess.run(
            ["git", "-C", cwd, "diff", "--name-only", "-z", ref, "--"],
            capture_output=True,
            timeout=10,
        )
        untracked = subprocess.run(
            ["git", "-C", cwd, "ls-files", "--others", "--exclude-standard", "-z"],
            capture_output=True,
            timeout=10,
        )
    except Exception:
        return None
    if changed.returncode != 0 or untracked.returncode != 0:
        return None

    files = {
        os.fsdecode(raw)
        for output in (changed.stdout, untracked.stdout)
        for raw in output.split(b"\0")
        if raw
    }
    return sorted(files)


def _cache_dir():
    return os.path.join(os.path.expanduser("~"), ".omnirift", "review-cache")


SCANNERS_VERSION = "omnirift-local-review-v2"  # invalide cache antigo ao mudar scanner/regras

def _with_singleflight(lock_path, produce, wait_result, timeout_s=120):
    """
    Singleflight por arquivo de lock.

    POR QUE: sem isso, três agentes parando juntos erram o mesmo cache ao mesmo
    tempo e disparam três varreduras idênticas — exatamente o custo que o cache
    existe pra evitar. Aqui o primeiro que cria o lock é o dono e executa
    `produce()`; os demais esperam o resultado em vez de duplicar trabalho.

    Regras:
      - Lock via os.open(..., O_CREAT | O_EXCL). Conseguiu -> dono.
      - Dono: executa produce(), grava resultado, remove lock, devolve.
      - Não-dono: laço de espera chamando wait_result() a cada 100 ms até
        resultado não-None ou estourar timeout_s. Se estourar, executa produce()
        mesmo assim (melhor duplicar trabalho do que travar um agente pra sempre).
      - Lock órfão: se o arquivo existir e tiver mtime mais velho que timeout_s,
        remove e assume a propriedade.
      - Lock é SEMPRE removido no finally, inclusive se produce() lançar.
    """
    poll_interval = 0.1  # 100 ms
    deadline = time.monotonic() + timeout_s

    while True:
        # O dono pode ter acabado de publicar o resultado e removido o lock.
        # Ler ANTES de tentar virar dono evita uma segunda execução nessa janela.
        result = wait_result()
        if result is not None:
            return result

        fd = None
        try:
            fd = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600)
        except FileExistsError:
            # mtime usa relógio de parede; comparar com monotonic tornava todo lock
            # órfão "jovem" para sempre.
            try:
                if time.time() - os.stat(lock_path).st_mtime > timeout_s:
                    os.unlink(lock_path)
                    continue
            except FileNotFoundError:
                continue
            except OSError:
                pass

            if time.monotonic() >= deadline:
                # Disponibilidade vence depois do teto: executa sem compartilhar.
                return produce()
            time.sleep(poll_interval)
            continue
        except OSError:
            # Diretório sem permissão/FS incomum: cache é otimização, não requisito.
            return produce()

        try:
            return produce()
        finally:
            if fd is not None:
                try:
                    os.close(fd)
                except OSError:
                    pass
            try:
                os.unlink(lock_path)
            except OSError:
                pass

def tree_fingerprint(cwd, base=""):
    """
    Fingerprint que inclui CONTEÚDO, não só nomes/estados.

    POR QUE: o furo real era confiar só em `git rev-parse HEAD` + `git status --porcelain=v1`.
    Sequência que passava despercebida:
      1. arquivo.ts é modificado -> aparece como ' M';
      2. hook escaneia e grava cache;
      3. o agente ADICIONA UM SEGREDO no mesmo arquivo;
      4. o arquivo continua aparecendo como ' M' (porcelain idêntico);
      5. fingerprint não muda e o veredito antigo é servido por até 15 minutos,
         escondendo o segredo recém-introduzido.
    Agora o hash depende do conteúdo real do working tree e do staged, além do
    HEAD, dos arquivos untracked (hash do conteúdo, não só do nome), da base do
    review e da versão dos scanners. Qualquer erro de git -> devolve "" (cache
    desligado): nunca servimos resultado sem saber o estado real.
    """
    def _git_ok(args):
        # Roda git; devolve (ok, stdout_bytes). Qualquer falha -> ok=False.
        try:
            p = subprocess.run(
                ["git", "-C", cwd] + args,
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                check=False,
            )
            return (p.returncode == 0, p.stdout)
        except Exception:
            return (False, b"")

    h = hashlib.sha256()
    h.update(SCANNERS_VERSION.encode("utf-8", "replace"))
    h.update(b"\x00base=")
    h.update((base or "").encode("utf-8", "replace"))

    if base:
        ok, out = _git_ok(["rev-parse", f"{base}^{{commit}}"])
        if not ok:
            return ""
        h.update(b"\x00base-oid=")
        h.update(out)

    # HEAD do repositório.
    ok, out = _git_ok(["rev-parse", "HEAD"])
    if not ok:
        return ""  # sem saber o HEAD, não confiamos no cache.
    h.update(b"\x00head=")
    h.update(out)

    # Conteúdo do working tree vs HEAD (não só o estado 'M').
    # diff --binary captura alterações binárias também; se houver erro, desliga cache.
    ok, out = _git_ok(["diff", "--no-ext-diff", "--binary", "HEAD", "--"])
    if not ok:
        return ""
    h.update(b"\nwdiff-head-len=")
    h.update(str(len(out)).encode("ascii", "replace"))
    h.update(b"\n")
    h.update(out)

    # Conteúdo staged (index vs HEAD): pode abrigar segredo adicionado em staging.
    ok, out = _git_ok(["diff", "--no-ext-diff", "--binary", "--cached", "--"])
    if not ok:
        return ""
    h.update(b"\ncdiff-len=")
    h.update(str(len(out)).encode("ascii", "replace"))
    h.update(b"\n")
    h.update(out)

    # Arquivos untracked: precisamos do hash do CONTEÚDO, não só do nome.
    ok, out = _git_ok(["ls-files", "--others", "--exclude-standard", "-z"])
    if not ok:
        return ""
    untracked = [os.fsdecode(raw) for raw in out.split(b"\0") if raw]

    max_untracked = 200
    if len(untracked) > max_untracked:
        # Truncar permitiria que o 201º arquivo mudasse sem invalidar o cache.
        return ""

    for name in untracked:
        # Normalizamos o nome para o hash; o conteúdo entra em blocos de 64 KB.
        h.update(b"\nuntracked-name=")
        h.update(name.encode("utf-8", "replace"))
        h.update(b"\n")
        full = os.path.join(cwd, name)
        try:
            with open(full, "rb") as f:
                while True:
                    chunk = f.read(65536)  # 64 KB
                    if not chunk:
                        break
                    h.update(chunk)
        except OSError:
            return ""
        h.update(b"\n")

    return h.hexdigest()
def cache_get(cwd, fingerprint, scope_key):
    """Devolve o payload só se fingerprint bater E TTL <= 900s (15 min).
    Erro de leitura/JSON -> None (falha-aberto: revisa de novo). fingerprint
    vazio -> None (cache desligado). scope_key distinto é arquivo distinto,
    então resultado de diff nunca vira full."""
    if not fingerprint:
        return None
    key = hashlib.sha1(cwd.encode()).hexdigest()
    path = os.path.join(_cache_dir(), f"{key}-{scope_key}.json")
    try:
        with open(path, "r") as f:
            rec = json.load(f)
        if rec.get("fingerprint") != fingerprint:
            return None
        if time.time() - float(rec.get("at", 0)) > 900:
            return None
        payload = rec.get("payload")
        if (
            isinstance(payload, list)
            and len(payload) == 2
            and isinstance(payload[0], list)
            and isinstance(payload[1], list)
        ):
            return payload[0], payload[1]
        return None
    except Exception:
        return None


def cache_put(cwd, fingerprint, scope_key, payload):
    """Best-effort: cria o diretório, grava JSON. Erro de escrita NÃO pode
    derrubar o review. fingerprint vazio -> no-op (cache desligado)."""
    if not fingerprint:
        return
    tmp_path = None
    try:
        d = _cache_dir()
        os.makedirs(d, mode=0o700, exist_ok=True)
        key = hashlib.sha1(cwd.encode()).hexdigest()
        path = os.path.join(d, f"{key}-{scope_key}.json")
        fd, tmp_path = tempfile.mkstemp(prefix=f".{key}-{scope_key}-", dir=d)
        os.fchmod(fd, 0o600)
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"fingerprint": fingerprint, "at": time.time(),
                       "payload": payload}, f)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp_path, path)
        tmp_path = None
    except Exception:
        pass
    finally:
        if tmp_path:
            try:
                os.remove(tmp_path)
            except OSError:
                pass


# ── NOVO: estágio de segurança com escopo + cache (fiação do review) ─────────
def _security_stage(cwd, base, hook_mode):
    """
    Estágio de segurança: usa fingerprint de conteúdo e singleflight no modo hook.

    POR QUE: o cache por fingerprint só é válido se o fingerprint capturar o
    conteúdo (ver tree_fingerprint). Além disso, no modo hook vários processos
    podem bater no mesmo cache ao mesmo tempo; envolvemos escanear+gravar em
    _with_singleflight, com wait_result sendo uma releitura do cache. O caminho
    sem cache (fingerprint vazio) NÃO usa lock — sem fingerprint não há o que
    compartilhar, e travar seria só custo extra.
    """
    if not hook_mode:
        return security_gates(cwd, None), "full"

    scope_key = "diff"
    fp = tree_fingerprint(cwd, base)
    if fp:
        cached = cache_get(cwd, fp, scope_key)
        if cached is not None:
            return cached, scope_key

    files = _changed_files(cwd, base)

    def _produce():
        if files is None:
            result = security_gates(cwd, None)
            result[1].insert(
                0,
                "security: escopo do diff indisponível; árvore inteira escaneada",
            )
        else:
            result = security_gates(cwd, files)
        if fp:
            cache_put(cwd, fp, scope_key, result)
        return result

    if not fp:
        return _produce(), scope_key

    cache_dir = _cache_dir()
    try:
        os.makedirs(cache_dir, mode=0o700, exist_ok=True)
    except OSError:
        return _produce(), scope_key

    cwd_key = hashlib.sha1(cwd.encode()).hexdigest()
    lock_path = os.path.join(cache_dir, f"{cwd_key}-{scope_key}-{fp}.lock")
    result = _with_singleflight(
        lock_path,
        produce=_produce,
        wait_result=lambda: cache_get(cwd, fp, scope_key),
        timeout_s=120,
    )
    return result, scope_key


def security_gates(cwd, scope_files=None):
    """Estágio 1 espelhado do Rust (mcp/tools.rs): gitleaks + semgrep.
    scope_files=None -> árvore toda (review manual/CI). "Segredo em qualquer
    lugar é segredo, mesmo em código não tocado pelo diff" — padrão preservado.
    scope_files=[]   -> diff vazio: devolve ([], []) sem invocar scanner nenhum.
    scope_files=[..] -> escopa ao diff. gitleaks por arquivo (teto 40); semgrep
                       numa invocação com lista. Deletados são filtrados (não
                       existem no disco). Degrada SEMPRE limpo, nunca levanta."""
    findings, skipped = [], []
    if not cwd or not os.path.isdir(cwd):
        return findings, skipped

    # Padrão: árvore toda (review manual/CI). Mantém exatamente o comportamento
    # anterior — a varredura completa existe de propósito.
    if scope_files is None:
        _gitleaks_gate(cwd, findings, skipped)
        _semgrep_gate(cwd, findings, skipped)
        return findings, skipped

    # Diff vazio: nada a escanear. Sem scanner, sem skipped.
    if not scope_files:
        return findings, skipped

    # Filtra arquivos deletados no diff (não há mais no disco pra escanear).
    files = [p for p in scope_files if os.path.exists(os.path.join(cwd, p))]
    if not files:
        return findings, skipped

    # gitleaks: teto de 40 arquivos. Acima disso, cai pra árvore toda e REGISTRA
    # o motivo em skipped — honestidade sobre o que realmente foi feito.
    if len(files) > _GITLEAKS_MAX_FILES:
        skipped.append(
            f"security: escopo diff grande demais ({len(files)} arquivos > "
            f"{_GITLEAKS_MAX_FILES}); gitleaks voltou para a árvore toda "
            f"(68,5 s medidos na árvore completa). semgrep segue escopado."
        )
        _gitleaks_gate(cwd, findings, skipped)  # árvore toda
        _semgrep_gate(cwd, findings, skipped, [os.path.join(cwd, f) for f in files])
        return findings, skipped

    # gitleaks não aceita lista: uma invocação por arquivo, com os MESMOS argumentos.
    for rel in files:
        _gitleaks_gate(cwd, findings, skipped, os.path.join(cwd, rel))
    _semgrep_gate(cwd, findings, skipped, [os.path.join(cwd, f) for f in files])
    return findings, skipped

def _anti_patterns_scanner():
    """Path do scanner, robusto: relativo ao PRÓPRIO local-review.py (não hardcode)."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "omnirift-anti-patterns.py")


def changed_lines(diff_text):
    """Mapa {path relativo -> set(linhas ADICIONADAS)} a partir de um diff unificado.

    Escopa o gate de error-handling ao que o diff realmente introduziu. Sem isto o
    scanner varre a arvore inteira e reporta o passivo do codebase como se fosse
    novo — foi o que gerou 188 CRITICAL num review onde so 1 era real (186 eram
    `catch {}` que existem na main ha meses).

    NAO vale pros gates de SEGURANCA: segredo em qualquer lugar e segredo, mesmo em
    codigo nao tocado pelo diff. So divida de estilo e escopada ao novo.

    O contador so avanca DENTRO de um hunk (`in_hunk`), senao metadados entre
    arquivos (`diff --git`, `index`) deslocariam a numeracao do proximo arquivo.
    """
    out, path, newno, in_hunk = {}, None, 0, False
    for ln in (diff_text or "").splitlines():
        # Cabecalho SO fora de hunk: dentro do hunk, uma linha de conteudo removida
        # que comeca com "-- " vira "--- ..." (prefixo do diff) e seria confundida
        # com header — desativando o hunk e PERDENDO as linhas adicionadas seguintes.
        # Frontmatter markdown (---) dispara isso na hora.
        if not in_hunk and (ln.startswith("diff --git ") or ln.startswith("--- ")):
            continue
        if not in_hunk and ln.startswith("+++ "):
            p = ln[4:].strip()
            if p.startswith("b/"):
                p = p[2:]
            path = None if p == "/dev/null" else p
            newno, in_hunk = 0, False
            continue
        if ln.startswith("@@"):
            try:
                newpart = ln.split("+", 1)[1].split("@@", 1)[0].strip()
                newno = int(newpart.split(",", 1)[0])
                in_hunk = True
            except Exception:
                newno, in_hunk = 0, False
            continue
        if not in_hunk or path is None or newno <= 0:
            continue
        if ln.startswith("\\"):
            continue  # "\ No newline at end of file" nao e linha de conteudo
        if ln.startswith("+"):
            out.setdefault(path, set()).add(newno)
            newno += 1
        elif ln.startswith("-"):
            pass  # linha removida nao avanca o contador do lado novo
        else:
            newno += 1
    return out


def _in_changed(changed, file_path, line):
    """O achado caiu numa linha ADICIONADA pelo diff?

    Compara por sufixo porque o scanner pode devolver path absoluto enquanto o git
    devolve relativo a raiz do repo. O scanner roda sobre a MESMA arvore de onde o
    diff foi tirado, entao os numeros de linha batem (nao ha deslocamento).
    """
    if not changed:
        return False
    try:
        line = int(line or 0)
    except Exception:
        return False
    if line <= 0:
        return False
    fp = str(file_path or "").replace("\\", "/")
    for path, lines in changed.items():
        p = path.replace("\\", "/")
        if fp == p or fp.endswith("/" + p):
            return line in lines
    return False


def error_handling_gate(cwd, changed=None):
    """Roda `omnirift-anti-patterns.py --json <cwd>` e converte os achados pro
    MESMO formato dos findings do review ({severity, category, file, title,
    suggestion}). Devolve (findings, skipped). Nunca levanta — degrada limpo
    (scanner/python ausente, timeout ou saída não-JSON → skipped)."""
    findings, skipped = [], []
    if not cwd or not os.path.isdir(cwd):
        return findings, skipped
    scanner = _anti_patterns_scanner()
    if not os.path.isfile(scanner):
        skipped.append("anti-patterns: scanner ausente")
        return findings, skipped
    # Escopa o scanner aos ARQUIVOS do diff em vez de varrer a árvore e filtrar
    # depois: medido em 18,4s no repo de 11 GB do usuário, por parada de agente.
    # O scanner aceita paths posicionais. Sem `changed` (review manual/CI) segue
    # varrendo tudo — lá o custo é pago uma vez, não a cada turno.
    alvos = []
    if changed:
        alvos = [
            os.path.join(cwd, rel)
            for rel in changed
            if os.path.isfile(os.path.join(cwd, rel))
        ]
    cmd = [sys.executable or "python3", scanner, "--json"] + (alvos or [cwd])
    try:
        out = subprocess.run(cmd, capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        skipped.append("anti-patterns: interpretador python ausente")
        return findings, skipped
    except subprocess.TimeoutExpired:
        skipped.append("anti-patterns: timeout após 60s")
        return findings, skipped
    except Exception as e:  # qualquer falha de execução = NEUTRAL (não bloqueia)
        skipped.append(f"anti-patterns: {e}")
        return findings, skipped
    try:
        data = json.loads((out.stdout or "").strip())
    except Exception:
        err = (out.stderr or "").strip().splitlines()
        snip = (err[-1] if err else "saída não-JSON")[:100]
        skipped.append(f"anti-patterns: saída inconclusiva ({snip})")
        return findings, skipped
    raw = data.get("findings") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        skipped.append("anti-patterns: saída inconclusiva (sem findings)")
        return findings, skipped
    for f in raw:
        if not isinstance(f, dict):
            continue
        sev = str(f.get("severity") or "").upper()
        if sev not in ("CRITICAL", "WARNING"):
            continue
        file = str(f.get("file") or "?")
        line = f.get("line") or 0
        # SO reporta divida introduzida por ESTE diff. O scanner varre a arvore
        # inteira; sem este filtro o passivo do codebase (que a main tambem tem)
        # vira CRITICAL em toda review e o gate fica inutil de tanto ruido.
        if changed is not None and not _in_changed(changed, file, line):
            continue
        rule = str(f.get("rule") or "anti-pattern")
        snippet = str(f.get("snippet") or "").strip()
        phrase = _EH_RULE_TITLES.get(rule, "anti-padrão de tratamento de erro")
        title = f"{phrase} [{rule}]"
        if snippet:
            title += f": {snippet[:80]}"
        findings.append({
            "severity": sev, "category": "error-handling",
            "file": f"{file}:{line}",
            "title": title, "suggestion": _EH_SUGGESTION,
        })
    return findings, skipped


def _llm_timeout_seconds(llm, hook_mode=False):
    """Orçamento da chamada LLM; Stop hook nunca pode herdar 180 s."""
    key = "hookTimeoutSeconds" if hook_mode else "timeoutSeconds"
    default = 12.0 if hook_mode else 180.0
    try:
        value = float(llm.get(key, default))
    except (TypeError, ValueError):
        value = default
    # O hook participa do ciclo de parada do agente: limite rígido e curto.
    ceiling = 30.0 if hook_mode else 600.0
    return max(1.0, min(value, ceiling))


def llm_call(llm, system, prompt, timeout_s=180):
    base = (llm.get("baseUrl") or "").rstrip("/")
    provider = llm.get("provider") or "openai"
    key = (llm.get("apiKey") or "").strip()
    model = llm.get("model") or ""
    if provider == "anthropic":
        url = f"{base}/v1/messages"
        headers = {"x-api-key": key, "anthropic-version": "2023-06-01", "Content-Type": "application/json"}
        body = {"model": model, "max_tokens": 4096, "system": system, "messages": [{"role": "user", "content": prompt}]}
        ptr = lambda r: r.get("content", [{}])[0].get("text", "")
    elif provider == "ollama":
        url = f"{base}/api/chat"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}], "stream": False}
        ptr = lambda r: r.get("message", {}).get("content", "")
    else:  # openai-compat
        url = f"{base}/chat/completions"
        headers = {"Content-Type": "application/json"}
        if key:
            headers["Authorization"] = f"Bearer {key}"
        body = {"model": model, "messages": [{"role": "system", "content": system}, {"role": "user", "content": prompt}], "temperature": 0.1}
        ptr = lambda r: r.get("choices", [{}])[0].get("message", {}).get("content", "")
    req = urllib.request.Request(url, data=json.dumps(body).encode(), method="POST", headers=headers)
    resp = json.loads(urllib.request.urlopen(req, timeout=timeout_s).read())
    return ptr(resp)


def ai_review(diff_text, llm, policy, timeout_s=180):
    cats = "\n".join(f"- {k} ({label}, peso {w}{', bloqueante' if b else ''})" for k, label, w, b in DEFAULT_CATEGORIES)
    extra = policy.get("contracts") or ""
    try:
        if os.path.exists(".forgejo/review-context.md"):
            extra = open(".forgejo/review-context.md", encoding="utf-8").read()[:4000] + "\n\n" + extra
    except Exception:
        pass
    system = "Você é um revisor de código sênior, rigoroso. Responda SOMENTE com um array JSON válido, sem prosa."
    prompt = (
        f"Revise o diff nestas categorias (avalie todas, profundidade alvo {policy.get('coverage', 80)}%):\n{cats}\n\n"
        + (f"Regras/contratos do projeto a CUMPRIR:\n{extra}\n\n" if extra.strip() else "")
        + "Para CADA problema gere: "
        '{"severity":"CRITICAL|WARNING|INFO","category":"<chave>","file":"<caminho>","line":<num|null>,"title":"<curto>","suggestion":"<fix>"}\n'
        "Responda APENAS o array JSON (use [] se não houver).\n\nDIFF:\n" + diff_text[:60000]
    )
    try:
        text = llm_call(llm, system, prompt, timeout_s=timeout_s)
    except Exception as e:
        return None, str(e)
    m = re.search(r"\[[\s\S]*\]", text or "")
    if not m:
        return [], None
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return [], None
    out = []
    for x in arr if isinstance(arr, list) else []:
        if isinstance(x, dict) and x.get("title"):
            sev = x.get("severity") if x.get("severity") in ("CRITICAL", "WARNING", "INFO") else "INFO"
            out.append({"severity": sev, "category": str(x.get("category", "quality")), "file": str(x.get("file", "?")), "title": str(x.get("title")), "suggestion": x.get("suggestion")})
    return out, None


def decide(findings, policy):
    th = policy.get("thresholds", {})
    blocking = {k for k, _l, _w, b in DEFAULT_CATEGORIES if b}  # categorias bloqueantes (Segurança)
    crit = [f for f in findings if f["severity"] == "CRITICAL"]
    warn = [f for f in findings if f["severity"] == "WARNING"]
    # Gate original (respeita a política): só CRITICAL de categoria bloqueante
    # (Segurança) derruba, honrando o maxCritical configurado.
    bc = [f for f in crit if f.get("category") in blocking]
    prev_blocked = len(bc) > th.get("maxCritical", 0)
    # Reforço espelhado do lado Rust (mcp/tools.rs::decide_go_nogo): 1+ CRITICAL OU
    # 2+ WARNING = NO-GO. A união com prev_blocked só ENDURECE o gate — um NO-GO que
    # já existia NUNCA é rebaixado (FPs de design reconhecidos já saíram via SUPPRESS,
    # e o gate de segurança determinístico [gitleaks/semgrep] não passa por supressão).
    rust_blocked = len(crit) >= 1 or len(warn) >= 2
    blocked = prev_blocked or rust_blocked
    return ("NO-GO" if blocked else "GO"), len(crit), len(warn)


def render(findings, verdict, crit, warn):
    lines = [f"code-review — {verdict} ({crit} CRITICAL · {warn} WARNING · {len(findings)} achados)"]
    for sev in ("CRITICAL", "WARNING", "INFO"):
        items = [f for f in findings if f["severity"] == sev]
        for f in items:
            sug = f" → {f['suggestion']}" if f.get("suggestion") else ""
            lines.append(f"  [{sev}/{f['category']}] {f['file']}: {f['title']}{sug}")
    return "\n".join(lines)


def review(cwd, config_path, base, hook_mode=False):
    base = base or detect_base(cwd)
    cfg = load_config(config_path)
    llm = cfg.get("llm")
    policy = pick_policy(cfg, cwd)
    # Estágio 1 — gates determinísticos sobre o WORKING TREE, mesmo sem diff:
    #   • segurança (gitleaks + semgrep) — espelha mcp/tools.rs::run_preflight;
    #   • error-handling (omnirift-anti-patterns.py, gate 8 do marketplace).
    # Ambos degradam limpo (ferramenta/scanner ausente ou timeout → skipped).
    # hook_mode escopa ao diff + cacheia por fingerprint: o Stop hook roda a CADA
    # parada de agente, e a arvore inteira custava 68,5s (gitleaks) + 20,3s (semgrep)
    # medidos num repo de 11 GB — por turno, e multiplicado por agente que para junto.
    (sec_findings, sec_skipped), _scope_key = _security_stage(cwd, base, hook_mode)
    # Diff ANTES do gate de error-handling: ele so reporta o que o diff ADICIONOU
    # (divida de estilo). Segurança é completa no review manual/CI e escopada ao
    # diff no Stop hook; falha ao descobrir o escopo volta para a árvore inteira.
    diff = git_diff(cwd, base)
    eh_findings, eh_skipped = error_handling_gate(cwd, changed_lines(diff))
    det_findings = sec_findings + eh_findings  # gates determinísticos consolidados
    det_skipped = sec_skipped + eh_skipped
    if not diff.strip():
        # Sem diff, mas os gates determinísticos ainda valem (secret / anti-padrão
        # podem estar no working tree não commitado). Se limpos, mantém o GO
        # "nada a revisar" de antes.
        verdict, crit, warn = decide(det_findings, policy)
        summary = render(det_findings, verdict, crit, warn) if det_findings else "sem diff — nada a revisar"
        return {"verdict": verdict, "crit": crit, "warn": warn, "findings": det_findings, "summary": summary, "llmError": None, "skipped": det_skipped, "policy": policy}
    findings = preflight(diff, policy)
    llm_err = None
    if llm and (llm.get("model")):
        ai, llm_err = ai_review(
            diff,
            llm,
            policy,
            timeout_s=_llm_timeout_seconds(llm, hook_mode),
        )
        if ai:
            findings += ai
    findings += pathrule_findings(diff, load_pathrules(cwd))  # regras por path
    findings = [f for f in findings if not suppressed(f, load_extra_suppress(cwd))]  # FPs ACK
    findings += det_findings  # gates determinísticos: NÃO passam pela supressão de FP-de-IA
    verdict, crit, warn = decide(findings, policy)
    return {"verdict": verdict, "crit": crit, "warn": warn, "findings": findings, "summary": render(findings, verdict, crit, warn), "llmError": llm_err, "skipped": det_skipped, "policy": policy}


def default_config_path():
    return os.environ.get("MAESTRI_REVIEW_CONFIG") or os.path.expanduser(
        "~/.local/share/com.omniforge.omnirift/review-config.json"
    )


def run_hook(config_path):
    """Modo Stop hook: lê o input do Claude Code no stdin e bloqueia em NO-GO.
    Respeita ambas as guardas anti-loop documentadas (stop_hook_active booleano
    da doc oficial OU stop_hook_active_count numérico)."""
    try:
        data = json.load(sys.stdin)
    except Exception:
        data = {}
    # guarda anti-loop: se já bloqueamos uma vez, deixa parar agora
    if data.get("stop_hook_active") or (data.get("stop_hook_active_count") or 0) >= 1:
        return 0
    cwd = data.get("cwd") or os.getcwd()
    try:
        r = review(cwd, config_path, os.environ.get("MAESTRI_REVIEW_BASE", ""), hook_mode=True)
    except Exception as e:
        # erro de infra → não bloqueia (NEUTRAL)
        sys.stderr.write(f"local-review: erro {e}\n")
        return 0
    pol = r.get("policy", {})
    # respeita a policy: desligada ou gate "off" não bloqueiam o agente
    if not pol.get("enabled", True) or pol.get("gate", "warn") == "off":
        return 0
    if r["verdict"] != "NO-GO":
        return 0
    # Schema oficial do Stop hook: {"decision":"block","reason":...} com exit 0.
    # `reason` é realimentado ao modelo como próxima instrução. NÃO usar
    # `continue:false` aqui — isso ENCERRARIA o Claude inteiro (queremos o oposto:
    # que ele continue trabalhando e corrija).
    reason = (
        "Code review reprovou (NO-GO) — você NÃO pode encerrar ainda. "
        "Corrija os pontos abaixo e só então finalize:\n" + r["summary"][:1800]
    )
    print(json.dumps({"decision": "block", "reason": reason}, ensure_ascii=False))
    return 0


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cwd", default=os.getcwd())
    ap.add_argument("--config", default=default_config_path())
    ap.add_argument("--base", default="")
    ap.add_argument("--hook", action="store_true", help="modo Stop hook (lê stdin, bloqueia em NO-GO)")
    args = ap.parse_args()
    if args.hook:
        return run_hook(args.config)
    r = review(args.cwd, args.config, args.base)
    print(json.dumps(r, ensure_ascii=False))
    return 1 if r["verdict"] == "NO-GO" else 0


if __name__ == "__main__":
    sys.exit(main())
