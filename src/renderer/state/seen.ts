// When the user last looked at each worktree. Persisted so a finished agent's
// dot does not reappear across a reload after it has already been reviewed.

const KEY = 'wtm.seenAt'

export function loadSeenAt(): Record<string, number> {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? '{}')
  } catch {
    return {} // corrupt storage costs a stale dot, not a crash
  }
}

export function saveSeenAt(seenAt: Record<string, number>): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(seenAt))
  } catch { /* quota or private mode; the dot just persists */ }
}

// Which repo a new task should default to — the one the last task was created
// with. Lives beside the other renderer-local preferences, and reads through
// the same try/catch: storage can be missing entirely (tests, private mode),
// and a missing default is a dropdown on its first entry, not a crash.
const NEW_TASK_REPO_KEY = 'wtm.newTaskRepo'

export function loadNewTaskRepo(): string {
  try { return localStorage.getItem(NEW_TASK_REPO_KEY) ?? '' } catch { return '' }
}

export function saveNewTaskRepo(repo: string): void {
  try { localStorage.setItem(NEW_TASK_REPO_KEY, repo) } catch { /* nothing to lose */ }
}

// Worktrees the user has marked unread by hand (Ctrl+S U). Stored as a plain list of
// paths rather than a map, since the only question ever asked of it is
// membership. Persisted alongside seenAt so a deliberate "come back to this"
// survives a reload — the whole point of marking it.
const UNREAD_KEY = 'wtm.unread'

export function loadUnread(): Record<string, boolean> {
  try {
    const paths: unknown = JSON.parse(localStorage.getItem(UNREAD_KEY) ?? '[]')
    if (!Array.isArray(paths)) return {}
    return Object.fromEntries(paths.filter(p => typeof p === 'string').map(p => [p, true]))
  } catch {
    return {} // corrupt storage costs a mark, not a crash
  }
}

export function saveUnread(unread: Record<string, boolean>): void {
  try {
    localStorage.setItem(UNREAD_KEY, JSON.stringify(Object.keys(unread).filter(p => unread[p])))
  } catch { /* quota or private mode; the mark just doesn't survive a reload */ }
}
