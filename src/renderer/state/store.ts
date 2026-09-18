import { create } from 'zustand'
import type { RepoCommand, Worktree, WorktreeStatus } from '@shared/ipc-types'
import { removeWorktreeCommand } from '@shared/repo-commands'
import type { AgentReport } from '@shared/agent-status'
import type { PrStatus } from '@shared/pr-status'
import {
  attachWorktree, emptyTasks, LANES, noteAgentFinished, noteAgentWorking, reconcileTasks, removeTask,
  taskForWorktree, tasksInLane, type TasksDoc
} from '@shared/tasks'
import { loadNewTaskRepo, loadSeenAt, loadUnread, saveNewTaskRepo, saveSeenAt, saveUnread } from './seen'

// A file the diff modal can show. Renderer-only view state, so it stays out of
// @shared/ipc-types — it never crosses the IPC boundary.
export interface DiffTarget {
  key: string
  path: string
  staged: boolean
  untracked: boolean
  committed: boolean
}

// Whether starting a worktree should also take you to it. It does by default:
// pressing Start from inside a task means you're looking at that task and want
// its terminal. Creating the task and its worktree in one keystroke is the
// other case — the point there is often to fire the agent off and carry on with
// what you were doing, so that path passes `navigate: false`. The worktree,
// the task and the agent are identical either way; only the selection differs.
interface StartOpts { navigate?: boolean }

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
  // The global task list, plus its sidebar section state. Global on purpose:
  // tasks are not scoped to a worktree and outlive the ones they mention.
  tasks: TasksDoc
  applyTasks: (next: TasksDoc) => void
  // Repo root per worktree path, built while listing. Not on Worktree itself:
  // the renderer is the only thing that needs it, and it already knows which
  // repo it asked for.
  repoOf: Record<string, string>
  // The task id currently being dragged across the board. In the store rather
  // than a card's own state because the card being dragged and the card being
  // dragged over are different components.
  boardDrag?: string
  // Which repo a new task is for. Defaults to the one the last task was created
  // with, since a run of tasks is nearly always about the same repo.
  newTaskRepo: string
  setNewTaskRepo: (repo: string) => void
  // Open a task: its worktree's terminal if it has one, else the start pane.
  openTask: (id: string) => void
  // Open a repo root's terminal from the rail. Roots have no task, so this is
  // the one way into the lower pane that doesn't go through the board.
  openRepoRoot: (path: string) => void
  // The task the main area is currently about, or undefined on the board.
  openTaskId?: string
  // Create a worktree for a task and attach it. Returns an error message to
  // show in place, rather than throwing — git's own words are the useful part.
  // `navigate: false` creates the worktree and leaves you where you are — see
  // StartOpts.
  startWorktree: (id: string, branch: string, opts?: StartOpts) => Promise<string | undefined>
  // The same, through the repo's own create-worktree command: it decides where
  // the worktree goes, and its follow-ups open tmux, start the agent and hand
  // it the kickoff message.
  startWorktreeWithCommand: (
    id: string, command: RepoCommand, branch: string,
    inputs: Record<string, string>, prompt: string, opts?: StartOpts
  ) => Promise<string | undefined>
  // Delete a task and, if it owns one, its worktree. The confirm lives in the
  // board; this is the part that has to not half-apply.
  deleteTask: (id: string, force: boolean) => Promise<string | undefined>
  // Bumped to ask the sidebar's tasks panel to open and focus its input. A
  // counter rather than a boolean: two requests in a row must both land, and
  // there's no "handled" state to reset.
  newTaskNonce: number
  // Depth of "a task is creating a worktree right now". Creating one is two
  // steps — make it on disk, then attach it to the task — and the reconciler
  // runs on a 3s tick that can land in between, see a worktree no task claims
  // yet, and mint a second card for work that already has one. While this is
  // above zero the list still refreshes; only adoption is held off.
  creating: number
  requestNewTask: () => void
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
  // The sideways move: same row of the next lane along, which is what Ctrl+H
  // and Ctrl+L do.
  selectLaneRelative: (delta: 1 | -1) => void
}

// How long a worktree must stay selected before it counts as read. Long enough
// to survive a burst of Ctrl+J/K, short enough that actually landing on a
// worktree clears its dot before you look away.
export const READ_DWELL_MS = 2000

// The repo roots the rail draws, in rail order. Navigation treats them as a
// column, so it needs the same list the rail itself renders from.
const railPaths = (st: State) => st.worktrees.filter(w => w.isMain).map(w => w.path)

// The pending "mark read" for the current selection. Module-level rather than
// store state: nothing renders from it, and keeping it out of the store means
// selecting doesn't churn subscribers twice.
let readTimer: ReturnType<typeof setTimeout> | undefined

export const useStore = create<State>((set, get) => ({
  repos: [], worktrees: [], statuses: {}, agentStatuses: {}, seenAt: loadSeenAt(), unread: loadUnread(),
  names: {},
  prStatuses: {}, prRefreshing: false,
  tasks: emptyTasks(),
  repoOf: {},
  newTaskRepo: loadNewTaskRepo(),
  newTaskNonce: 0,
  creating: 0,
  selectedBackground: '',
  openDiff: null, modalOpen: 0,
  // Names are persisted in the main process (userData/names.json), so an empty
  // name clears the override there and we mirror the returned map into state.
  rename: async (p, name) => {
    const names = await window.api.setName(p, name)
    set({ names })
  },
  // Same optimistic contract as applyLayout: state now, disk after. A failed
  // write is logged rather than reverted — yanking a task back out from under
  // the user is worse than a list that repairs itself on the next write.
  applyTasks: (next) => {
    set({ tasks: next })
    window.api.setTasks(next).catch(e => console.error('tasks write failed', e))
  },
  setNewTaskRepo: (repo) => {
    saveNewTaskRepo(repo)
    set({ newTaskRepo: repo })
  },
  openTask: (id) => {
    const task = get().tasks.tasks.find(t => t.id === id)
    if (!task) return
    set({ openTaskId: id })
    // Selecting is what starts/reattaches the terminal, so only a task that
    // actually owns a worktree selects one; the rest get the start pane.
    if (task.worktree && get().worktrees.some(w => w.path === task.worktree)) {
      get().select(task.worktree)
    }
  },
  openRepoRoot: (path) => {
    // select() clears openTaskId on its own — a root owns no task — so the
    // surface below falls through to the root's terminal.
    get().select(path)
  },
  startWorktree: async (id, branch, opts) => {
    const task = get().tasks.tasks.find(t => t.id === id)
    if (!task) return 'That task is gone.'
    const repo = task.repo ?? get().repos[0]
    if (!repo) return 'No repo connected. Add one from the sidebar first.'
    set(st => ({ creating: st.creating + 1 }))
    try {
      const res = await window.api.createWorktree({ repoPath: repo, branch })
      if (!res.ok) return res.message
      // List first: attaching to a path the sidebar doesn't know about yet
      // would render a card pointing at nothing for a frame.
      await get().refreshWorktreeList()
      get().applyTasks(attachWorktree(get().tasks, id, res.path, repo))
      if (opts?.navigate === false) return undefined
      get().select(res.path)
      set({ openTaskId: id })
      return undefined
    } finally {
      set(st => ({ creating: st.creating - 1 }))
    }
  },
  startWorktreeWithCommand: async (id, command, branch, inputs, prompt, opts) => {
    const task = get().tasks.tasks.find(t => t.id === id)
    if (!task) return 'That task is gone.'
    const repo = task.repo ?? get().repos[0]
    if (!repo) return 'No repo connected. Add one from the Repos menu first.'
    // The command runs against the repo itself: there is no worktree yet, which
    // is the whole point of running it.
    set(st => ({ creating: st.creating + 1 }))
    try {
      const outcome = await window.api.runRepoCommand({
        worktreePath: repo, command, inputs, branch, prompt
      })
      if (!outcome.ok) return outcome.message
      await get().refreshWorktreeList()
      // `select` is where the command said it put the worktree. If nothing
      // matches, the command ran but made no worktree we can see — say so rather
      // than attaching the task to a path that isn't there.
      const created = outcome.select
        ? get().worktrees.find(w => w.path === outcome.select)
        : undefined
      if (!created) {
        return outcome.select
          ? `The command ran, but no worktree appeared at ${outcome.select}.`
          : 'That command has no `select`, so there is no worktree to attach.'
      }
      get().applyTasks(attachWorktree(get().tasks, id, created.path, repo))
      // Staying put still has to start the agent, and the agent is started *by*
      // these lines. The main process refuses to type into a pty that doesn't
      // exist (it would queue them until someone opened the worktree), so ask
      // for the terminal first and let it run offscreen — the daemon buffers its
      // output and replays the scrollback whenever the worktree is finally
      // opened, exactly as it does across a renderer reload.
      if (opts?.navigate === false) window.api.termStart(created.path)
      else get().select(created.path)
      // Typed after the terminal exists, so the lines aren't held back.
      if (outcome.terminal?.length) window.api.termRunLines(created.path, outcome.terminal)
      return undefined
    } finally {
      set(st => ({ creating: st.creating - 1 }))
    }
  },
  deleteTask: async (id, force) => {
    const task = get().tasks.tasks.find(t => t.id === id)
    if (!task) return undefined
    const path = task.worktree
    const worktree = path ? get().worktrees.find(w => w.path === path) : undefined
    if (path && worktree) {
      // A repo whose teardown does more than git does — dropping databases,
      // trashing node_modules out of band — says so with a removeWorktree
      // command, and that runs instead.
      const entries = await window.api.listRepoCommands(path).catch(() => [])
      const command = removeWorktreeCommand(entries)
      if (command) {
        const outcome = await window.api.runRepoCommand({
          worktreePath: path, command, branch: worktree.branch
        })
        if (!outcome.ok) return outcome.message
      } else {
        try {
          await window.api.removeWorktree(path, force)
        } catch (e: any) {
          // The worktree survived, so the task must too — a task-less worktree
          // is the one direction the invariant cannot repair.
          return (e?.message ?? String(e)).trim()
        }
      }
      await get().refreshWorktreeList()
      // Whatever ran, the worktree has to actually be gone before the task is:
      // deleting the task while its worktree stands would leave an orphan the
      // reconciler then re-adopts under a branch-name title.
      if (get().worktrees.some(w => w.path === path)) {
        return `${command ? command.label : 'Removing the worktree'} ran, but ${path} is still there.`
      }
    }
    get().applyTasks(removeTask(get().tasks, id))
    if (get().openTaskId === id) set({ openTaskId: undefined })
    return undefined
  },
  requestNewTask: () => {
    // The box lives at the bottom of the To do lane, which is always on screen
    // now; the lane only has to focus what it already renders.
    set(st => ({ newTaskNonce: st.newTaskNonce + 1 }))
  },
  refreshBackground: async () => {
    set({ selectedBackground: await window.api.getSelectedBackground() })
  },
  setOpenDiff: (t) => set({ openDiff: t }),
  pushModal: () => set(st => ({ modalOpen: st.modalOpen + 1 })),
  popModal: () => set(st => ({ modalOpen: Math.max(0, st.modalOpen - 1) })),
  init: async () => {
    const repos = await window.api.listRepos()
    set({ repos, names: await window.api.listNames(), tasks: await window.api.getTasks() })
    await get().refreshBackground()
    // The Background app menu changes the selection in the main process; re-read
    // it when notified so the backdrop updates live.
    window.api.onBackgroundChanged(() => get().refreshBackground())
    // Repos are added and disconnected from the Repos menu; main tells us when.
    window.api.onReposChanged(async () => {
      set({ repos: await window.api.listRepos() })
      await get().refreshWorktrees()
      // A disconnected repo takes its worktrees with it, so a selection or an
      // open task pointing into one has to let go rather than render nothing.
      const gone = !get().worktrees.some(w => w.path === get().selected)
      if (gone) set({ selected: undefined, openTaskId: undefined })
      if (!get().repos.includes(get().newTaskRepo)) get().setNewTaskRepo(get().repos[0] ?? '')
    })
    if (!repos.includes(get().newTaskRepo)) get().setNewTaskRepo(repos[0] ?? '')
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
    window.api.onAgentStatus((p, r) => {
      set(st => ({ agentStatuses: { ...st.agentStatuses, [p]: r } }))
      // An agent working is what "in progress" means, so the card says so and
      // moves to the top of the lane. Identity-checked: this event repeats on
      // every tool call, and only a real change is written.
      // An agent that just stopped is the card you want to read next, so it
      // goes above even the worktrees still working.
      if (r.status === 'done' || r.status === 'failed') {
        const done = noteAgentFinished(get().tasks, p)
        if (done !== get().tasks) get().applyTasks(done)
        return
      }
      if (r.status !== 'working') return
      // Worktrees whose agent is running right now keep their place at the top
      // of the lane; without this the running cards trade places on every tool
      // call. Read after the set above so `p` itself counts as working.
      const statuses = get().agentStatuses
      const busy = (w: string) => statuses[w]?.status === 'working'
      const next = noteAgentWorking(get().tasks, p, Date.now(), busy)
      if (next !== get().tasks) get().applyTasks(next)
    })
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
    const repoOf: Record<string, string> = {}
    for (const r of repos) {
      const list = await window.api.listWorktrees(r)
      for (const w of list) repoOf[w.path] = r
      all.push(...list)
    }
    set({ worktrees: all, repoOf })
    // A worktree can vanish under us (deleted here, or `git worktree remove` in
    // a terminal). Holding it as the selection leaves the app pointed at a
    // directory that isn't there: every status refresh fails and the pane keeps
    // drawing a dead worktree, which reads as a freeze.
    const sel = get().selected
    if (sel && !all.some(w => w.path === sel)) {
      localStorage.removeItem('wtm.selected')
      set(st => {
        const statuses = { ...st.statuses }
        delete statuses[sel]
        return { selected: undefined, openTaskId: undefined, statuses }
      })
    }
    // Every non-main worktree must have a task. This runs on every re-list, not
    // just at launch: `git worktree add` in another terminal is the normal way
    // an unclaimed one appears, and the 3s tick is when we notice.
    // A create in flight owns its worktree already; adopting it here would put
    // a second card on the board for the same work. The next tick picks up
    // anything genuinely unclaimed.
    if (get().creating > 0) return
    const reconciled = reconcileTasks(get().tasks, all, get().names, repoOf)
    if (reconciled !== get().tasks) get().applyTasks(reconciled)
  },
  refreshWorktrees: async () => {
    await get().refreshWorktreeList()
    for (const w of get().worktrees) get().refreshStatus(w.path)
  },
  refreshStatus: async (p) => {
    // Never throws: this runs from a 3s timer and from watcher events, where a
    // rejection is unhandled and the caller has nothing useful to do with it.
    try {
      const s = await window.api.getStatus(p)
      set(st => ({ statuses: { ...st.statuses, [p]: s } }))
    } catch {
      set(st => {
        if (!(p in st.statuses)) return st
        const statuses = { ...st.statuses }
        delete statuses[p]
        return { statuses }
      })
    }
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
    // Every non-main worktree has a task, so selecting one is just another way
    // of opening that task — the crumb then names it. A repo root has no task
    // and must clear the last one, or the surface would keep drawing the old
    // task's crumb over the root's terminal.
    set({ openTaskId: taskForWorktree(get().tasks, p)?.id })
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
  // Walk the board exactly as drawn — To do, then In progress, then In review,
  // then Done, in each lane's own order. Every card is a stop, including ones
  // with no worktree: stepping onto one opens its start pane, which is how a
  // task that needs a terminal gets one.
  selectRelative: (delta) => {
    const { tasks, openTaskId, selected, modalOpen, openDiff, openTask } = get()
    if (modalOpen > 0 || openDiff) return
    // On the rail, up and down walk the repos — the rail is a column like any
    // other, and stepping off it is what Ctrl+H/Ctrl+L are for.
    const roots = railPaths(get())
    const onRail = !openTaskId && selected ? roots.indexOf(selected) : -1
    if (onRail !== -1) {
      return get().openRepoRoot(roots[(onRail + delta + roots.length) % roots.length])
    }
    const order = LANES.flatMap(lane => tasksInLane(tasks, lane)).map(t => t.id)
    const n = order.length
    if (n === 0) return
    // Where we are: the open task, else whatever the selected worktree belongs
    // to — selecting from anywhere else still leaves the board a place to
    // resume from.
    const current = openTaskId ?? (selected ? taskForWorktree(tasks, selected)?.id : undefined)
    const i = current ? order.indexOf(current) : -1
    // i === -1 covers nothing open yet and a task that has since disappeared.
    if (i === -1) return openTask(order[delta === 1 ? 0 : n - 1])
    openTask(order[(i + delta + n) % n])
  },
  // Sideways across the columns, keeping your place in the one you left: the
  // card at the same depth in the next column, or its last card when that one
  // is shorter. The repo rail is the leftmost column — roots are navigable the
  // same way cards are — empty columns are skipped rather than landed on, and
  // the walk wraps like the vertical one does.
  selectLaneRelative: (delta) => {
    const { tasks, openTaskId, selected, modalOpen, openDiff, openTask } = get()
    if (modalOpen > 0 || openDiff) return
    const roots = railPaths(get())
    // Every column as a list of things to open, rail first. Empties are kept in
    // place so the columns keep their board positions; the walk skips them.
    const columns: { rail: boolean; items: string[] }[] = [
      { rail: true, items: roots },
      ...LANES.map(lane => ({ rail: false, items: tasksInLane(tasks, lane).map(t => t.id) }))
    ]
    const open = (col: { rail: boolean; items: string[] }, row: number) => {
      const target = col.items[Math.min(row, col.items.length - 1)]
      return col.rail ? get().openRepoRoot(target) : openTask(target)
    }

    // Where we are. A root has no task, so the rail is checked first.
    const at = roots.indexOf(!openTaskId && selected ? selected : '')
    let col = at === -1 ? -1 : 0
    let row = at === -1 ? 0 : at
    if (col === -1) {
      const current = openTaskId ?? (selected ? taskForWorktree(tasks, selected)?.id : undefined)
      for (let c = 1; c < columns.length; c++) {
        const i = current ? columns[c].items.indexOf(current) : -1
        if (i !== -1) { col = c; row = i; break }
      }
    }
    // Nothing open: start at the first thing there is, the way Ctrl+J does.
    if (col === -1) {
      const first = columns.find(c => c.items.length > 0)
      return first && open(first, 0)
    }
    // At most one lap: every other column empty means there is nowhere to go.
    for (let step = 0; step < columns.length - 1; step++) {
      col = (col + delta + columns.length) % columns.length
      if (columns[col].items.length === 0) continue
      return open(columns[col], row)
    }
  }
}))
