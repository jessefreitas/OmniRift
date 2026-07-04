// src/lib/tour/tour-missions.ts — Pure logic for evaluating onboarding tour missions
// from a state snapshot. Zero dependency on Tauri/React. Decides mission completion
// from a snapshot of signals + baseline.

export type MissionId =
  | 'open-project'
  | 'create-agent'
  | 'send-message'
  | 'move-canvas'
  | 'save-workspace'
  | 'connect-agents'
  | 'see-kanban'

export interface TourSignals {
  agentNodeIds: string[]
  agentEdgeCount: number
  turnsByAgentId: Record<string, number>
  viewportMoved: boolean
  workspaceSavedAt: number | null
  kanbanPanelOpened: boolean
}

export interface TourBaseline {
  agentNodeIds: string[]
  agentEdgeCount: number
}

export const MISSION_ORDER: MissionId[] = [
  'open-project',
  'create-agent',
  'send-message',
  'move-canvas',
  'save-workspace',
  'connect-agents',
  'see-kanban',
]

/**
 * Evaluate which onboarding missions are satisfied by the current state snapshot.
 * Returns completed mission ids in canonical order.
 */
export function computeMissionStatus(
  signals: TourSignals,
  baseline: TourBaseline
): MissionId[] {
  const completed = new Set<MissionId>()

  // Mission 1: purely informational, always considered done.
  completed.add('open-project')

  const newAgents = signals.agentNodeIds.filter(
    (id) => !baseline.agentNodeIds.includes(id)
  )

  // Mission 2: created at least one agent beyond the baseline.
  if (newAgents.length > 0) {
    completed.add('create-agent')
  }

  // Mission 3: sent a message through at least one newly created agent.
  if (newAgents.some((id) => (signals.turnsByAgentId[id] ?? 0) > 0)) {
    completed.add('send-message')
  }

  // Mission 4: moved the infinite canvas viewport.
  if (signals.viewportMoved) {
    completed.add('move-canvas')
  }

  // Mission 5: saved the workspace at least once.
  if (signals.workspaceSavedAt !== null) {
    completed.add('save-workspace')
  }

  // Mission 6: added an edge beyond the baseline edge count.
  if (signals.agentEdgeCount > baseline.agentEdgeCount) {
    completed.add('connect-agents')
  }

  // Mission 7: opened the kanban panel.
  if (signals.kanbanPanelOpened) {
    completed.add('see-kanban')
  }

  // Always return in canonical mission order.
  return MISSION_ORDER.filter((m) => completed.has(m))
}

/** Return the next mission that is not yet completed. */
export function nextMission(done: MissionId[]): MissionId | null {
  return MISSION_ORDER.find((m) => !done.includes(m)) ?? null
}

/** Check whether a specific mission is already completed. */
export function isMissionDone(done: MissionId[], mission: MissionId): boolean {
  return done.includes(mission)
}
