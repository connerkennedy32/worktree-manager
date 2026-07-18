import { create } from 'zustand'
import type { Worktree, WorktreeStatus } from '@shared/ipc-types'
import type { AgentReport } from '@shared/agent-status'
import { loadSeenAt, saveSeenAt } from './seen'

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
  agentStatuses: Record<string, AgentReport>
  seenAt: Record<string, number>
  selected?: string
  openDiff: DiffTarget | null
  setOpenDiff: (t: DiffTarget | null) => void
  // Count, not a boolean: the sidebar can stack confirm modals, and a boolean
  // would let one closing modal clear another's guard.
  modalOpen: number
  pushModal: () => void
  popModal: () => void
  init: () => Promise<void>
  refreshWorktrees: () => Promise<void>
  refreshWorktreeList: () => Promise<void>
  refreshStatus: (p: string) => Promise<void>
  select: (p: string) => void
  selectRelative: (delta: 1 | -1) => void
}

export const useStore = create<State>((set, get) => ({
  repos: [], worktrees: [], statuses: {}, agentStatuses: {}, seenAt: loadSeenAt(),
  openDiff: null, modalOpen: 0,
  setOpenDiff: (t) => set({ openDiff: t }),
  pushModal: () => set(st => ({ modalOpen: st.modalOpen + 1 })),
  popModal: () => set(st => ({ modalOpen: Math.max(0, st.modalOpen - 1) })),
  init: async () => {
    const repos = await window.api.listRepos()
    set({ repos })
    await get().refreshWorktrees()
    // On any change (files or branch HEAD), refresh that worktree's status and
    // re-list worktrees so branch renames/switches show in the sidebar.
    window.api.onStatusChanged(p => { get().refreshStatus(p); get().refreshWorktreeList() })
    // Agent status is pushed on change only, so seed it once: the main process
    // connects to the daemon a single time (ipc.ts:37), so a window reload does
    // not re-trigger the daemon's connect-time snapshot.
    set({ agentStatuses: await window.api.getAgentStatuses() })
    window.api.onAgentStatus((p, r) => set(st => ({ agentStatuses: { ...st.agentStatuses, [p]: r } })))
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
  select: (p) => {
    const seenAt = { ...get().seenAt, [p]: Date.now() }
    saveSeenAt(seenAt)
    set({ selected: p, seenAt })
    localStorage.setItem('wtm.selected', p)
  },
  // Step through the flat worktree list, wrapping at both ends. The list is built
  // in `repos` order and the sidebar groups by repo in that same order, so this
  // walks the sidebar top-to-bottom as it appears on screen.
  selectRelative: (delta) => {
    const { worktrees, selected, modalOpen, openDiff, select } = get()
    if (modalOpen > 0 || openDiff) return
    const n = worktrees.length
    if (n === 0) return
    const i = worktrees.findIndex(w => w.path === selected)
    // i === -1 covers both "nothing selected yet" and a `selected` path that has
    // since disappeared from the list, which the 3s refresh above can produce.
    if (i === -1) return select(worktrees[delta === 1 ? 0 : n - 1].path)
    select(worktrees[(i + delta + n) % n].path)
  }
}))
