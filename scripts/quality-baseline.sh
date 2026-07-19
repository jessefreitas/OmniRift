#!/usr/bin/env bash
set -uo pipefail

# Por que baseline em vez de exigir zero? Temos 977 arquivos fora de formato e
# centenas de alertas de lint que nao podem ser corrigidos de uma so vez sem
# conflitar com sessoes em andamento. A baseline congela o passivo atual e so
# exige que ele nao PIORE, permitindo a faxina gradual e segura.

# Por que degradar limpo? Se a ferramenta nao esta instalada, falhar o gate seria
# ruido no ambiente local. Melhor pular a metrica e nao travar o desenvolvedor.

# Por que MELHOROU nao falha? Ganho de qualidade e positivo, mas precisa ser
# travado com `scripts/quality-baseline.sh --update`, senao o passivo sobe de
# novo silenciosamente.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
BASELINE_FILE="$ROOT/scripts/quality-baseline.txt"

MODE="${1:-check}"

declare -A BASELINE
BASELINE[eslint]=0
BASELINE[clippy]=0
BASELINE[fmt]=0

function load_baseline() {
  if [[ ! -f "$BASELINE_FILE" ]]; then
    return 1
  fi
  while IFS='=' read -r key value; do
    [[ -z "$key" || "$key" =~ ^# ]] && continue
    BASELINE[$key]=$((value))
  done < "$BASELINE_FILE"
}

function save_baseline() {
  printf "eslint=%d\nclippy=%d\nfmt=%d\n" "$1" "$2" "$3" > "$BASELINE_FILE"
}

function count_eslint() {
  if ! command -v npx >/dev/null 2>&1; then
    echo "PULADO"
    return
  fi
  local output
  output=$(cd "$ROOT/apps/desktop" && npx eslint . 2>&1) || true
  local match
  match=$(echo "$output" | grep -oE '[0-9]+ problems' | tail -n1 | grep -oE '[0-9]+' || true)
  if [[ -z "$match" ]]; then
    echo 0
  else
    echo "$match"
  fi
}

function count_clippy() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "PULADO"
    return
  fi
  local output
  # `touch` no lib.rs ANTES: o cargo cacheia e uma 2a rodada nao reemite os avisos —
  # a metrica media ZERO por cache, nao por qualidade. Medicao que mente e pior que
  # metrica nenhuma, porque da confianca falsa (foi assim que o gitleaks passou semanas
  # "aprovando" sem escanear).
  touch "$ROOT/apps/desktop/src-tauri/src/lib.rs" 2>/dev/null || true
  output=$(cd "$ROOT/apps/desktop/src-tauri" && cargo clippy --lib --no-deps --message-format short 2>&1) || true
  echo "$output" | grep -E ': (warning|error):' | wc -l | tr -d ' '
}

function count_fmt() {
  if ! command -v cargo >/dev/null 2>&1; then
    echo "PULADO"
    return
  fi
  local output
  output=$(cd "$ROOT/apps/desktop/src-tauri" && cargo fmt --check 2>&1) || true
  echo "$output" | grep -c '^Diff in '
}

if [[ "$MODE" == "--update" ]]; then
  ESLINT_ATUAL=$(count_eslint)
  CLIPPY_ATUAL=$(count_clippy)
  FMT_ATUAL=$(count_fmt)
  save_baseline "$ESLINT_ATUAL" "$CLIPPY_ATUAL" "$FMT_ATUAL"
  echo "Baseline atualizada em $BASELINE_FILE"
  echo "  eslint=$ESLINT_ATUAL"
  echo "  clippy=$CLIPPY_ATUAL"
  echo "  fmt=$FMT_ATUAL"
  exit 0
fi

if ! load_baseline; then
  echo "Arquivo de baseline nao encontrado: $BASELINE_FILE" >&2
  echo "Rode: scripts/quality-baseline.sh --update" >&2
  exit 1
fi

ESLINT_ATUAL=$(count_eslint)
CLIPPY_ATUAL=$(count_clippy)
FMT_ATUAL=$(count_fmt)

PIOROU=0

printf "%-10s %10s %10s %s\n" "metrica" "baseline" "atual" "veredito"
printf "%-10s %10s %10s %s\n" "-------" "--------" "-----" "--------"

function linha() {
  local nome=$1
  local base=$2
  local atual=$3

  if [[ "$atual" == "PULADO" ]]; then
    printf "%-10s %10s %10s %s\n" "$nome" "$base" "-" "PULADO (ferramenta ausente)"
    return
  fi

  if [[ "$atual" -eq "$base" ]]; then
    printf "%-10s %10d %10d %s\n" "$nome" "$base" "$atual" "OK"
  elif [[ "$atual" -lt "$base" ]]; then
    printf "%-10s %10d %10d %s\n" "$nome" "$base" "$atual" "MELHOROU (rode --update para travar o ganho)"
  else
    local diff=$((atual - base))
    printf "%-10s %10d %10d %s\n" "$nome" "$base" "$atual" "PIOROU (+$diff)"
    PIOROU=1
  fi
}

linha "eslint" "${BASELINE[eslint]}" "$ESLINT_ATUAL"
linha "clippy" "${BASELINE[clippy]}" "$CLIPPY_ATUAL"
linha "fmt"    "${BASELINE[fmt]}"    "$FMT_ATUAL"

if [[ "$PIOROU" -ne 0 ]]; then
  exit 1
fi
exit 0