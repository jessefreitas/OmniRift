#!/usr/bin/env bash

set -euo pipefail

# Harness comparativo do canvas. As rodadas são intercaladas porque runners de CI
# aquecem e sofrem throttling; agrupar OFF/ON atribuiria essa deriva a uma só opção.

SCRIPT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
REPO_ROOT=$(cd "$SCRIPT_DIR/.." && pwd)
SCORE_CLI="$REPO_ROOT/apps/desktop/scripts/canvas-bench-score.mjs"

BENCH_K=${BENCH_K:-5}
BENCH_NODES=${BENCH_NODES:-300}
BOOT_WAIT_SECS=${BOOT_WAIT_SECS:-25}

APP_PID=""
BENCH_HOME=""
BENCH_TMP=""

# xvfb-run é apenas o wrapper. Matar também seus filhos evita deixar o app ou o
# Xvfb órfãos entre rodadas, o que contaminaria CPU e resultado das seguintes.
stop_app() {
  if [[ -n "$APP_PID" ]]; then
    pkill -TERM -P "$APP_PID" 2>/dev/null || true
    if kill -0 "$APP_PID" 2>/dev/null; then
      kill "$APP_PID" 2>/dev/null || true
    fi
    wait "$APP_PID" 2>/dev/null || true
    APP_PID=""
  fi
}

# O shellcheck não enxerga callbacks registrados por trap e marca este corpo
# como inalcançável, embora ele seja o caminho obrigatório de encerramento.
# shellcheck disable=SC2317
cleanup() {
  stop_app

  if [[ -n "$BENCH_HOME" && -d "$BENCH_HOME" ]]; then
    rm -rf "$BENCH_HOME"
  fi
  if [[ -n "$BENCH_TMP" && -d "$BENCH_TMP" ]]; then
    rm -rf "$BENCH_TMP"
  fi
}
trap cleanup EXIT INT TERM

fail() {
  local reason=$1
  echo "❌ CANVAS BENCH FAIL: $reason" >&2

  local logfile=""
  if [[ -n "${BENCH_HOME:-}" ]]; then
    logfile="$BENCH_HOME/.omnirift/debug.log"
  fi

  if [[ -n "$logfile" && -f "$logfile" ]]; then
    echo "--- últimas 30 linhas do log ---" >&2
    tail -n 30 "$logfile" >&2
  fi

  exit 1
}

assert_positive_integer() {
  local name=$1
  local value=$2
  if [[ ! "$value" =~ ^[1-9][0-9]*$ ]]; then
    fail "$name deve ser um inteiro positivo (recebido: $value)"
  fi
}

append_metric() {
  local array_file=$1
  local metric_file=$2
  node -e '
    const fs = require("node:fs");
    const [arrayPath, metricPath] = process.argv.slice(1);
    const runs = JSON.parse(fs.readFileSync(arrayPath, "utf8"));
    runs.push(JSON.parse(fs.readFileSync(metricPath, "utf8")));
    fs.writeFileSync(arrayPath, JSON.stringify(runs));
  ' "$array_file" "$metric_file"
}

json_field() {
  local json_file=$1
  local field=$2
  node -e '
    const fs = require("node:fs");
    const [path, field] = process.argv.slice(1);
    const value = JSON.parse(fs.readFileSync(path, "utf8"))[field];
    if (value !== undefined && value !== null) process.stdout.write(String(value));
  ' "$json_file" "$field"
}

enforce_mode() {
  local mode=$1
  local verdict_file=$2
  local kind
  kind=$(json_field "$verdict_file" kind)

  case "$mode" in
    report)
      return 0
      ;;
    approval-gate)
      if [[ "$kind" == "piora" || "$kind" == "dados-insuficientes" ]]; then
        return 1
      fi
      return 0
      ;;
    *)
      fail "modo inválido: $mode (use report ou approval-gate)"
      ;;
  esac
}

print_mode() {
  local mode=$1
  case "$mode" in
    report)
      echo "Modo: report — resultado informativo; este modo sempre termina com exit 0."
      ;;
    approval-gate)
      echo "Modo: approval-gate — piora ou dados insuficientes bloqueiam a ativação da flag."
      ;;
  esac
}

self_test() {
  local tmp
  tmp=$(mktemp -d)
  local empty_log="$tmp/empty.log"
  local begin_only_log="$tmp/begin-only.log"
  local complete_log="$tmp/complete.log"
  local empty_score="$tmp/empty.json"
  local begin_only_score="$tmp/begin-only.json"
  local complete_score="$tmp/complete.json"

  : > "$empty_log"
  printf '%s\n' '[2026-07-25T12:00:00.000Z] [📐 MEASURE-BEGIN]' > "$begin_only_log"
  cat > "$complete_log" <<'EOF'
[2026-07-25T12:00:00.000Z] [📐 MEASURE-BEGIN]
[2026-07-25T12:00:00.500Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:01.000Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:01.500Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:02.000Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:02.500Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:03.000Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:03.500Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:04.000Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:04.500Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:05.000Z] [📐 MEASURE-TICK]
[2026-07-25T12:00:05.000Z] [📐 MEASURE-END]
EOF

  echo "=== SELF-TEST: classificação dos logs sintéticos ==="
  node "$SCORE_CLI" score "$empty_log" > "$empty_score"
  if [[ "$(json_field "$empty_score" status)" != "insufficient-data" || \
        "$(json_field "$empty_score" reason)" != "sem-marcador-de-inicio" ]]; then
    rm -rf "$tmp"
    fail "log vazio não foi classificado como sem-marcador-de-inicio"
  fi
  echo "✅ log vazio: insufficient-data / sem-marcador-de-inicio"

  node "$SCORE_CLI" score "$begin_only_log" > "$begin_only_score"
  if [[ "$(json_field "$begin_only_score" status)" != "insufficient-data" || \
        "$(json_field "$begin_only_score" reason)" != "sem-marcador-de-fim" ]]; then
    rm -rf "$tmp"
    fail "log sem END não foi classificado como sem-marcador-de-fim"
  fi
  echo "✅ log com BEGIN sem END: insufficient-data / sem-marcador-de-fim"

  node "$SCORE_CLI" score "$complete_log" > "$complete_score"
  if [[ "$(json_field "$complete_score" status)" != "ok" ]]; then
    rm -rf "$tmp"
    fail "log completo com ticks suficientes não foi classificado como ok"
  fi
  echo "✅ log completo com ticks suficientes: ok"

  local off_json="$tmp/off.json"
  local worse_json="$tmp/on-worse.json"
  local better_json="$tmp/on-better.json"
  local worse_verdict="$tmp/worse-verdict.json"
  local better_verdict="$tmp/better-verdict.json"

  node -e '
    const fs = require("node:fs");
    const [basePath, offPath, worsePath, betterPath] = process.argv.slice(1);
    const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
    // A metrica primaria do veredito e a TAXA (mainBlocksPerMin), nao a contagem:
    // janelas de duracao diferente tornam contagem absoluta incomparavel. As fixtures
    // precisam variar a taxa junto, senao o self-test compara um campo que o veredito
    // nem olha — e foi assim que ele flagrou "detector em pane" ao trocar o default.
    const runs = (counts) =>
      counts.map((mainBlocks) => ({
        ...base,
        mainBlocks,
        windowMs: 60000,
        mainBlocksPerMin: mainBlocks,
      }));
    fs.writeFileSync(offPath, JSON.stringify(runs([10, 10, 10])));
    fs.writeFileSync(worsePath, JSON.stringify(runs([20, 20, 20])));
    fs.writeFileSync(betterPath, JSON.stringify(runs([2, 2, 2])));
  ' "$complete_score" "$off_json" "$worse_json" "$better_json"

  node "$SCORE_CLI" verdict "$off_json" "$worse_json" > "$worse_verdict"
  if enforce_mode approval-gate "$worse_verdict"; then
    rm -rf "$tmp"
    fail "detector em pane: o approval-gate não conseguiu reprovar uma piora clara"
  fi
  echo "✅ approval-gate REPROVA ON claramente pior"

  node "$SCORE_CLI" verdict "$off_json" "$better_json" > "$better_verdict"
  if ! enforce_mode approval-gate "$better_verdict"; then
    rm -rf "$tmp"
    fail "approval-gate reprovou uma melhora clara"
  fi
  echo "✅ approval-gate APROVA ON claramente melhor"

  # Reprovar "piora" NAO basta. O pior falso-verde deste harness e' aprovar uma
  # rodada que simplesmente NAO MEDIU: se o app morre no meio da janela, o
  # canvas-score devolve `dados-insuficientes` e um gate desatento leria isso
  # como "nao houve piora". E' a mesma familia do gate de review cujos scanners
  # viravam `skipped` e aprovavam sem escanear nada.
  local insuf_json="$tmp/insuf.json"
  local insuf_verdict="$tmp/insuf-verdict.json"
  node -e '
    const fs = require("node:fs");
    const [basePath, outPath] = process.argv.slice(1);
    const base = JSON.parse(fs.readFileSync(basePath, "utf8"));
    // Uma unica rodada invalida do lado ON tem que contaminar o veredito inteiro.
    fs.writeFileSync(outPath, JSON.stringify([
      { ...base, mainBlocks: 2, windowMs: 60000, mainBlocksPerMin: 2 },
      { ...base, status: "insufficient-data", reason: "sem-marcador-de-fim", windowMs: 0, mainBlocksPerMin: null },
      { ...base, mainBlocks: 2, windowMs: 60000, mainBlocksPerMin: 2 },
    ]));
  ' "$complete_score" "$insuf_json"

  node "$SCORE_CLI" verdict "$off_json" "$insuf_json" > "$insuf_verdict"
  if enforce_mode approval-gate "$insuf_verdict"; then
    rm -rf "$tmp"
    fail "detector em pane: o approval-gate aprovou uma rodada que NAO MEDIU (dados-insuficientes)"
  fi
  echo "✅ approval-gate REPROVA rodada que não mediu (dados-insuficientes)"

  rm -rf "$tmp"
  echo "✅ SELF-TEST PASS"
}

launch_app() {
  local bin=$1
  local flag_value=$2

  # HOME e runtime separados impedem colisão com instância aberta e impedem que
  # logs acumulados de outra rodada fabriquem markers ou métricas válidas.
  mkdir -p "$BENCH_HOME/runtime"
  chmod 700 "$BENCH_HOME/runtime"

  if command -v xvfb-run >/dev/null 2>&1; then
    env -u WAYLAND_DISPLAY HOME="$BENCH_HOME" \
        XDG_RUNTIME_DIR="$BENCH_HOME/runtime" \
        LIBGL_ALWAYS_SOFTWARE=1 \
        WEBKIT_DISABLE_COMPOSITING_MODE=1 \
        GDK_BACKEND=x11 \
        XDG_SESSION_TYPE=x11 \
        OMNIRIFT_BENCH_MODE=1 \
        OMNIRIFT_BENCH_FLAGS="drag-commit-on-end=$flag_value" \
        OMNIRIFT_BENCH_NODES="$BENCH_NODES" \
        xvfb-run -a "$bin" &
    APP_PID=$!
  elif [[ -n "${DISPLAY:-}" ]]; then
    env -u WAYLAND_DISPLAY HOME="$BENCH_HOME" \
        XDG_RUNTIME_DIR="$BENCH_HOME/runtime" \
        LIBGL_ALWAYS_SOFTWARE=1 \
        WEBKIT_DISABLE_COMPOSITING_MODE=1 \
        GDK_BACKEND=x11 \
        XDG_SESSION_TYPE=x11 \
        OMNIRIFT_BENCH_MODE=1 \
        OMNIRIFT_BENCH_FLAGS="drag-commit-on-end=$flag_value" \
        OMNIRIFT_BENCH_NODES="$BENCH_NODES" \
        "$bin" &
    APP_PID=$!
  else
    fail "xvfb-run não encontrado e DISPLAY não está definido"
  fi
}

wait_measure_end() {
  local logfile=$1
  local waited=0

  while [[ $waited -lt $BOOT_WAIT_SECS ]]; do
    if [[ -f "$logfile" ]] && grep -F '📐 MEASURE-END' "$logfile" >/dev/null 2>&1; then
      return 0
    fi
    sleep 1
    waited=$((waited + 1))
  done

  return 1
}

run_one() {
  local bin=$1
  local side=$2
  local flag_value=$3
  local repetition=$4
  local array_file=$5

  BENCH_HOME=$(mktemp -d "$BENCH_TMP/run-${side}-${repetition}.XXXXXX")
  local logfile="$BENCH_HOME/.omnirift/debug.log"
  local metric_file="$BENCH_TMP/${side}-${repetition}.json"

  echo "--- rodada $repetition/$BENCH_K: $side (drag-commit-on-end=$flag_value) ---"
  launch_app "$bin" "$flag_value"

  if ! wait_measure_end "$logfile"; then
    fail "$side repetição $repetition não produziu 📐 MEASURE-END em ${BOOT_WAIT_SECS}s"
  fi

  stop_app
  node "$SCORE_CLI" score "$logfile" > "$metric_file"
  append_metric "$array_file" "$metric_file"

  local status
  status=$(json_field "$metric_file" status)
  echo "métricas $side/$repetition: $(tr -d '\n' < "$metric_file")"
  grep -F '📐 BENCH-WRITES' "$logfile" 2>/dev/null || true
  if [[ "$status" == "insufficient-data" ]]; then
    local reason
    reason=$(json_field "$metric_file" reason)
    echo "⚠️ dados insuficientes em $side repetição $repetition: $reason" >&2
  fi

  rm -rf "$BENCH_HOME"
  BENCH_HOME=""
}

usage() {
  echo "Uso: $0 <caminho-do-binario> [report|approval-gate]" >&2
  echo "       $0 --self-test" >&2
}

if [[ "${1:-}" == "--self-test" ]]; then
  self_test
  exit 0
fi

if [[ $# -lt 1 || $# -gt 2 ]]; then
  usage
  exit 2
fi

# O autoteste roda antes da matriz real: um gate incapaz de produzir vermelho
# não recebe a chance de autorizar a flag, repetindo o incidente dos scanners skipped.
self_test

BIN=$1
MODE=${2:-${BENCH_GATE_MODE:-report}}

if [[ ! -f "$BIN" ]]; then
  fail "binário não encontrado: $BIN"
fi
if [[ ! -x "$BIN" ]]; then
  fail "binário não é executável: $BIN"
fi

case "$MODE" in
  report|approval-gate) ;;
  *) fail "modo inválido: $MODE (use report ou approval-gate)" ;;
esac

assert_positive_integer BENCH_K "$BENCH_K"
assert_positive_integer BENCH_NODES "$BENCH_NODES"
assert_positive_integer BOOT_WAIT_SECS "$BOOT_WAIT_SECS"

BENCH_TMP=$(mktemp -d)
OFF_JSON="$BENCH_TMP/off.json"
ON_JSON="$BENCH_TMP/on.json"
VERDICT_JSON="$BENCH_TMP/verdict.json"
printf '[]\n' > "$OFF_JSON"
printf '[]\n' > "$ON_JSON"

print_mode "$MODE"
echo "Matriz: drag-commit-on-end OFF/ON, K=$BENCH_K, nós=$BENCH_NODES (rodadas intercaladas)."

for ((repetition = 1; repetition <= BENCH_K; repetition++)); do
  run_one "$BIN" OFF 0 "$repetition" "$OFF_JSON"
  run_one "$BIN" ON 1 "$repetition" "$ON_JSON"
done

node "$SCORE_CLI" verdict "$OFF_JSON" "$ON_JSON" > "$VERDICT_JSON"
echo "Veredito: $(tr -d '\n' < "$VERDICT_JSON")"

if enforce_mode "$MODE" "$VERDICT_JSON"; then
  echo "✅ Resultado aceito pelo modo $MODE."
  exit 0
fi

echo "❌ Resultado bloqueado pelo modo approval-gate." >&2
exit 1
