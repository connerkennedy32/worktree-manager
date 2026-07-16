import { create } from 'zustand'
import type { Worktree, WorktreeStatus } from '@shared/ipc-types'

// A file the diff modal can show. Renderer-only view state, so it stays out of
// @shared/ipc-types — it never crosses the IPC boundary.
export interface DiffTarget {
  key: string
  path: string
  staged: boolean
  untracked: boolean
  committed: boolean
}

interface State {
  repos: string[]
  worktrees: Worktree[]
  statuses: Record<string, WorktreeStatus>
  selected?: string
  openDiff: DiffTarget | null
  setOpenDiff: (t: DiffTarget | null) => void
  init: () => Promise<void>
  refreshWorktrees: () => Promise<void>
  refreshWorktreeList: () => Promise<void>
  refreshStatus: (p: string) => Promise<void>
  select: (p: string) => void
}

export const useStore = create<State>((set, get) => ({
  repos: [], worktrees: [], statuses: {}, openDiff: null,
  setOpenDiff: (t) => set({ openDiff: t }),
  init: async () => {
    const repos = await window.api.listRepos()
    set({ repos })
    await get().refreshWorktrees()
    // On any change (files or branch HEAD), refresh that worktree's status and
    // re-list worktrees so branch renames/switches show in the sidebar.
    window.api.onStatusChanged(p => { get().refreshStatus(p); get().refreshWorktreeList() })
    // Safety net: periodically re-list worktrees (branch names) and refresh the
    // selected worktree's status, so the sidebar stays current even if a file
    // event is missed. Cheap: `git worktree list` / `git status` per tick.
    setInterval(() => {
      get().refreshWorktreeList()
      const sel = get().selected
      if (sel) get().refreshStatus(sel)
    }, 3000)
    // Restore the previously selected worktree after a reload so its terminal
    // (still alive in the main process) reattaches and replays automatically.
    const saved = localStorage.getItem('wtm.selected')
    if (saved && get().worktrees.some(w => w.path === saved)) set({ selected: saved })
  },
  refreshWorktreeList: async () => {
    const { repos } = get()
    const all: Worktree[] = []
    for (const r of repos) all.push(...await window.api.listWorktrees(r))
    set({ worktrees: all })
  },
  refreshWorktrees: async () => {
    await get().refreshWorktreeList()
    for (const w of get().worktrees) get().refreshStatus(w.path)
  },
  refreshStatus: async (p) => {
    const s = await window.api.getStatus(p)
    set(st => ({ statuses: { ...st.statuses, [p]: s } }))
  },
  // Note: we do NOT call termStart here. The terminal is started by TerminalView
  // once its xterm instance exists and the onTermData handler is bound, so the
  // shell's initial prompt output can never arrive before the renderer is ready.
  select: (p) => { set({ selected: p }); localStorage.setItem('wtm.selected', p) }
}))
