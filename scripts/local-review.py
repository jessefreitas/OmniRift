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
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
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


def _gitleaks_gate(cwd, findings, skipped):
    """gitleaks --no-git (só o working tree), report JSON em arquivo temp. Cada leak =
    1 CRITICAL `security` (arquivo:linha + RuleID). Fallback: exit 1 sem report legível
    = 1 CRITICAL genérico (não perde o gate). Ausente/erro/inconclusivo → skipped."""
    fd, report_path = tempfile.mkstemp(prefix="omnirift-gitleaks-", suffix=".json")
    os.close(fd)
    cmd = [
        "gitleaks", "detect", "--source", cwd, "--no-git", "--redact",
        "--report-format", "json", "--report-path", report_path, "--exit-code", "1",
    ]
    kind, out = _run_tool(cmd, 60)
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


def _semgrep_gate(cwd, findings, skipped):
    """semgrep p/security-audit + p/secrets (severity ERROR), saída --json. ERROR →
    CRITICAL, senão WARNING; file `arquivo:linha [regra]`. Saída não-JSON (falha de
    rede/download de regras) / ausente / timeout → skipped (NEUTRAL)."""
    cmd = [
        "semgrep", "scan", "--config", "p/security-audit", "--config", "p/secrets",
        "--severity", "ERROR", "--error", "--json", "--quiet", "--metrics=off",
        "--disable-version-check", cwd,
    ]
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


def security_gates(cwd):
    """Estágio 1 espelhado do Rust (mcp/tools.rs): gitleaks + semgrep sobre o working
    tree do cwd. Devolve (findings, skipped). Nunca levanta — degrada limpo se as
    ferramentas faltarem/demorarem, pra jamais derrubar o review por infra."""
    findings, skipped = [], []
    if not cwd or not os.path.isdir(cwd):
        return findings, skipped
    _gitleaks_gate(cwd, findings, skipped)
    _semgrep_gate(cwd, findings, skipped)
    return findings, skipped


# ── Estágio 1 · gate de error-handling (complementa o de segurança) ─────────────
#
# Espelho conceitual do gate de segurança acima, mas para anti-padrões de
# TRATAMENTO DE ERRO (except vazio, catch vazio, swallow silencioso). Roda o
# scanner AST portado do marketplace OmniForge (`omnirift-anti-patterns.py`, gate
# 8) sobre o WORKING TREE do cwd — o mesmo alvo do gate de segurança. CRITICAL do
# scanner → CRITICAL; WARNING → WARNING; category="error-handling". Degrada SEMPRE
# limpo: scanner ausente / interpretador ausente / timeout / JSON inválido =
# registrado em `skipped` (NEUTRAL — não vira finding e não bloqueia o review).

# rule do scanner → frase legível para o campo `title`.
_EH_RULE_TITLES = {
    "except-pass": "except vazio (pass/…) engole o erro",
    "bare-except-swallow": "bare except sem log nem re-raise engole tudo",
    "empty-catch": "catch vazio engole o erro",
    "empty-promise-catch": ".catch(() => {}) engole a rejeição",
    "bare-except-log-only": "bare except só loga (sem re-raise)",
    "broad-except-log-continue": "except Exception loga e segue (sem re-raise)",
    "broad-except-swallow": "except amplo engole sem contexto",
    "catch-log-only": "catch só loga (sem rethrow)",
    "catch-swallow": "catch engole o erro sem usar/relançar",
    "promise-catch-log-only": ".catch() só loga (sem rethrow)",
    "promise-catch-swallow": ".catch() engole a rejeição",
}
_EH_SUGGESTION = (
    "Trate, re-lance (raise/throw) ou registre com contexto; "
    "ou marque `# anti-pattern: allow <razão>` (`//` em TS/JS)."
)


def _anti_patterns_scanner():
    """Path do scanner, robusto: relativo ao PRÓPRIO local-review.py (não hardcode)."""
    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "omnirift-anti-patterns.py")


def error_handling_gate(cwd):
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
    cmd = [sys.executable or "python3", scanner, "--json", cwd]
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


def llm_call(llm, system, prompt):
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
    resp = json.loads(urllib.request.urlopen(req, timeout=180).read())
    return ptr(resp)


def ai_review(diff_text, llm, policy):
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
        text = llm_call(llm, system, prompt)
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


def review(cwd, config_path, base):
    cfg = load_config(config_path)
    llm = cfg.get("llm")
    policy = pick_policy(cfg, cwd)
    # Estágio 1 — gates determinísticos sobre o WORKING TREE, mesmo sem diff:
    #   • segurança (gitleaks + semgrep) — espelha mcp/tools.rs::run_preflight;
    #   • error-handling (omnirift-anti-patterns.py, gate 8 do marketplace).
    # Ambos degradam limpo (ferramenta/scanner ausente ou timeout → skipped).
    sec_findings, sec_skipped = security_gates(cwd)
    eh_findings, eh_skipped = error_handling_gate(cwd)
    det_findings = sec_findings + eh_findings  # gates determinísticos consolidados
    det_skipped = sec_skipped + eh_skipped
    diff = git_diff(cwd, base)
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
        ai, llm_err = ai_review(diff, llm, policy)
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
        r = review(cwd, config_path, os.environ.get("MAESTRI_REVIEW_BASE", ""))
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
