// The task list: the app's unit of work, and the board's data. Persisted in
// userData/tasks.json (like layout.json) so it survives a renderer storage
// clear. Pure helpers only: every mutation returns a new doc, so the store can
// write optimistically and the reducer stays testable.
//
// A task may own at most one worktree. The invariant runs one way — every
// non-main worktree on disk has exactly one task (see reconcileTasks), but a
// task need not have a worktree: plenty of work needs no terminal at all, and
// a task outlives the worktree it happened to be about.

export type TaskState = 'todo' | 'progress' | 'blocked' | 'review' | 'done'

export interface Task {
  id: string
  title: string
  state: TaskState
  // Only meaningful while blocked. Kept (not cleared) when the state moves off
  // 'blocked' so unblocking by mistake doesn't lose what you typed — reading
  // code must gate on state, not on presence.
  reason?: string
  // Which lane a blocked task renders in. Blocked work isn't always started
  // work — a to-do can be stuck on something before anyone touches it — so the
  // block records the lane it happened in instead of dragging the card into
  // In progress. Only meaningful while blocked; defaults to 'progress' for
  // documents written before this existed.
  blockedLane?: 'todo' | 'progress'
  // A free-form note the user keeps on the card: "Carson is reviewing this",
  // "waiting on the design", whatever stops you re-deriving the same context
  // every time you look at it. Unlike `reason` it is not tied to any state —
  // it reads on the card in every lane, and is only ever cleared by emptying it.
  note?: string
  createdAt: number
  doneAt?: number
  // Absolute path of the worktree this task owns, if it has one. A path that no
  // longer exists is kept rather than cleared: the task outlives the worktree,
  // and the card renders the link as stale instead of silently forgetting it.
  worktree?: string
  // Repo root the task belongs to. Set when a worktree is attached, and used to
  // decide where a worktree would be created for a task that has none yet.
  repo?: string
  // This task was created by the reconciler for a worktree it found on disk, so
  // its title is the branch name rather than something the user wrote. Cleared
  // on the first rename — it only exists to mark the title as a placeholder.
  fromDisk?: boolean
}

// Where the tasks are drawn. 'board' is the four-lane split with the terminal
// underneath; 'list' stacks them in one column down the left edge and gives the
// terminal the full height, which is the only way the app is usable on a short
// screen. A view preference rather than data, but it lives here because this is
// the document that already survives a restart.
export type TasksLayout = 'board' | 'list'

export interface TasksDoc {
  tasks: Task[]
  // How tall the board is, in pixels, above the terminal. Stored with the tasks
  // so the split comes back the way it was left. 0 means "half the window",
  // which is what an untouched install gets — a pixel default would be wrong on
  // every screen but the one it was chosen on.
  height: number
  layout: TasksLayout
  // How wide the list column is, in pixels, when the layout is 'list'. Kept
  // separate from `height`: the two layouts are resized independently, and
  // switching back should restore what you set, not a value converted from the
  // other axis.
  listWidth: number
}

export const BOARD_MIN_HEIGHT = 140
export const BOARD_MAX_HEIGHT = 2000
// Sentinel, not a size: resolved against the window at render time.
export const BOARD_HALF = 0

export const LIST_MIN_WIDTH = 180
export const LIST_MAX_WIDTH = 520
export const LIST_DEFAULT_WIDTH = 260

export const emptyTasks = (): TasksDoc => ({
  tasks: [], height: BOARD_HALF, layout: 'board', listWidth: LIST_DEFAULT_WIDTH
})

export const STATE_ORDER: TaskState[] = ['progress', 'blocked', 'review', 'todo', 'done']

export const STATE_LABEL: Record<TaskState, string> = {
  progress: 'In progress',
  blocked: 'Blocked',
  review: 'In review',
  todo: 'To do',
  done: 'Done'
}

export function newTaskId(doc: TasksDoc): string {
  // Monotonic within the document rather than a timestamp: two tasks added in
  // the same millisecond would otherwise collide on their React key.
  let n = 1
  const used = new Set(doc.tasks.map(t => t.id))
  while (used.has(`t${n}`)) n++
  return `t${n}`
}

// `repo` is which repo the task is for — where a worktree would be created if
// it turns out to need one. Optional: plenty of work belongs to no repo at all.
export function addTask(
  doc: TasksDoc, title: string, now = Date.now(), repo?: string
): TasksDoc {
  const trimmed = title.trim()
  if (!trimmed) return doc
  const task: Task = { id: newTaskId(doc), title: trimmed, state: 'todo', createdAt: now, repo }
  return { ...doc, tasks: [...doc.tasks, task] }
}

export function updateTask(doc: TasksDoc, id: string, patch: Partial<Task>): TasksDoc {
  return { ...doc, tasks: doc.tasks.map(t => (t.id === id ? { ...t, ...patch, id: t.id } : t)) }
}

export function renameTask(doc: TasksDoc, id: string, title: string): TasksDoc {
  const trimmed = title.trim()
  // An empty title would render an unclickable blank row with no way back, so
  // a cleared title is a no-op rather than a delete — deleting is its own ✕.
  if (!trimmed) return doc
  // Naming it yourself is what makes the placeholder a title.
  return updateTask(doc, id, { title: trimmed, fromDisk: undefined })
}

// The two states you want to see without hunting: what is being worked on, and
// what just landed. Both jump to the top of their column, so the newest one is
// always the first card in the lane.
//
// Blocked and todo deliberately don't: a blocked card should stay where you
// left it, and a to-do list you reordered by hand is an order you chose.
function promotes(state: TaskState): boolean {
  return state === 'progress' || state === 'done'
}

// Reposition within the flat list so the task comes first among its own lane's
// cards — the other lanes' order is untouched, since they interleave in the
// document but not on screen.
export function moveToLaneTop(doc: TasksDoc, id: string): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const lane = laneOf(task)
  const rest = doc.tasks.filter(t => t.id !== id)
  const first = rest.findIndex(t => laneOf(t) === lane)
  rest.splice(first === -1 ? rest.length : first, 0, task)
  return { ...doc, tasks: rest }
}

// Moving to 'done' stamps doneAt (that's what "done today" counts from);
// moving off it clears the stamp.
export function setTaskState(
  doc: TasksDoc, id: string, state: TaskState, now = Date.now()
): TasksDoc {
  const next = updateTask(doc, id, { state, doneAt: state === 'done' ? now : undefined })
  return promotes(state) ? moveToLaneTop(next, id) : next
}

// Blocking leaves the card where it sits: a to-do blocks in To do, anything
// else blocks in In progress. Review and done have no blocked rendering of
// their own, so blocking from there means the work is back in flight.
export function setBlocked(doc: TasksDoc, id: string, reason: string): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const lane = laneOf(task)
  return updateTask(doc, id, {
    state: 'blocked',
    reason: reason.trim(),
    blockedLane: lane === 'todo' ? 'todo' : 'progress',
    doneAt: undefined
  })
}

// Set (or clear) the card's note. Empty means no note: an all-whitespace
// string would otherwise render as a blank line under the title forever.
export function setTaskNote(doc: TasksDoc, id: string, note: string): TasksDoc {
  const trimmed = note.trim()
  return updateTask(doc, id, { note: trimmed || undefined })
}

export function removeTask(doc: TasksDoc, id: string): TasksDoc {
  return { ...doc, tasks: doc.tasks.filter(t => t.id !== id) }
}

// What the checkbox does: the everyday path is todo → working on it → up for
// review → finished, and clicking a finished task puts it back. Blocked is
// deliberately off this cycle — it needs a reason, so it's its own control.
export function cycleTaskState(doc: TasksDoc, id: string, now = Date.now()): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const next: TaskState =
    task.state === 'todo' ? 'progress'
      : task.state === 'progress' ? 'review'
        : task.state === 'review' ? 'done'
          : task.state === 'blocked' ? (task.blockedLane === 'todo' ? 'todo' : 'progress')
            : 'todo'
  return setTaskState(doc, id, next, now)
}

// Drag-to-reorder. Anchored on the target's id rather than an index, so a drop
// lands where the insertion line was drawn no matter how the list is filtered
// or rendered.
export function moveTask(
  doc: TasksDoc, id: string, anchorId: string, after: boolean
): TasksDoc {
  if (id === anchorId) return doc
  const rest = doc.tasks.filter(t => t.id !== id)
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const at = rest.findIndex(t => t.id === anchorId)
  if (at < 0) return doc
  rest.splice(after ? at + 1 : at, 0, task)
  return { ...doc, tasks: rest }
}

export function setBoardHeight(doc: TasksDoc, height: number): TasksDoc {
  return { ...doc, height: clampBoardHeight(height) }
}

export function setLayout(doc: TasksDoc, layout: TasksLayout): TasksDoc {
  return doc.layout === layout ? doc : { ...doc, layout }
}

// What the menu item does: there are two layouts, so a toggle is the whole
// setting — no submenu of one choice each.
export function toggleLayout(doc: TasksDoc): TasksDoc {
  return setLayout(doc, doc.layout === 'list' ? 'board' : 'list')
}

export function setListWidth(doc: TasksDoc, width: number): TasksDoc {
  return { ...doc, listWidth: clampListWidth(width) }
}

// Unlike the board height there is no sentinel here: a column of cards has a
// width that is right on every screen, so the default is a real number.
export function clampListWidth(width: number): number {
  if (!Number.isFinite(width)) return LIST_DEFAULT_WIDTH
  return Math.min(Math.max(Math.round(width), LIST_MIN_WIDTH), LIST_MAX_WIDTH)
}

// A dragged height is clamped; the half-the-window sentinel passes through, so
// a doc that has never been dragged stays adaptive rather than being frozen at
// whatever the first window happened to be.
export function clampBoardHeight(height: number): number {
  if (!Number.isFinite(height)) return BOARD_HALF
  if (height === BOARD_HALF) return BOARD_HALF
  return Math.min(Math.max(Math.round(height), BOARD_MIN_HEIGHT), BOARD_MAX_HEIGHT)
}

// What the board should actually be, given the window it is in. The lower half
// always keeps room for a usable terminal, so a stored height taller than the
// window shrinks rather than pushing the terminal off screen.
export function resolveBoardHeight(stored: number, windowHeight: number): number {
  const max = Math.max(BOARD_MIN_HEIGHT, windowHeight - MIN_TERMINAL_HEIGHT)
  if (stored === BOARD_HALF) return Math.max(BOARD_MIN_HEIGHT, Math.round(windowHeight / 2))
  return Math.min(clampBoardHeight(stored), max)
}

// Enough terminal to be worth having: a prompt, its output, and the crumb above
// it. Below this the split is no longer a split.
export const MIN_TERMINAL_HEIGHT = 160

// Note: there is deliberately no sort. The list renders in the order the user
// put it in, and finishing or blocking a task leaves it exactly where it sits —
// a row that moved under the cursor as its state changed made the list feel
// like it was rearranging itself. Order is the user's; state is just a mark.

// --- Board lanes -----------------------------------------------------------
// The board has four columns, and blocked is not one of them: it is a modifier
// on a card, not a place work lives. A blocked task renders in To do or In
// progress — whichever lane it was blocked in — with a stripe and its reason,
// and unblocking leaves it exactly where it sat, which a blocked column could
// not do.

export type Lane = 'todo' | 'progress' | 'review' | 'done'

export const LANES: Lane[] = ['todo', 'progress', 'review', 'done']

export const LANE_LABEL: Record<Lane, string> = {
  todo: 'To do', progress: 'In progress', review: 'In review', done: 'Done'
}

// Blocked is the only state that doesn't name its own lane: it is a modifier on
// a card that still belongs to To do or In progress, and `blockedLane` says
// which. It renders there with a stripe.
export function laneOf(task: Task): Lane {
  switch (task.state) {
    case 'done': return 'done'
    case 'todo': return 'todo'
    case 'review': return 'review'
    case 'blocked': return task.blockedLane === 'todo' ? 'todo' : 'progress'
    default: return 'progress'
  }
}

// Document order within the lane — the same order the list has always used, so
// dragging a card and dragging a row mean the same thing.
export function tasksInLane(doc: TasksDoc, lane: Lane): Task[] {
  return doc.tasks.filter(t => laneOf(t) === lane)
}

export function taskForWorktree(doc: TasksDoc, worktreePath: string): Task | undefined {
  return doc.tasks.find(t => t.worktree === worktreePath)
}

// Attaching moves the task to 'progress': under this model a worktree existing
// is what "started" means. An already-blocked task keeps its state — it is
// started and stuck, which is not the same as started.
export function attachWorktree(
  doc: TasksDoc, id: string, worktree: string, repo?: string
): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const next = updateTask(doc, id, {
    worktree,
    repo: repo ?? task.repo,
    state: task.state === 'blocked' ? 'blocked' : 'progress',
    // Blocked keeps its state, but a worktree existing moves it out of To do:
    // it is started and stuck, which belongs in In progress.
    blockedLane: task.state === 'blocked' ? 'progress' : undefined,
    doneAt: undefined
  })
  // Starting work is the clearest case of "look at this one now".
  return task.state === 'blocked' ? next : moveToLaneTop(next, id)
}

// Detaching clears the link only. The task stays, in whatever lane it was in:
// removing a worktree is not finishing the work, and the invariant only runs
// worktree → task.
export function detachWorktree(doc: TasksDoc, id: string): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  return { ...doc, tasks: doc.tasks.map(t => (t.id === id ? { ...t, worktree: undefined } : t)) }
}

// Every worktree must have a task, so anything on disk that no task claims gets
// one here — at launch and on every re-list, since `git worktree add` in some
// other terminal is the normal way this happens.
//
// Main checkouts are the exception, in both directions: they never get a card,
// and a card the old rule minted for one is dropped on sight. A repo root is
// not work you finish — it is a place you stand — so it lives on the board's
// repo rail instead, which is also what keeps it reachable.
//
// Returns the same document when there is nothing to change, so a caller can
// write on identity rather than diffing.
const dirName = (path: string) => path.split('/').filter(Boolean).pop() ?? ''

export function reconcileTasks(
  doc: TasksDoc,
  worktrees: { path: string; branch: string; isMain: boolean }[],
  names: Record<string, string> = {},
  repoOf: Record<string, string> = {},
  now = Date.now()
): TasksDoc {
  // Roots the rail owns. A card pointing at one either goes away or lets go of
  // the root, never both — the rail took over the *place*, and a note the user
  // wrote about it is still theirs.
  const roots = new Set(worktrees.filter(w => w.isMain).map(w => w.path))
  const branchOf: Record<string, string> = {}
  for (const w of worktrees) branchOf[w.path] = w.branch
  let changed = false
  const kept: Task[] = []
  // One worktree, one card. A second card for a path another task already holds
  // is a duplicate — races between creating a worktree and attaching it made
  // these before the create path guarded against it, and they read on the board
  // as the same work listed twice.
  const claimed = new Set<string>()
  for (const t of doc.tasks) {
    if (t.worktree && claimed.has(t.worktree)) {
      changed = true
      // The same test the root rule uses: a card still wearing the branch or
      // directory name is one the reconciler minted, so it goes. Anything the
      // user named is theirs — it keeps its text and loses only the link.
      if (t.fromDisk || t.title === branchOf[t.worktree] || t.title === dirName(t.worktree)) continue
      kept.push({ ...t, worktree: undefined })
      continue
    }
    if (t.worktree) claimed.add(t.worktree)
    if (!t.worktree || !roots.has(t.worktree)) { kept.push(t); continue }
    changed = true
    // The reconciler's own card. `fromDisk` only exists on ones minted after
    // that flag did, so the title is checked too: the old rule named a root
    // for its directory, and that card is no more the user's than a fresh one.
    if (t.fromDisk || t.title === dirName(t.worktree)) continue
    // Something the user wrote. Keep the task, drop the link — a card that
    // still opened the root would put it back on the board by another name.
    kept.push({ ...t, worktree: undefined })
  }
  let next = changed ? { ...doc, tasks: kept } : doc
  for (const w of worktrees) {
    if (w.isMain || taskForWorktree(next, w.path)) continue
    // The user's own name if they set one, else the branch — never an invented
    // sentence.
    const title = names[w.path]?.trim() || w.branch
    const id = newTaskId(next)
    const task: Task = {
      id, title, state: 'progress', createdAt: now,
      worktree: w.path, repo: repoOf[w.path], fromDisk: true
    }
    next = { ...next, tasks: [...next.tasks, task] }
  }
  return next
}

// An agent started working in a worktree, so its task is in progress by
// definition — mark it, and pop it to the top of the lane. This is the case the
// promotion exists for: the card you just started querying should be the first
// one you see, without touching the board yourself.
//
// Returns the same document when there is nothing to change, and that identity
// carries weight: `working` is re-asserted on every tool call, so a doc that
// compared unequal here would write tasks.json to disk dozens of times a turn.
//
// A blocked task is left alone. The reason on it is the user's to clear, and
// an agent poking at the worktree doesn't clear it. In review keeps its state
// for the same reason — prompting an agent on a card under review is part of
// reviewing it, not a restart, and dragging it back yourself is the only thing
// that should undo a review — but it still pops to the top of its own lane,
// since the card you are querying is the one you want to see first either way.
export function noteAgentWorking(
  doc: TasksDoc, worktreePath: string, now = Date.now()
): TasksDoc {
  const task = taskForWorktree(doc, worktreePath)
  if (!task || task.state === 'blocked') return doc
  if (task.state === 'progress' || task.state === 'review') {
    const lane = laneOf(task)
    return tasksInLane(doc, lane)[0]?.id === task.id ? doc : moveToLaneTop(doc, task.id)
  }
  // setTaskState promotes on its way in, so this both marks and moves.
  return setTaskState(doc, task.id, 'progress', now)
}

// A board drop: the lane decides the state, the anchor decides the position,
// and both land in one write so a card can never flash in the wrong slot.
//
// Dropping into To do or In progress deliberately preserves 'blocked' — both
// are lanes a blocked card can live in, so the drag moves which lane it is
// blocked in rather than unblocking it. Review and done have no blocked
// rendering, so dropping there clears the block.
export function dropTask(
  doc: TasksDoc, id: string, lane: Lane,
  anchor?: { id: string; after: boolean },
  now = Date.now()
): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const blocked = task.state === 'blocked' && (lane === 'todo' || lane === 'progress')
  const state: TaskState = blocked ? 'blocked'
    : lane === 'todo' ? 'todo'
      : lane === 'done' ? 'done'
        : lane === 'review' ? 'review'
          : 'progress'
  // The anchor runs last on purpose: a card dropped on a specific card lands
  // there, even in a lane whose state would otherwise promote it. Dropped on
  // the lane's empty space, with nothing to anchor to, the promotion stands.
  let next = blocked
    ? (task.blockedLane === lane ? doc : updateTask(doc, id, { blockedLane: lane }))
    : state === task.state ? doc : setTaskState(doc, id, state, now)
  if (anchor && anchor.id !== id) next = moveTask(next, id, anchor.id, anchor.after)
  return next
}

export interface TaskCounts {
  open: number; blocked: number; progress: number; review: number; done: number
}

export function countTasks(tasks: Task[]): TaskCounts {
  const counts: TaskCounts = { open: 0, blocked: 0, progress: 0, review: 0, done: 0 }
  for (const t of tasks) {
    if (t.state === 'done') counts.done++
    else counts.open++
    if (t.state === 'blocked') counts.blocked++
    if (t.state === 'progress') counts.progress++
    if (t.state === 'review') counts.review++
  }
  return counts
}

// Fail-soft read, same contract as layout.json: a malformed entry is dropped
// rather than passed through, since a bad row would otherwise take the whole
// sidebar down with no in-app way to recover.
export function parseTasksDoc(parsed: unknown): TasksDoc {
  const doc = parsed as Record<string, unknown> | null
  const raw = Array.isArray(doc?.tasks) ? doc!.tasks : []
  return {
    tasks: raw.filter(isWellFormedTask),
    height: clampBoardHeight(typeof doc?.height === 'number' ? doc.height : BOARD_HALF),
    // Anything unrecognized reads as the board: it is what every install had
    // before the setting existed, so an absent field is not a missing choice.
    layout: doc?.layout === 'list' ? 'list' : 'board',
    listWidth: clampListWidth(typeof doc?.listWidth === 'number' ? doc.listWidth : LIST_DEFAULT_WIDTH)
  }
}

function isWellFormedTask(t: unknown): t is Task {
  const task = t as Record<string, unknown>
  return typeof task?.id === 'string' && typeof task?.title === 'string' &&
    typeof task?.createdAt === 'number' &&
    STATE_ORDER.includes(task?.state as TaskState) &&
    (task.reason === undefined || typeof task.reason === 'string') &&
    (task.note === undefined || typeof task.note === 'string') &&
    (task.doneAt === undefined || typeof task.doneAt === 'number') &&
    (task.worktree === undefined || typeof task.worktree === 'string') &&
    (task.repo === undefined || typeof task.repo === 'string') &&
    (task.fromDisk === undefined || typeof task.fromDisk === 'boolean') &&
    (task.blockedLane === undefined ||
      task.blockedLane === 'todo' || task.blockedLane === 'progress')
}
