// src/store/tour-store.ts — Zustand store for the guided onboarding tour.

import { create } from 'zustand'
import { MISSION_ORDER } from '@/lib/tour/tour-missions'

const SEEN_KEY = 'omnirift.tour.v1.seen'
const SANDBOX_KEY = 'omnirift.tour.v1.sandboxPath'

/** Reads a value from localStorage safely. Returns defaultValue if unavailable. */
function safeGetItem(key: string, defaultValue: string | null): string | null {
  try {
    return localStorage.getItem(key) ?? defaultValue
  } catch {
    return defaultValue
  }
}

export interface TourState {
  /** Whether the tour is currently active/visible. */
  isActive: boolean
  /** Path of the tour sandbox folder (in appDataDir). */
  sandboxPath: string | null
  /** Whether the user has previously completed or dismissed the tour. */
  hasSeenTour: boolean
  /** Index in MISSION_ORDER of the popover currently displayed. */
  currentMissionIndex: number
  /** Start (or restart) the tour from the first mission. */
  start: () => void
  /** Dismiss the tour and mark it as seen permanently. */
  dismiss: () => void
  /** Mark the tour as seen without closing it. */
  markSeen: () => void
  /** Save the sandbox path. */
  setSandboxPath: (path: string) => void
  /** Move the tour popover to a specific mission index (clamped to valid range). */
  setCurrentMissionIndex: (index: number) => void
}

export const useTourStore = create<TourState>()((set) => ({
  isActive: false,
  sandboxPath: safeGetItem(SANDBOX_KEY, null),
  hasSeenTour: safeGetItem(SEEN_KEY, '') === '1',
  currentMissionIndex: 0,

  start: () => set({ isActive: true, currentMissionIndex: 0 }),

  dismiss: () => {
    try { localStorage.setItem(SEEN_KEY, '1') } catch { /* localStorage indisponivel */ }
    set({ isActive: false, hasSeenTour: true })
  },

  markSeen: () => {
    try { localStorage.setItem(SEEN_KEY, '1') } catch { /* localStorage indisponivel */ }
    set({ hasSeenTour: true })
  },

  setSandboxPath: (path: string) => {
    try { localStorage.setItem(SANDBOX_KEY, path) } catch { /* localStorage indisponivel */ }
    set({ sandboxPath: path })
  },

  setCurrentMissionIndex: (index: number) =>
    set({
      currentMissionIndex: Math.max(0, Math.min(index, MISSION_ORDER.length - 1)),
    }),
}))
