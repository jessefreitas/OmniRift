// src/lib/tour/tour-missions.test.ts — Deterministic tests for tour mission logic.
// Roda via `node scripts/run-grab-tests.mjs src/lib/tour/tour-missions.test.ts`.

import {
  computeMissionStatus,
  nextMission,
  MISSION_ORDER,
  isMissionDone,
  type TourSignals,
  type TourBaseline,
} from './tour-missions'

let pass = 0
let fail = 0

function assert(cond: boolean, msg: string) {
  if (cond) {
    pass++
  } else {
    fail++
    console.error('FAIL: ' + msg)
  }
}

function eq<T>(actual: T, expected: T, msg: string) {
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    msg + ' (got ' + JSON.stringify(actual) + ')'
  )
}

const emptyBaseline: TourBaseline = {
  agentNodeIds: [],
  agentEdgeCount: 0,
}

const emptySignals: TourSignals = {
  agentNodeIds: [],
  agentEdgeCount: 0,
  turnsByAgentId: {},
  viewportMoved: false,
  workspaceSavedAt: null,
  kanbanPanelOpened: false,
}

// 1. Empty state + empty baseline → only 'open-project'.
eq(
  computeMissionStatus(emptySignals, emptyBaseline),
  ['open-project'],
  'empty state should only complete open-project'
)

// 2. One agent beyond baseline → 'create-agent'.
const createSignals: TourSignals = {
  ...emptySignals,
  agentNodeIds: ['agent-1'],
}
eq(
  computeMissionStatus(createSignals, emptyBaseline),
  ['open-project', 'create-agent'],
  'one new agent should complete create-agent'
)

// 3. One new agent + one turn on it → 'create-agent' + 'send-message'.
const messageSignals: TourSignals = {
  ...createSignals,
  turnsByAgentId: { 'agent-1': 1 },
}
eq(
  computeMissionStatus(messageSignals, emptyBaseline),
  ['open-project', 'create-agent', 'send-message'],
  'a turn on a new agent should complete send-message'
)

// 4. Baseline pre-populated with 1 agent + 0 new agents → 'create-agent' NOT done.
const baselineWithAgent: TourBaseline = {
  agentNodeIds: ['existing'],
  agentEdgeCount: 0,
}
const noNewAgentSignals: TourSignals = {
  ...emptySignals,
  agentNodeIds: ['existing'],
}
eq(
  computeMissionStatus(noNewAgentSignals, baselineWithAgent),
  ['open-project'],
  'pre-populated agent alone should not complete create-agent'
)

// 5. Turn on a baseline agent → 'send-message' NOT done.
const baselineTurnSignals: TourSignals = {
  ...noNewAgentSignals,
  turnsByAgentId: { existing: 1 },
}
eq(
  computeMissionStatus(baselineTurnSignals, baselineWithAgent),
  ['open-project'],
  'a turn on a baseline agent should not complete send-message'
)

// 6. Viewport moved → 'move-canvas'.
const movedSignals: TourSignals = {
  ...emptySignals,
  viewportMoved: true,
}
eq(
  computeMissionStatus(movedSignals, emptyBaseline),
  ['open-project', 'move-canvas'],
  'viewportMoved should complete move-canvas'
)

// 7. Workspace saved → 'save-workspace'.
const savedSignals: TourSignals = {
  ...emptySignals,
  workspaceSavedAt: 1700000000000,
}
eq(
  computeMissionStatus(savedSignals, emptyBaseline),
  ['open-project', 'save-workspace'],
  'workspaceSavedAt should complete save-workspace'
)

// 8. Edge beyond baseline → 'connect-agents'.
const connectedSignals: TourSignals = {
  ...emptySignals,
  agentEdgeCount: 1,
}
eq(
  computeMissionStatus(connectedSignals, emptyBaseline),
  ['open-project', 'connect-agents'],
  'more edges than baseline should complete connect-agents'
)

// 9. Kanban opened → 'see-kanban'.
const kanbanSignals: TourSignals = {
  ...emptySignals,
  kanbanPanelOpened: true,
}
eq(
  computeMissionStatus(kanbanSignals, emptyBaseline),
  ['open-project', 'see-kanban'],
  'kanbanPanelOpened should complete see-kanban'
)

// 10. All missions satisfied → full canonical order and nextMission returns null.
const allSignals: TourSignals = {
  agentNodeIds: ['newbie'],
  agentEdgeCount: 1,
  turnsByAgentId: { newbie: 1 },
  viewportMoved: true,
  workspaceSavedAt: 1700000000000,
  kanbanPanelOpened: true,
}
const allDone = computeMissionStatus(allSignals, emptyBaseline)
eq(allDone, MISSION_ORDER, 'all missions satisfied should match canonical order')
eq(nextMission(allDone), null, 'nextMission should return null when all done')

// 11. Partial progress → next mission is 'send-message'.
eq(
  nextMission(['open-project', 'create-agent']),
  'send-message',
  'nextMission after first two should be send-message'
)

// 12. Kanban opened with no new agents → canonical order preserved.
eq(
  computeMissionStatus(kanbanSignals, emptyBaseline),
  ['open-project', 'see-kanban'],
  'kanban alone must keep canonical mission order'
)

// 13. isMissionDone helper.
assert(
  isMissionDone(['open-project', 'create-agent'], 'create-agent'),
  'isMissionDone should detect completed mission'
)
assert(
  !isMissionDone(['open-project'], 'create-agent'),
  'isMissionDone should detect incomplete mission'
)

console.log(`tour-missions: ${pass} pass, ${fail} fail`)
if (fail > 0) {
  process.exit(1)
}
