#!/usr/bin/env python3
"""Notificação do watchdog: ntfy → Telegram → arquivo. Detecção por env, nunca explode."""
import os
import time
import urllib.parse
import urllib.request


def _home():
    return os.environ.get("FAILBASE_HOME") or os.path.expanduser("~/.claude/failbase")


def notify(msg):
    """Retorna o canal usado: 'ntfy' | 'telegram' | 'file'."""
    ntfy = os.environ.get("FAILPROOF_NTFY_URL")
    if ntfy:
        try:
            urllib.request.urlopen(urllib.request.Request(
                ntfy, data=msg.encode(), method="POST"), timeout=5)
            return "ntfy"
        except Exception:
            pass
    token = os.environ.get("FAILPROOF_TELEGRAM_TOKEN")
    chat = os.environ.get("FAILPROOF_TELEGRAM_CHAT")
    if token and chat:
        try:
            url = "https://api.telegram.org/bot{}/sendMessage?chat_id={}&text={}".format(
                token, chat, urllib.parse.quote(msg))
            urllib.request.urlopen(url, timeout=5)
            return "telegram"
        except Exception:
            pass
    d = os.path.join(_home(), "alerts")
    os.makedirs(d, exist_ok=True)
    with open(os.path.join(d, "{}.txt".format(int(time.time() * 1000))), "w") as f:
        f.write(msg)
    return "file"
