#!/usr/bin/env python3
"""code-review-ai — review de PR via Ollama Cloud (qwen3-coder) no Forgejo Actions.

2 estágios: (1) pre-flight determinístico (secrets/padrões perigosos/tamanho);
(2) review IA com as 6 categorias + pesos. Decisão GO/NO-GO (1+ CRITICAL ou
2+ WARNING bloqueia). Posta um comentário no PR e seta o commit status (gate).

Env esperado (Forgejo Actions seta os GITHUB_* mimetizando GH Actions):
  OLLAMA_API_KEY      — chave do Ollama Cloud (secret do repo)
  FORGEJO_TOKEN       — token p/ postar comentário/status (secret; ou GITHUB_TOKEN)
  GITHUB_SERVER_URL   — base do Forgejo (ex: https://git.omnimemory.com.br)
  GITHUB_REPOSITORY   — owner/repo
  GITHUB_EVENT_PATH   — JSON do evento (pra pegar nº do PR, base, head sha)
"""
import json
import os
import re
import subprocess
import sys
import urllib.request
import urllib.error

OLLAMA_URL = "https://ollama.com/api/chat"
MODEL = os.environ.get("REVIEW_MODEL", "qwen3-coder:480b-cloud")

CATEGORIES = [
    ("security", "Segurança", 10, True),
    ("quality", "Qualidade", 7, False),
    ("performance", "Performance", 6, False),
    ("testing", "Testes", 5, False),
    ("architecture", "Arquitetura", 4, False),
    ("style", "Estilo", 2, False),
]

# ── Estágio 1 — pre-flight determinístico ──────────────────────────────────────
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


def read_context():
    """Contexto de design committed (.forgejo/review-context.md) — informa o reviewer
    sobre decisões intencionais pra evitar falso-positivo."""
    p = ".forgejo/review-context.md"
    try:
        if os.path.exists(p):
            return open(p, encoding="utf-8").read()[:4000]
    except Exception:
        pass
    return ""


# Achados RECONHECIDOS como aceitos (design intencional documentado em
# .forgejo/review-context.md). A IA é volátil na severidade desses itens, então a
# supressão é DETERMINÍSTICA (accepted-risk). Casa por arquivo + palavra no título.
# Um achado NOVO/diferente nesses arquivos (título sem essas palavras) NÃO é suprimido.
SUPPRESS = [
    ("license.rs", ["públic", "public", "hardcoded", "embutid", "ed25519", "fingerprint", "machine-id", "machine id", "fallback"]),
    ("mcp_servers.rs", ["ofusc", "obfusc", "xor", "credenci", "criptograf", "cifr", "armazen", "repouso", "texto claro", "plaintext", "token"]),
    ("registry.rs", ["ofusc", "obfusc", "xor", "credenci", "criptograf", "cifr", "armazen", "repouso", "texto claro", "plaintext", "token"]),
    ("gitremote.rs", ["injeção", "injection", "vaza", "token", "redig", "sanitiz", "argument"]),
    ("browser.rs", ["injeção", "injection", "sanitiz", "shell", "command", "subprocess"]),
    ("fs.rs", ["limite", "tamanho", "arbitrár"]),
]


def suppressed(f):
    fp = (f.get("file") or "").lower()
    title = (f.get("title") or "").lower()
    return any(fpat in fp and any(k in title for k in kws) for fpat, kws in SUPPRESS)


def preflight(diff_text):
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
    # tamanho de arquivo no diff (heurística: blocos +500 linhas)
    per_file = {}
    cur = None
    for ln in diff_text.splitlines():
        if ln.startswith("+++ b/"):
            cur = ln[6:]
            per_file[cur] = 0
        elif cur and ln.startswith("+") and not ln.startswith("+++"):
            per_file[cur] += 1
    for f, n in per_file.items():
        if n > 500:
            findings.append({"severity": "WARNING", "category": "quality", "file": f, "title": f"arquivo grande no diff (+{n} linhas)", "suggestion": "Considere quebrar em partes menores."})
    return findings


# ── Estágio 2 — review IA ──────────────────────────────────────────────────────
def ai_review(diff_text, key):
    cats = "\n".join(f"- {k} ({label}, peso {w}{', bloqueante' if b else ''})" for k, label, w, b in CATEGORIES)
    system = "Você é um revisor de código sênior, rigoroso. Responda SOMENTE com um array JSON válido, sem prosa."
    ctx = read_context()
    prompt = (
        f"Revise o diff nestas categorias (avalie todas):\n{cats}\n\n"
        + (f"CONTEXTO DE DESIGN do projeto. Os itens listados aqui como intencionais/aceitos JÁ FORAM DECIDIDOS — OMITA-OS por completo do array (NÃO gere objeto algum pra eles, nem WARNING nem INFO, nem pra 'reafirmar' que são ok). Reporte SOMENTE problemas REAIS não cobertos por este contexto:\n{ctx}\n\n" if ctx else "")
        + "Para CADA problema gere: "
        '{"severity":"CRITICAL|WARNING|INFO","category":"<chave>","file":"<caminho>","line":<num|null>,"title":"<curto>","suggestion":"<fix>"}\n'
        "Responda APENAS o array JSON (use [] se não houver).\n\nDIFF:\n" + diff_text[:60000]
    )
    body = json.dumps({"model": MODEL, "messages": [
        {"role": "system", "content": system},
        {"role": "user", "content": prompt},
    ], "stream": False}).encode()
    req = urllib.request.Request(OLLAMA_URL, data=body, method="POST", headers={
        "Authorization": f"Bearer {key}", "Content-Type": "application/json",
    })
    try:
        resp = json.loads(urllib.request.urlopen(req, timeout=180).read())
    except Exception as e:  # rede/timeout → NEUTRAL (não bloqueia)
        print(f"::warning::review IA falhou: {e}")
        return None
    text = resp.get("message", {}).get("content", "")
    m = re.search(r"\[[\s\S]*\]", text)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    out = []
    for x in arr if isinstance(arr, list) else []:
        if isinstance(x, dict) and x.get("title"):
            sev = x.get("severity") if x.get("severity") in ("CRITICAL", "WARNING", "INFO") else "INFO"
            out.append({"severity": sev, "category": str(x.get("category", "quality")), "file": str(x.get("file", "?")), "title": str(x.get("title")), "suggestion": x.get("suggestion")})
    return out


def decide(findings):
    blocking = {k for k, _l, _w, b in CATEGORIES if b}  # categorias bloqueantes (Segurança)
    crit = [f for f in findings if f["severity"] == "CRITICAL"]
    warn = [f for f in findings if f["severity"] == "WARNING"]
    # Gate estável: bloqueia só em CRITICAL de categoria bloqueante (Segurança). WARNINGs
    # de IA são advisory e voláteis — informam, não derrubam o merge. (Falso-positivos
    # de design já reconhecidos são suprimidos antes daqui — ver SUPPRESS.)
    bc = [f for f in crit if f.get("category") in blocking]
    blocked = len(bc) > 0
    return ("NO-GO" if blocked else "GO"), len(crit), len(warn)


def render(findings, verdict, crit, warn):
    lines = [f"## 🤖 code-review-ai — **{verdict}**", "", f"{crit} CRITICAL · {warn} WARNING · {len(findings)} achados", ""]
    if not findings:
        lines.append("✓ Nenhum problema encontrado.")
    for sev in ("CRITICAL", "WARNING", "INFO"):
        items = [f for f in findings if f["severity"] == sev]
        if not items:
            continue
        lines.append(f"### {sev} ({len(items)})")
        for f in items:
            lines.append(f"- **[{f['category']}]** `{f['file']}` — {f['title']}")
            if f.get("suggestion"):
                lines.append(f"  - 💡 {f['suggestion']}")
    return "\n".join(lines)


def post(server, repo, token, pr_num, sha, body, verdict):
    h = {"Authorization": f"token {token}", "Content-Type": "application/json"}
    # comentário no PR
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{server}/api/v1/repos/{repo}/issues/{pr_num}/comments",
            data=json.dumps({"body": body}).encode(), headers=h, method="POST"), timeout=30)
    except Exception as e:
        print(f"::warning::não postou comentário: {e}")
    # commit status (gate)
    state = "success" if verdict == "GO" else "failure"
    try:
        urllib.request.urlopen(urllib.request.Request(
            f"{server}/api/v1/repos/{repo}/statuses/{sha}",
            data=json.dumps({"state": state, "context": "code-review/ai-review", "description": verdict}).encode(),
            headers=h, method="POST"), timeout=30)
    except Exception as e:
        print(f"::warning::não setou status: {e}")


def main():
    key = os.environ.get("OLLAMA_API_KEY", "")
    token = os.environ.get("FORGEJO_TOKEN") or os.environ.get("GITHUB_TOKEN", "")
    server = os.environ.get("GITHUB_SERVER_URL", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    ev_path = os.environ.get("GITHUB_EVENT_PATH", "")
    ev = json.load(open(ev_path)) if ev_path and os.path.exists(ev_path) else {}
    pr = ev.get("pull_request", {})
    pr_num = ev.get("number") or pr.get("number")
    base = pr.get("base", {}).get("ref", "main")
    sha = pr.get("head", {}).get("sha", "")

    subprocess.run(["git", "fetch", "origin", base], check=False)
    diff = subprocess.run(["git", "diff", f"origin/{base}...HEAD"], capture_output=True, text=True).stdout
    if not diff.strip():
        print("sem diff — nada a revisar.")
        return 0

    findings = preflight(diff)
    ai = ai_review(diff, key) if key else None
    if ai is not None:
        findings += ai
    findings = [f for f in findings if not suppressed(f)]  # tira os falso-positivos ACK
    verdict, crit, warn = decide(findings)
    body = render(findings, verdict, crit, warn)
    print(body)
    if token and server and repo and pr_num:
        post(server, repo, token, pr_num, sha, body, verdict)
    return 1 if verdict == "NO-GO" else 0


if __name__ == "__main__":
    sys.exit(main())
