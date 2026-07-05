#!/usr/bin/env bash

set -u

# Tempo máximo aguardando o marker de boot no log
BOOT_WAIT_SECS=25
# Tempo extra observando o app após o boot
RUN_SECS=8
# Marker escrito pelo frontend quando termina o boot
MARKER='===== boot ====='

APP_PID=""
SMOKE_HOME=""

# Limpa processo e HOME temporária na saída
cleanup() {
  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    # mata também os filhos (xvfb-run é wrapper: o app é child dele)
    pkill -P "$APP_PID" 2>/dev/null || true
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi

  if [[ -n "$SMOKE_HOME" && -d "$SMOKE_HOME" ]]; then
    rm -rf "$SMOKE_HOME"
  fi
}
trap cleanup EXIT

# Falha geral: motivo + últimas 30 linhas do log
fail() {
  local reason="$1"
  echo "❌ SMOKE FAIL: $reason" >&2

  local logfile=""
  if [[ -n "${SMOKE_HOME:-}" ]]; then
    logfile="$SMOKE_HOME/.omnirift/debug.log"
  fi

  if [[ -n "$logfile" && -f "$logfile" ]]; then
    echo "--- últimas 30 linhas do log ---" >&2
    tail -n 30 "$logfile" >&2
  fi

  exit 1
}

# Retorna o trecho do log a partir da última ocorrência do MARKER
log_after_marker() {
  local logfile="$1"
  awk -v marker="$MARKER" '
    index($0, marker) > 0 { buf = ""; found = 1; next }
    found { buf = buf $0 "\n" }
    END { printf "%s", buf }
  ' "$logfile"
}

# Verifica o log após o boot: REACT-ERROR ou panic fazem a asserção falhar
assert_log() {
  local logfile="$1"

  if [[ ! -f "$logfile" ]]; then
    echo "arquivo de log não encontrado: $logfile" >&2
    return 1
  fi

  local snippet
  snippet=$(log_after_marker "$logfile")

  if echo "$snippet" | grep -q 'REACT-ERROR'; then
    echo "assert_log: REACT-ERROR detectado após o marker" >&2
    echo "$snippet" >&2
    return 1
  fi

  if echo "$snippet" | grep -q 'panicked at'; then
    echo "assert_log: panic detectado após o marker" >&2
    echo "$snippet" >&2
    return 1
  fi

  return 0
}

# Lança o binário sob Xvfb, ou no DISPLAY local se xvfb-run não existir
launch_app() {
  local bin="$1"

  # XDG_RUNTIME_DIR isolado: o app abre socket RPC/porta lá — sem isolar,
  # o smoke colide com uma instância aberta do app na máquina do dev.
  mkdir -p "$SMOKE_HOME/runtime" && chmod 700 "$SMOKE_HOME/runtime"
  if command -v xvfb-run >/dev/null 2>&1; then
    env HOME="$SMOKE_HOME" \
        XDG_RUNTIME_DIR="$SMOKE_HOME/runtime" \
        LIBGL_ALWAYS_SOFTWARE=1 \
        WEBKIT_DISABLE_COMPOSITING_MODE=1 \
        xvfb-run -a "$bin" &
    APP_PID=$!
  elif [[ -n "${DISPLAY:-}" ]]; then
    env HOME="$SMOKE_HOME" \
        XDG_RUNTIME_DIR="$SMOKE_HOME/runtime" \
        LIBGL_ALWAYS_SOFTWARE=1 \
        WEBKIT_DISABLE_COMPOSITING_MODE=1 \
        "$bin" &
    APP_PID=$!
  else
    fail "xvfb-run não encontrado e DISPLAY não está definido"
  fi
}

# Aguarda até BOOT_WAIT_SECS pelo arquivo de log e pelo MARKER
wait_boot() {
  local logfile="$SMOKE_HOME/.omnirift/debug.log"
  local waited=0

  while [[ $waited -lt $BOOT_WAIT_SECS ]]; do
    if [[ -f "$logfile" ]] && grep -F "$MARKER" "$logfile" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

# Modo --self-test: cria logs sintéticos e valida assert_log
self_test() {
  local tmp
  tmp=$(mktemp -d)
  local all_ok=1

  # Caso 1: apenas linhas normais após o marker → deve PASSAR
  local log1="$tmp/caso1.log"
  printf 'inicialização\n%s\nlinha normal\noutra linha ok\n' "$MARKER" > "$log1"

  echo "=== CASO 1 (esperado PASS) ==="
  if assert_log "$log1"; then
    echo "✅ caso1 PASS"
  else
    echo "❌ caso1 deveria PASS"
    all_ok=0
  fi

  # Caso 2: REACT-ERROR após o marker → deve FALHAR
  local log2="$tmp/caso2.log"
  printf 'inicialização\n%s\n[💥 REACT-ERROR @app] Minified React error #185\noutra linha\n' "$MARKER" > "$log2"

  echo "=== CASO 2 (esperado FAIL por REACT-ERROR) ==="
  if assert_log "$log2"; then
    echo "❌ caso2 deveria FAIL"
    all_ok=0
  else
    echo "✅ caso2 FAIL detectado"
  fi

  # Caso 3: panic após o marker → deve FALHAR
  local log3="$tmp/caso3.log"
  printf 'inicialização\n%s\nthread main panicked at src/lib.rs:42\noutra linha\n' "$MARKER" > "$log3"

  echo "=== CASO 3 (esperado FAIL por panic) ==="
  if assert_log "$log3"; then
    echo "❌ caso3 deveria FAIL"
    all_ok=0
  else
    echo "✅ caso3 FAIL detectado"
  fi

  rm -rf "$tmp"

  if [[ $all_ok -eq 1 ]]; then
    echo "✅ SELF-TEST PASS"
    exit 0
  else
    echo "❌ SELF-TEST FAIL" >&2
    exit 1
  fi
}

# Validação de argumentos
if [[ "$#" -eq 0 ]]; then
  echo "Uso: $0 <caminho-do-binario> | --self-test" >&2
  exit 1
fi

if [[ "$1" == "--self-test" ]]; then
  self_test
fi

BIN="$1"

if [[ ! -f "$BIN" ]]; then
  fail "binário não encontrado: $BIN"
fi

SMOKE_HOME=$(mktemp -d)

# --- Fluxo real de smoke test ---

launch_app "$BIN"

if ! wait_boot; then
  echo "⚠️ boot não detectado na primeira tentativa, reiniciando..." >&2

  if [[ -n "$APP_PID" ]] && kill -0 "$APP_PID" 2>/dev/null; then
    # mata também os filhos (xvfb-run é wrapper: o app é child dele)
    pkill -P "$APP_PID" 2>/dev/null || true
    kill "$APP_PID" 2>/dev/null || true
    wait "$APP_PID" 2>/dev/null || true
  fi

  APP_PID=""
  launch_app "$BIN"

  if ! wait_boot; then
    fail "frontend nunca bootou (2 tentativas)"
  fi
fi

# Janela de observação após o boot
sleep "$RUN_SECS"

# Verifica o log após o último marker
if ! assert_log "$SMOKE_HOME/.omnirift/debug.log"; then
  fail "erro detectado no log após o boot"
fi

# Verifica se o processo ainda está vivo
if ! kill -0 "$APP_PID" 2>/dev/null; then
  fail "processo morreu durante a janela de observação"
fi

echo "✅ SMOKE PASS"
exit 0