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
