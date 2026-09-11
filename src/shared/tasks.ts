// A global todo list — not scoped to a worktree, not cleared when one is
// removed. Persisted in userData/tasks.json (like layout.json) so it survives a
// renderer storage clear. Pure helpers only: every mutation returns a new doc,
// so the store can write optimistically and the reducer stays testable.

export type TaskState = 'todo' | 'progress' | 'blocked' | 'done'

export interface Task {
  id: string
  title: string
  state: TaskState
  // Only meaningful while blocked. Kept (not cleared) when the state moves off
  // 'blocked' so unblocking by mistake doesn't lose what you typed — reading
  // code must gate on state, not on presence.
  reason?: string
  createdAt: number
  doneAt?: number
}

export interface TasksDoc {
  tasks: Task[]
  // Sidebar section state, stored with the tasks so the panel comes back the
  // size the user left it at.
  collapsed: boolean
  height: number
}

export const TASKS_MIN_HEIGHT = 80
export const TASKS_MAX_HEIGHT = 600
export const TASKS_DEFAULT_HEIGHT = 200

export const emptyTasks = (): TasksDoc => ({
  tasks: [], collapsed: false, height: TASKS_DEFAULT_HEIGHT
})

export const STATE_ORDER: TaskState[] = ['progress', 'blocked', 'todo', 'done']

export const STATE_LABEL: Record<TaskState, string> = {
  progress: 'In progress',
  blocked: 'Blocked',
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

export function addTask(doc: TasksDoc, title: string, now = Date.now()): TasksDoc {
  const trimmed = title.trim()
  if (!trimmed) return doc
  const task: Task = { id: newTaskId(doc), title: trimmed, state: 'todo', createdAt: now }
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
  return updateTask(doc, id, { title: trimmed })
}

// Moving to 'done' stamps doneAt (that's what "done today" counts from);
// moving off it clears the stamp.
export function setTaskState(
  doc: TasksDoc, id: string, state: TaskState, now = Date.now()
): TasksDoc {
  return updateTask(doc, id, { state, doneAt: state === 'done' ? now : undefined })
}

export function setBlocked(doc: TasksDoc, id: string, reason: string): TasksDoc {
  return updateTask(doc, id, { state: 'blocked', reason: reason.trim(), doneAt: undefined })
}

export function removeTask(doc: TasksDoc, id: string): TasksDoc {
  return { ...doc, tasks: doc.tasks.filter(t => t.id !== id) }
}

// What the checkbox does: the everyday path is todo → working on it → finished,
// and clicking a finished task puts it back. Blocked is deliberately off this
// cycle — it needs a reason, so it's its own control.
export function cycleTaskState(doc: TasksDoc, id: string, now = Date.now()): TasksDoc {
  const task = doc.tasks.find(t => t.id === id)
  if (!task) return doc
  const next: TaskState =
    task.state === 'todo' ? 'progress'
      : task.state === 'progress' ? 'done'
        : task.state === 'blocked' ? 'progress'
          : 'todo'
  return setTaskState(doc, id, next, now)
}

// Drag-to-reorder. Anchored on the target's id rather than an index so the drop
// lands where the insertion line was drawn even though the rendered list is
// sorted (done sinks to the bottom) rather than in raw order.
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

export function toggleTasksCollapsed(doc: TasksDoc): TasksDoc {
  return { ...doc, collapsed: !doc.collapsed }
}

export function setTasksHeight(doc: TasksDoc, height: number): TasksDoc {
  return { ...doc, height: clampTasksHeight(height) }
}

export function clampTasksHeight(height: number): number {
  if (!Number.isFinite(height)) return TASKS_DEFAULT_HEIGHT
  return Math.min(Math.max(Math.round(height), TASKS_MIN_HEIGHT), TASKS_MAX_HEIGHT)
}

// Render order: open work first, in the state order above, and within a state
// the user's own arrangement. Done sinks to the bottom, most recently finished
// first, so finishing something moves it out of the way without deleting it.
export function sortTasks(tasks: Task[]): Task[] {
  return [...tasks]
    .map((task, i) => ({ task, i }))
    .sort((a, b) => {
      const rank = STATE_ORDER.indexOf(a.task.state) - STATE_ORDER.indexOf(b.task.state)
      if (rank !== 0) return rank
      if (a.task.state === 'done') return (b.task.doneAt ?? 0) - (a.task.doneAt ?? 0)
      return a.i - b.i
    })
    .map(e => e.task)
}

export interface TaskCounts { open: number; blocked: number; progress: number; done: number }

export function countTasks(tasks: Task[]): TaskCounts {
  const counts: TaskCounts = { open: 0, blocked: 0, progress: 0, done: 0 }
  for (const t of tasks) {
    if (t.state === 'done') counts.done++
    else counts.open++
    if (t.state === 'blocked') counts.blocked++
    if (t.state === 'progress') counts.progress++
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
    collapsed: doc?.collapsed === true,
    height: clampTasksHeight(typeof doc?.height === 'number' ? doc.height : TASKS_DEFAULT_HEIGHT)
  }
}

function isWellFormedTask(t: unknown): t is Task {
  const task = t as Record<string, unknown>
  return typeof task?.id === 'string' && typeof task?.title === 'string' &&
    typeof task?.createdAt === 'number' &&
    STATE_ORDER.includes(task?.state as TaskState) &&
    (task.reason === undefined || typeof task.reason === 'string') &&
    (task.doneAt === undefined || typeof task.doneAt === 'number')
}
