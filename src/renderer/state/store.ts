import { create } from 'zustand'
import { emptyLayout, type Layout, type Worktree, type WorktreeStatus } from '@shared/ipc-types'
import type { AgentReport } from '@shared/agent-status'
import type { PrStatus } from '@shared/pr-status'
import { emptyTasks, type TasksDoc } from '@shared/tasks'
import { loadSeenAt, loadUnread, saveSeenAt, saveUnread } from './seen'
import { deriveSections, navOrder } from '../components/sidebar-layout'

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
  // Worktrees the user marked unread by hand (Ctrl+S U). Draws the same green dot a
  // finished agent turn does; cleared by selecting the worktree.
  unread: Record<string, boolean>
  toggleUnread: (p: string) => void
  // GitHub PR state per worktree path. Refreshed only when the user asks — the
  // sidebar header button — and seeded from the main-process disk cache at init.
  prStatuses: Record<string, PrStatus>
  prRefreshing: boolean
  prError?: string
  refreshPrStatuses: () => Promise<void>
  names: Record<string, string>
  rename: (p: string, name: string) => Promise<void>
  // Sidebar organization. Held here rather than in Sidebar.tsx because keyboard
  // nav (selectRelative) has to walk the same order the sidebar renders.
  layout: Layout
  applyLayout: (next: Layout) => void
  // The global task list, plus its sidebar section state. Global on purpose:
  // tasks are not scoped to a worktree and outlive the ones they mention.
  tasks: TasksDoc
  applyTasks: (next: TasksDoc) => void
  // Current backdrop selection ('' = built-in default). Managed from the
  // Background app menu; the renderer just mirrors it to paint the backdrop.
  selectedBackground: string
  refreshBackground: () => Promise<void>
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

// How long a worktree must stay selected before it counts as read. Long enough
// to survive a burst of Ctrl+J/K, short enough that actually landing on a
// worktree clears its dot before you look away.
export const READ_DWELL_MS = 2000

// The pending "mark read" for the current selection. Module-level rather than
// store state: nothing renders from it, and keeping it out of the store means
// selecting doesn't churn subscribers twice.
let readTimer: ReturnType<typeof setTimeout> | undefined

export const useStore = create<State>((set, get) => ({
  repos: [], worktrees: [], statuses: {}, agentStatuses: {}, seenAt: loadSeenAt(), unread: loadUnread(),
  names: {},
  prStatuses: {}, prRefreshing: false,
  layout: emptyLayout(),
  tasks: emptyTasks(),
  selectedBackground: '',
  openDiff: null, modalOpen: 0,
  // Names are persisted in the main process (userData/names.json), so an empty
  // name clears the override there and we mirror the returned map into state.
  rename: async (p, name) => {
    const names = await window.api.setName(p, name)
    set({ names })
  },
  // Optimistic: state updates now, disk catches up. A failed write is logged and
  // left alone rather than reverted — snapping a row back under the user's cursor
  // is worse than a layout that repairs itself on the next successful write.
  applyLayout: (next) => {
    set({ layout: next })
    window.api.setLayout(next).catch(e => console.error('layout write failed', e))
  },
  // Same optimistic contract as applyLayout: state now, disk after. A failed
  // write is logged rather than reverted — yanking a task back out from under
  // the user is worse than a list that repairs itself on the next write.
  applyTasks: (next) => {
    set({ tasks: next })
    window.api.setTasks(next).catch(e => console.error('tasks write failed', e))
  },
  refreshBackground: async () => {
    set({ selectedBackground: await window.api.getSelectedBackground() })
  },
  setOpenDiff: (t) => set({ openDiff: t }),
  pushModal: () => set(st => ({ modalOpen: st.modalOpen + 1 })),
  popModal: () => set(st => ({ modalOpen: Math.max(0, st.modalOpen - 1) })),
  init: async () => {
    const repos = await window.api.listRepos()
    set({ repos, names: await window.api.listNames(), layout: await window.api.getLayout(),
          tasks: await window.api.getTasks() })
    await get().refreshBackground()
    // The Background app menu changes the selection in the main process; re-read
    // it when notified so the backdrop updates live.
    window.api.onBackgroundChanged(() => get().refreshBackground())
    await get().refreshWorktrees()
    // On any change (files or branch HEAD), refresh that worktree's status and
    // re-list worktrees so branch renames/switches show in the sidebar.
    window.api.onStatusChanged(p => { get().refreshStatus(p); get().refreshWorktreeList() })
    // Agent status is pushed on change only, so seed it once: the main process
    // connects to the daemon a single time (ipc.ts:37), so a window reload does
    // not re-trigger the daemon's connect-time snapshot.
    set({ agentStatuses: await window.api.getAgentStatuses() })
    // A refresh the user triggered during this await must win over the cache.
    const cachedPr = await window.api.getPrStatuses()
    set(st => ({ prStatuses: { ...cachedPr, ...st.prStatuses } }))
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
  refreshPrStatuses: async () => {
    if (get().prRefreshing) return
    set({ prRefreshing: true })
    try {
      const paths = get().worktrees.map(w => w.path)
      const res = await window.api.refreshPrStatuses(paths)
      // A response can carry both: statuses that succeeded plus a message about
      // the ones that didn't. An empty result keeps whatever is on screen.
      if (Object.keys(res.statuses).length) set({ prStatuses: res.statuses })
      set({ prError: res.error })
    } catch (e: any) {
      set({ prError: e?.message ?? String(e) })
    } finally {
      set({ prRefreshing: false })
    }
  },
  // Note: we do NOT call termStart here. The terminal is started by TerminalView
  // once its xterm instance exists and the onTermData handler is bound, so the
  // shell's initial prompt output can never arrive before the renderer is ready.
  select: (p) => {
    set({ selected: p })
    localStorage.setItem('wtm.selected', p)
    // Marking read is deliberately *not* immediate. Stepping through worktrees
    // with Ctrl+J/K passes through every one in between, and stamping on arrival
    // would clear their dots without the user having read a thing. A worktree
    // counts as read once it has been the selected one for DWELL_MS.
    clearTimeout(readTimer)
    readTimer = setTimeout(() => {
      // Re-check rather than trusting the closure: a switch away and back
      // restarts the clock, and this timer may be the stale one.
      if (get().selected !== p) return
      const seenAt = { ...get().seenAt, [p]: Date.now() }
      saveSeenAt(seenAt)
      // Visiting a worktree is what "read" means, so it clears a manual mark too.
      const unread = { ...get().unread }
      delete unread[p]
      saveUnread(unread)
      set({ seenAt, unread })
    }, READ_DWELL_MS)
  },
  // A toggle, not a one-way set: pressing the shortcut twice undoes a mistake
  // without having to navigate away and back to clear it.
  toggleUnread: (p) => {
    const unread = { ...get().unread }
    if (unread[p]) delete unread[p]
    else unread[p] = true
    saveUnread(unread)
    set({ unread })
  },
  // Walk the sidebar exactly as rendered: groups first in layout order, then the
  // ungrouped section, then Hidden — with collapsed sections skipped, so
  // Cmd+Up/Down never jumps to a row that isn't on screen.
  selectRelative: (delta) => {
    const { worktrees, layout, selected, modalOpen, openDiff, select } = get()
    if (modalOpen > 0 || openDiff) return
    const order = navOrder(deriveSections(layout, worktrees))
    const n = order.length
    if (n === 0) return
    const i = order.indexOf(selected ?? '')
    // i === -1 covers nothing selected yet, a selection that has disappeared from
    // the list (the 3s refresh can produce this), and a selection that is hidden
    // inside a collapsed section.
    if (i === -1) return select(order[delta === 1 ? 0 : n - 1])
    select(order[(i + delta + n) % n])
  }
}))
