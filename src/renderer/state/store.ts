import { create } from 'zustand'
import type { Worktree, WorktreeStatus } from '@shared/ipc-types'

interface State {
  repos: string[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
  selected?: string
  init: () => Promise<void>
  refreshWorktrees: () => Promise<void>
  refreshStatus: (p: string) => Promise<void>
  select: (p: string) => void
}

export const useStore = create<State>((set, get) => ({
  repos: [], worktrees: [], statuses: {},
  init: async () => {
    const repos = await window.api.listRepos()
    set({ repos })
    await get().refreshWorktrees()
    window.api.onStatusChanged(p => get().refreshStatus(p))
  },
  refreshWorktrees: async () => {
    const { repos } = get()
    const all: Worktree[] = []
    for (const r of repos) all.push(...await window.api.listWorktrees(r))
    set({ worktrees: all })
    for (const w of all) get().refreshStatus(w.path)
  },
  refreshStatus: async (p) => {
    const s = await window.api.getStatus(p)
    set(st => ({ statuses: { ...st.statuses, [p]: s } }))
  },
  // Note: we do NOT call termStart here. The terminal is started by TerminalView
  // once its xterm instance exists and the onTermData handler is bound, so the
  // shell's initial prompt output can never arrive before the renderer is ready.
  select: (p) => { set({ selected: p }) }
}))
