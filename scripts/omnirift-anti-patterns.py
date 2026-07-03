#!/usr/bin/env python3
"""omnirift-anti-patterns.py — scanner de anti-padrões de ERROR-HANDLING.

Origem: portado do marketplace OmniForge `skills_transformers`
(plugins/excellence-core/skills/omniforge-quality-gates — Gate 8,
`gate-anti-patterns.py`). Standalone, stdlib puro. A lógica de detecção é
idêntica à testada no marketplace; só o nome/uso foram adaptados ao OmniRift.
Consumido pelo review headless (`scripts/local-review.py::error_handling_gate`),
que faz a decisão GO/NO-GO — este scanner só reporta.

Detecta anti-padrões de tratamento de erro que engolem falhas em silêncio.

Python (.py/.pyi) é analisado com o módulo `ast` (nunca regex), então a
detecção é estrutural e independe de formatação. TS/JS
(.ts/.tsx/.js/.jsx/.mjs/.cjs) usa uma heurística conservadora ciente de
comentários/strings (strings e comentários são apagados antes do match, então
um `catch` dentro de string/comentário nunca é sinalizado).

Rules
-----
CRITICAL (o erro é silenciado por completo):
  except-pass            Python `except ...:` cujo corpo é só `pass`/`...`
                         (qualquer tipo — bare, broad ou específico).
  bare-except-swallow    Python bare `except:` sem re-raise e sem log,
                         corpo faz algo mas esconde tudo.
  empty-catch            TS/JS `catch {}` / `catch (e) {}` com corpo vazio.
  empty-promise-catch    TS/JS `.catch(() => {})` com callback vazio.

WARNING (frágil — engole ou esconde contexto):
  bare-except-log-only        Python bare `except:` que só loga, sem re-raise.
  broad-except-log-continue   Python `except Exception`/`BaseException` que
                              loga e segue sem re-raise.
  broad-except-swallow        Python broad except sem log e sem re-raise
                              (engole sem contexto).
  catch-log-only              TS/JS catch que só loga, sem rethrow.
  catch-swallow               TS/JS catch que engole sem usar o erro e sem
                              rethrow.
  promise-catch-log-only      TS/JS `.catch()` callback que só loga.
  promise-catch-swallow       TS/JS `.catch()` callback que engole.

Approved overrides
------------------
Um comentário `# anti-pattern: allow <razão>` (Python) ou
`// anti-pattern: allow <razão>` (TS/JS) na linha do `except`/`catch` ou na
linha imediatamente acima (a janela inteira do handler é varrida, então a linha
do `pass`/corpo também funciona) SUPRIME aquele achado. Achados suprimidos são
contados em "allowed", nunca em critical/warning.

Output
------
--json  ->  {"critical": N, "warning": M, "allowed": A, "skipped": S,
             "scanned": F, "findings": [{"file","line","severity","rule",
             "snippet"}, ...]}
default ->  resumo legível + uma linha por achado.

Um arquivo com erro de sintaxe não aborta o scan — é contado em "skipped" e o
processamento continua.

Usage
-----
  omnirift-anti-patterns.py [PATH ...] [--json]
PATH pode ser um diretório (varrido recursivamente) ou um único arquivo.
Default: diretório atual. Exit code: 0 = scan completo, 2 = erro fatal (path
inválido). A decisão de aprovar/reprovar é do chamador (local-review.py).
"""
from __future__ import annotations

import argparse
import ast
import json
import os
import re
import sys

# ── Config ────────────────────────────────────────────────────────────────
PY_EXT = {".py", ".pyi"}
TS_EXT = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"}
EXCLUDE_DIRS = {
    "node_modules", "dist", ".git", "build", ".venv", "venv",
    "__pycache__", ".mypy_cache", ".pytest_cache", "coverage",
    ".next", "out", "vendor", ".tox", "site-packages", ".cache",
}

CRITICAL = "CRITICAL"
WARNING = "WARNING"

# Override marker: "# anti-pattern: allow <reason>" / "// anti-pattern: allow ..."
OVERRIDE_RE = re.compile(r"(?://|/\*|#)\s*anti-pattern:\s*allow\b", re.IGNORECASE)

# Python: attribute-method names that mean "logging happened".
_LOG_METHODS = {
    "debug", "info", "warning", "warn", "error", "exception", "critical",
    "log", "print_exc", "print_exception", "format_exc", "capture_exception",
    "exc_info", "trace",
}
# Python: leftmost identifier of an attribute chain that means "logging".
_LOG_ROOTS = {
    "log", "logger", "logging", "_log", "_logger", "traceback",
    "structlog", "loguru", "sentry_sdk",
}


# ── Small helpers ───────────────────────────────────────────────────────────
def _snippet(lines, lineno):
    idx = lineno - 1
    if 0 <= idx < len(lines):
        return lines[idx].strip()[:160]
    return ""


def _line_of(pos, line_starts):
    # line_starts: sorted list of char offsets where each line begins
    lo, hi = 0, len(line_starts) - 1
    ans = 0
    while lo <= hi:
        mid = (lo + hi) // 2
        if line_starts[mid] <= pos:
            ans = mid
            lo = mid + 1
        else:
            hi = mid - 1
    return ans + 1  # 1-based


def _line_starts(text):
    starts = [0]
    for i, ch in enumerate(text):
        if ch == "\n":
            starts.append(i + 1)
    return starts


# ── Python (AST) ────────────────────────────────────────────────────────────
def _iter_handler_nodes(body):
    """Yield nodes in a handler body without descending into nested
    functions/classes/lambdas (a raise/log inside a nested def does NOT
    count as handling the currently-caught exception)."""
    stack = list(body)
    boundary = (ast.FunctionDef, ast.AsyncFunctionDef, ast.Lambda, ast.ClassDef)
    while stack:
        node = stack.pop()
        yield node
        for child in ast.iter_child_nodes(node):
            if isinstance(child, boundary):
                continue
            stack.append(child)


def _handler_has_raise(handler):
    return any(isinstance(n, ast.Raise) for n in _iter_handler_nodes(handler.body))


def _is_log_call(call):
    func = call.func
    if isinstance(func, ast.Name):
        return func.id == "print"
    if isinstance(func, ast.Attribute):
        if func.attr in _LOG_METHODS:
            return True
        root = func
        while isinstance(root, ast.Attribute):
            root = root.value
        if isinstance(root, ast.Name) and root.id in _LOG_ROOTS:
            return True
    return False


def _handler_has_log(handler):
    return any(
        isinstance(n, ast.Call) and _is_log_call(n)
        for n in _iter_handler_nodes(handler.body)
    )


def _body_only_pass(body):
    """True if the handler body is only pass / ... / bare literal (docstring)."""
    for stmt in body:
        if isinstance(stmt, ast.Pass):
            continue
        if isinstance(stmt, ast.Expr) and isinstance(stmt.value, ast.Constant):
            continue  # bare `...`, bare string, bare number → does nothing
        return False
    return True


def _last_name(node):
    if isinstance(node, ast.Name):
        return node.id
    if isinstance(node, ast.Attribute):
        return node.attr
    return None


def _is_broad(type_node):
    if type_node is None:
        return False
    targets = type_node.elts if isinstance(type_node, ast.Tuple) else [type_node]
    names = {_last_name(t) for t in targets}
    return bool(names & {"Exception", "BaseException"})


def _override_window(lines, handler):
    """Scan from the line above the `except` through the first body line."""
    first_body = handler.body[0].lineno if handler.body else handler.lineno
    for ln in range(handler.lineno - 1, first_body + 1):  # 1-based, inclusive
        idx = ln - 1
        if 0 <= idx < len(lines) and OVERRIDE_RE.search(lines[idx]):
            return True
    return False


def scan_python(path, rel, lines, text, result):
    try:
        tree = ast.parse(text, filename=path)
    except SyntaxError:
        result["skipped"] += 1
        return
    except Exception:  # anti-pattern: allow keep scanning when a file is unparseable
        result["skipped"] += 1
        return

    try_nodes = [ast.Try]
    if hasattr(ast, "TryStar"):
        try_nodes.append(ast.TryStar)
    try_types = tuple(try_nodes)

    for node in ast.walk(tree):
        if not isinstance(node, try_types):
            continue
        for handler in node.handlers:
            finding = _classify_py_handler(handler)
            if finding is None:
                continue
            severity, rule = finding
            if _override_window(lines, handler):
                result["allowed"] += 1
                continue
            _add(result, rel, handler.lineno, severity, rule,
                 _snippet(lines, handler.lineno))


def _classify_py_handler(handler):
    if _handler_has_raise(handler):
        return None  # re-raises → propagates correctly
    is_bare = handler.type is None
    is_broad = _is_broad(handler.type)
    has_log = _handler_has_log(handler)

    if _body_only_pass(handler.body):
        return (CRITICAL, "except-pass")
    if is_bare and not has_log:
        return (CRITICAL, "bare-except-swallow")
    if is_bare and has_log:
        return (WARNING, "bare-except-log-only")
    if is_broad and has_log:
        return (WARNING, "broad-except-log-continue")
    if is_broad and not has_log:
        return (WARNING, "broad-except-swallow")
    return None  # specific exception doing real work → acceptable


# ── TS/JS (comment/string-aware heuristic) ──────────────────────────────────
def _blank_ts(text):
    """Return a copy of `text` with comment and string contents replaced by
    spaces (newlines preserved, length preserved) so `catch` inside a
    string/comment is never matched and brace/paren scanning is reliable."""
    out = []
    i, n = 0, len(text)
    NORMAL, LINE, BLOCK, SQ, DQ, TPL = range(6)
    state = NORMAL
    while i < n:
        c = text[i]
        nxt = text[i + 1] if i + 1 < n else ""
        if state == NORMAL:
            if c == "/" and nxt == "/":
                out.append("  "); i += 2; state = LINE; continue
            if c == "/" and nxt == "*":
                out.append("  "); i += 2; state = BLOCK; continue
            if c == "'":
                out.append(" "); i += 1; state = SQ; continue
            if c == '"':
                out.append(" "); i += 1; state = DQ; continue
            if c == "`":
                out.append(" "); i += 1; state = TPL; continue
            out.append(c); i += 1; continue
        if state == LINE:
            if c == "\n":
                out.append("\n"); i += 1; state = NORMAL; continue
            out.append(" "); i += 1; continue
        if state == BLOCK:
            if c == "*" and nxt == "/":
                out.append("  "); i += 2; state = NORMAL; continue
            out.append("\n" if c == "\n" else " "); i += 1; continue
        if state in (SQ, DQ, TPL):
            quote = {SQ: "'", DQ: '"', TPL: "`"}[state]
            if c == "\\":
                out.append("  "); i += 2; continue
            if c == quote:
                out.append(" "); i += 1; state = NORMAL; continue
            out.append("\n" if c == "\n" else " "); i += 1; continue
    return "".join(out)


def _match_delim(s, open_idx, open_ch, close_ch):
    depth = 0
    k = open_idx
    n = len(s)
    while k < n:
        c = s[k]
        if c == open_ch:
            depth += 1
        elif c == close_ch:
            depth -= 1
            if depth == 0:
                return k
        k += 1
    return -1


def _first_ident(param_text):
    m = re.search(r"[A-Za-z_$][A-Za-z0-9_$]*", param_text)
    return m.group(0) if m else None


def _has_throw(body):
    return bool(re.search(r"\bthrow\b", body)) or "reject(" in body


def _log_only(body):
    if not body.strip():
        return False
    b = re.sub(
        r"\bconsole\s*\.\s*(?:log|error|warn|info|debug|trace)\s*\([^;{}]*\)\s*;?",
        " ", body)
    b = re.sub(r"\b(?:logger|log)\s*\.\s*\w+\s*\([^;{}]*\)\s*;?", " ", b)
    return b.strip() == ""


def _override_ts(lines, kw_line, end_line):
    for ln in range(kw_line - 1, end_line + 1):  # 1-based inclusive
        idx = ln - 1
        if 0 <= idx < len(lines) and OVERRIDE_RE.search(lines[idx]):
            return True
    return False


def scan_ts(path, rel, lines, text, result):
    blank = _blank_ts(text)
    starts = _line_starts(text)

    for m in re.finditer(r"\bcatch\b", blank):
        # method `.catch(` vs statement `catch`?
        j = m.start() - 1
        while j >= 0 and blank[j] in " \t\r\n":
            j -= 1
        is_method = j >= 0 and blank[j] == "."
        kw_line = _line_of(m.start(), starts)
        if is_method:
            _handle_promise_catch(blank, lines, m.end(), kw_line, rel, result)
        else:
            _handle_try_catch(blank, lines, m.end(), kw_line, rel, result)


def _handle_try_catch(blank, lines, i, kw_line, rel, result):
    n = len(blank)
    p = i
    while p < n and blank[p] in " \t\r\n":
        p += 1
    binding = None
    if p < n and blank[p] == "(":
        close = _match_delim(blank, p, "(", ")")
        if close == -1:
            return
        binding = _first_ident(blank[p + 1:close])
        p = close + 1
        while p < n and blank[p] in " \t\r\n":
            p += 1
    if p >= n or blank[p] != "{":
        return
    close_brace = _match_delim(blank, p, "{", "}")
    if close_brace == -1:
        return
    body = blank[p + 1:close_brace]
    finding = _classify_ts_body(body, binding, kind="catch")
    if finding is None:
        return
    severity, rule = finding
    if _override_ts(lines, kw_line, kw_line + 1):
        result["allowed"] += 1
        return
    _add(result, rel, kw_line, severity, rule, _snippet(lines, kw_line))


def _handle_promise_catch(blank, lines, i, kw_line, rel, result):
    n = len(blank)
    p = i
    while p < n and blank[p] in " \t\r\n":
        p += 1
    if p >= n or blank[p] != "(":
        return
    close = _match_delim(blank, p, "(", ")")
    if close == -1:
        return
    cb = blank[p + 1:close]
    # locate a block body inside the callback: `=> {` or `) {`
    bm = re.search(r"(=>|\))\s*\{", cb)
    if not bm:
        return  # expression arrow / bare identifier handler → treat as OK
    brace_local = cb.index("{", bm.start())
    end_local = _match_delim(cb, brace_local, "{", "}")
    if end_local == -1:
        return
    body = cb[brace_local + 1:end_local]
    binding = _first_ident(cb.split("=>")[0]) if "=>" in cb else None
    finding = _classify_ts_body(body, binding, kind="promise")
    if finding is None:
        return
    severity, rule = finding
    if _override_ts(lines, kw_line, kw_line + 1):
        result["allowed"] += 1
        return
    _add(result, rel, kw_line, severity, rule, _snippet(lines, kw_line))


def _classify_ts_body(body, binding, kind):
    empty = body.strip() == ""
    if empty:
        return (CRITICAL, "empty-catch" if kind == "catch" else "empty-promise-catch")
    if _has_throw(body):
        return None
    if _log_only(body):
        return (WARNING, "catch-log-only" if kind == "catch" else "promise-catch-log-only")
    if binding and re.search(r"\b" + re.escape(binding) + r"\b", body):
        return None  # uses the error somehow (setState, custom handler, reject…)
    return (WARNING, "catch-swallow" if kind == "catch" else "promise-catch-swallow")


# ── Driver ──────────────────────────────────────────────────────────────────
def _add(result, rel, line, severity, rule, snippet):
    result["findings"].append({
        "file": rel, "line": line, "severity": severity,
        "rule": rule, "snippet": snippet,
    })
    if severity == CRITICAL:
        result["critical"] += 1
    else:
        result["warning"] += 1


def _iter_files(roots):
    for root in roots:
        if os.path.isfile(root):
            yield root
            continue
        for dirpath, dirnames, filenames in os.walk(root):
            dirnames[:] = [d for d in dirnames if d not in EXCLUDE_DIRS]
            for fn in filenames:
                yield os.path.join(dirpath, fn)


def scan(roots, display_root):
    result = {"critical": 0, "warning": 0, "allowed": 0,
              "skipped": 0, "scanned": 0, "findings": []}
    for path in _iter_files(roots):
        ext = os.path.splitext(path)[1].lower()
        if ext not in PY_EXT and ext not in TS_EXT:
            continue
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as fh:
                text = fh.read()
        except OSError:
            result["skipped"] += 1
            continue
        lines = text.splitlines()
        rel = os.path.relpath(path, display_root)
        result["scanned"] += 1
        if ext in PY_EXT:
            scan_python(path, rel, lines, text, result)
        else:
            scan_ts(path, rel, lines, text, result)
    result["findings"].sort(key=lambda f: (f["file"], f["line"], f["rule"]))
    return result


def _print_human(result):
    print("Error-handling anti-pattern scan")
    print(f"  scanned={result['scanned']} files  "
          f"skipped={result['skipped']} (parse errors)")
    print(f"  CRITICAL={result['critical']}  WARNING={result['warning']}  "
          f"ALLOWED={result['allowed']}")
    if not result["findings"]:
        print("  no findings")
        return
    print("")
    for f in result["findings"]:
        print(f"  {f['severity']:<8} {f['file']}:{f['line']}  "
              f"[{f['rule']}]  {f['snippet']}")


def main(argv=None):
    ap = argparse.ArgumentParser(description="Error-handling anti-pattern scanner")
    ap.add_argument("paths", nargs="*", help="files or directories to scan (default: cwd)")
    ap.add_argument("--json", action="store_true", help="emit JSON")
    args = ap.parse_args(argv)

    roots = args.paths if args.paths else ["."]
    for r in roots:
        if not os.path.exists(r):
            sys.stderr.write(f"error: path not found: {r}\n")
            return 2

    if len(roots) == 1 and os.path.isdir(roots[0]):
        display_root = roots[0]
    else:
        display_root = os.getcwd()

    result = scan(roots, display_root)

    if args.json:
        print(json.dumps(result, ensure_ascii=False))
    else:
        _print_human(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
