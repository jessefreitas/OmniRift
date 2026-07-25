#!/usr/bin/env bash
# Gate de fluidez do canvas (CI-local, sem GUI).
#
# Camada 1 — unit: limiares/classificação/parse/bus (canvas-fluency.test.ts).
# Camada 2 — wiring: falha se a instrumentação for removida do App/nós/watchdog.
#
# NÃO mede jank real do WebKitGTK (isso exige app aberto). Smoke opcional:
#   bash scripts/smoke-boot.sh apps/desktop/src-tauri/target/debug/omnirift
#   grep -E 'MAIN-BLOCK|RENDER-LOOP|REMOUNT-CHURN' "$HOME/.omnirift/debug.log"
#
# Uso:
#   bash scripts/canvas-fluency-gate.sh
#   npm run gate:canvas-fluency

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail() { echo "❌ canvas-fluency gate: $*" >&2; exit 1; }

echo "== canvas-fluency gate: unit (sem GUI) =="
npm run test:canvas-fluency --workspace=apps/desktop

echo "== canvas-fluency gate: wiring (fonte) =="

# Watchdog de main thread ligado no App
grep -q 'startMainThreadWatchdog' apps/desktop/src/App.tsx \
  || fail "App.tsx sem startMainThreadWatchdog"
grep -q 'FluencyChip' apps/desktop/src/App.tsx \
  || fail "App.tsx sem FluencyChip"

# Remount churn nos nós caros (PTY/ACP) — só floor ativo
grep -q 'trackNodeMount' apps/desktop/src/components/nodes/AgentNode.tsx \
  || fail "AgentNode sem trackNodeMount"
grep -q 'trackNodeMount' apps/desktop/src/components/nodes/TerminalNode.tsx \
  || fail "TerminalNode sem trackNodeMount"
grep -q 'floorActive' apps/desktop/src/components/nodes/AgentNode.tsx \
  || fail "AgentNode sem gate floorActive no remount"
grep -q 'floorActive' apps/desktop/src/components/nodes/TerminalNode.tsx \
  || fail "TerminalNode sem gate floorActive no remount"

# Runtime ainda emite as 3 tags estruturadas
grep -q 'MAIN-BLOCK' apps/desktop/src/lib/canvas-fluency.ts \
  || fail "canvas-fluency.ts sem tag MAIN-BLOCK"
grep -q 'RENDER-LOOP' apps/desktop/src/lib/canvas-fluency.ts \
  || fail "canvas-fluency.ts sem tag RENDER-LOOP"
grep -q 'REMOUNT-CHURN' apps/desktop/src/lib/canvas-fluency.ts \
  || fail "canvas-fluency.ts sem tag REMOUNT-CHURN"
grep -q 'trackNodeMount' apps/desktop/src/lib/debug-log.ts \
  || fail "debug-log.ts sem trackNodeMount"
grep -q 'evaluateMainThreadTick' apps/desktop/src/lib/debug-log.ts \
  || fail "debug-log.ts não usa evaluateMainThreadTick (detector desconectado)"

# F3 não pode ter sido desligado "pra fluidez" neste gate
grep -q 'onlyRenderVisibleElements={active && !hasUnbornAgents}' \
  apps/desktop/src/components/FloorCanvas.tsx \
  || fail "FloorCanvas: onlyRenderVisibleElements (F3) ausente ou alterado"

echo "✅ canvas-fluency gate OK (unit + wiring; jank runtime = smoke opcional)"
