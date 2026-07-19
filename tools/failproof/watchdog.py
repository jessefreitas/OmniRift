#!/usr/bin/env python3
"""failproof watchdog — vigia sessões unattended e escala strike 1→2→3.

Rodar a cada 5 min via systemd user timer ou cron:
    */5 * * * * python3 ~/.claude/failbase/watchdog.py
Sessões se registram criando $FAILBASE_HOME/watch/<session_id>.json.
"""
import json
import os
import shlex
import signal
import subprocess
import sys
import time

_HOME = os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")
if _HOME not in sys.path:
    sys.path.insert(0, _HOME)
_REPO = os.path.dirname(os.path.abspath(__file__))
if _REPO not in sys.path:
    sys.path.insert(0, _REPO)
import failbase

def _stale_min():
    """Minutos sem escrita no transcript para considerar um turno travado.

    Sobe de 20 para 40 porque o transcript só recebe o resultado de uma ferramenta
    QUANDO ELA TERMINA: um build ou uma suíte de testes longa deixa o arquivo parado
    o tempo todo da execução, sem que nada esteja travado. Com 20 min, um turno
    saudável rodando um build pesado seria morto. Ajustável por env pra quem tem
    ferramenta ainda mais lenta, sem editar código. Valor inválido cai no default —
    config quebrada não pode derrubar o watchdog.
    """
    try:
        v = int(os.environ.get("FAILPROOF_STALE_MIN", "40"))
        return v if v > 0 else 40
    except (TypeError, ValueError):
        return 40


STALE_MIN_DEFAULT = _stale_min()
LOOP_REPEATS = 3


def detect_stale(mtime, now, threshold_min=STALE_MIN_DEFAULT):
    return (now - mtime) > threshold_min * 60


def _tail_error_sigs(transcript_path, limit=30):
    sigs = []
    try:
        with open(transcript_path) as f:
            lines = f.readlines()[-limit * 3:]
    except OSError:
        return []
    for line in lines:
        try:
            entry = json.loads(line)
        except ValueError:
            continue
        for block in ((entry.get("message") or {}).get("content") or []):
            if isinstance(block, dict) and block.get("type") == "tool_result":
                raw = block.get("content", "")
                text = raw if isinstance(raw, str) else json.dumps(raw)
                if "error" in text.lower() or "failed" in text.lower():
                    sigs.append(failbase.normalize_signature(text))
    return sigs[-limit:]


def detect_loop_from_transcript(transcript_path):
    sigs = _tail_error_sigs(transcript_path)
    return len(sigs) >= LOOP_REPEATS and len(set(sigs[-LOOP_REPEATS:])) == 1


def next_strike(state, session_id):
    cur = state.get(session_id, {}).get("strikes", 0)
    cur = min(cur + 1, 3)
    state[session_id] = {"strikes": cur, "ts": time.time()}
    return cur


def build_postmortem(transcript_path, session_id):
    sigs = _tail_error_sigs(transcript_path)
    fb = failbase.FailBase()
    lines = ["[failproof postmortem] sessão {} travada/em loop.".format(session_id),
             "Últimos erros (signatures): {}".format(", ".join(sigs[-5:]) or "nenhum")]
    try:
        with open(transcript_path) as f:
            tail = f.readlines()[-5:]
        for line in tail:
            entry = json.loads(line)
            for block in ((entry.get("message") or {}).get("content") or []):
                if isinstance(block, dict) and block.get("type") == "tool_result":
                    raw = block.get("content", "")
                    lines.append("- " + (raw if isinstance(raw, str)
                                         else json.dumps(raw))[:300])
    except (OSError, ValueError):
        pass
    for s in set(sigs[-5:]):
        known = fb.lookup(s)
        if known and known["fix_validated"] and known["fix"]:
            lines.append("FIX CONHECIDO para {}: {}".format(s, known["fix"][:200]))
    lines.append("Não repita a mesma estratégia — mude a abordagem.")
    return "\n".join(lines)


class Executor:
    def __init__(self, dry_run=False, notify_fn=None):
        self.dry_run = dry_run
        self.actions = []
        if notify_fn is None:
            try:
                sys.path.insert(0, os.path.join(_REPO, "plugins"))
                from notify import notify as notify_fn
            except Exception:
                notify_fn = lambda msg: None
        self.notify_fn = notify_fn

    def kill(self, pid):
        # pid <= 0 tem semântica especial no os.kill (0 = process group do caller —
        # SIGTERMaria o próprio watchdog; -1 = todos). Registro sem pid → não mata nada.
        if not isinstance(pid, int) or pid <= 0:
            self.actions.append(("kill_skipped", pid))
            return
        self.actions.append(("kill", pid))
        if not self.dry_run:
            try:
                os.kill(pid, signal.SIGTERM)
            except (OSError, ProcessLookupError):
                pass

    def relaunch(self, cmd, postmortem_path):
        self.actions.append(("relaunch", cmd))
        if not self.dry_run and cmd:
            # shell=True é intencional — `cmd` é um TEMPLATE de shell que o dono escreve na
            # config (pode ter pipe/redirect). O que NÃO era intencional: interpolar o path
            # cru dentro dessa linha. O path é gerado internamente hoje, mas ele carrega o
            # session_id, que vem de fora; um `;` ali viraria comando. shlex.quote fecha isso
            # sem tirar do dono a liberdade de escrever o comando dele.
            # nosemgrep: python.lang.security.audit.subprocess-shell-true.subprocess-shell-true
            subprocess.Popen(cmd.format(postmortem=shlex.quote(postmortem_path)), shell=True)

    def notify(self, msg):
        self.actions.append(("notify", msg))
        if not self.dry_run:
            self.notify_fn(msg)

    def failbase_add(self, postmortem, session_id):
        self.actions.append(("failbase_add", session_id))
        if not self.dry_run:
            # project="" torna o postmortem global (WHERE project IN (?, '')),
            # visível ao SessionStart de qualquer projeto — o watchdog não tem
            # cwd/projeto; o session_id fica registrado no texto do postmortem.
            failbase.FailBase().add(symptom=postmortem, source="watchdog",
                                    project="", command="watchdog")


def handle(entry, strike, executor):
    sid = entry["session_id"]
    pm = build_postmortem(entry["transcript_path"], sid)
    pm_dir = os.path.join(failbase.failbase_home(), "postmortems")
    os.makedirs(pm_dir, mode=0o700, exist_ok=True)  # postmortem/relaunch_cmd → só o dono lê
    pm_path = os.path.join(pm_dir, "{}.txt".format(sid))
    with open(pm_path, "w") as f:
        f.write(pm)
    if strike in (1, 2):
        executor.kill(entry.get("pid") or 0)
        executor.relaunch(entry.get("relaunch_cmd", ""), pm_path)
    else:
        executor.kill(entry.get("pid") or 0)
        executor.failbase_add(pm, sid)
        executor.notify("[failproof] sessão {} parada após 3 strikes. Postmortem: {}"
                        .format(sid, pm_path))
        watch_file = os.path.join(failbase.failbase_home(), "watch", "{}.json".format(sid))
        if os.path.exists(watch_file):
            os.remove(watch_file)


def _load_state():
    p = os.path.join(failbase.failbase_home(), "watchdog_state.json")
    try:
        with open(p) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def _save_state(state):
    p = os.path.join(failbase.failbase_home(), "watchdog_state.json")
    with open(p, "w") as f:
        json.dump(state, f)


def flush_to_brain():
    """Sync opcional das falhas novas → OmniMemory. Opt-in (FAILPROOF_SYNC_CMD),
    fail-open. Sem a env: no-op. É aqui que a base local vira cérebro compartilhado
    da equipe — o watchdog roda periódico, então empurra em batch sem custo de sessão."""
    try:
        sys.path.insert(0, os.path.join(_REPO, "plugins"))
        import sync_omnimemory
        return sync_omnimemory.sync()
    except Exception:
        return 0


def main():
    watch_dir = os.path.join(failbase.failbase_home(), "watch")
    if not os.path.isdir(watch_dir):
        flush_to_brain()  # sincroniza mesmo sem sessões vigiadas
        return 0
    state = _load_state()
    now = time.time()
    executor = Executor()
    for name in os.listdir(watch_dir):
        try:
            with open(os.path.join(watch_dir, name)) as f:
                entry = json.load(f)
            tp = entry["transcript_path"]
            stale = os.path.exists(tp) and detect_stale(os.path.getmtime(tp), now)
            loop = os.path.exists(tp) and detect_loop_from_transcript(tp)
            if stale or loop:
                strike = next_strike(state, entry["session_id"])
                handle(entry, strike, executor)
        except Exception:
            continue  # uma sessão quebrada nunca derruba o watchdog
    _save_state(state)
    flush_to_brain()  # empurra falhas novas (synced=0) pro OmniMemory se configurado
    return 0


if __name__ == "__main__":
    sys.exit(main())
