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
import subprocess
import sys
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
    # Gate respeita a política: só categorias bloqueantes derrubam (alinhado ao CI).
    bc = [f for f in crit if f.get("category") in blocking]
    # Gate estável: só CRITICAL de categoria bloqueante (Segurança) derruba; WARNINGs
    # de IA são advisory/voláteis. (FPs de design já reconhecidos são suprimidos — SUPPRESS.)
    blocked = len(bc) > th.get("maxCritical", 0)
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
    diff = git_diff(cwd, base)
    if not diff.strip():
        return {"verdict": "GO", "crit": 0, "warn": 0, "findings": [], "summary": "sem diff — nada a revisar", "llmError": None, "policy": policy}
    findings = preflight(diff, policy)
    llm_err = None
    if llm and (llm.get("model")):
        ai, llm_err = ai_review(diff, llm, policy)
        if ai:
            findings += ai
    findings = [f for f in findings if not suppressed(f, load_extra_suppress(cwd))]  # FPs ACK
    verdict, crit, warn = decide(findings, policy)
    return {"verdict": verdict, "crit": crit, "warn": warn, "findings": findings, "summary": render(findings, verdict, crit, warn), "llmError": llm_err, "policy": policy}


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
