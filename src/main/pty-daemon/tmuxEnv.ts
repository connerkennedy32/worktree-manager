// Makes the agent-status hook work inside tmux.
//
// The hook script needs WTM_TERMINAL_ID and WTM_HOOK_SOCKET in claude's
// process env. A pty's shell gets them at spawn time, but tmux does not pass
// live shell env into panes: a session created on an already-running tmux
// server inherits that server's original startup environment, not the
// attaching client's current one — except for variable names listed in
// tmux's `update-environment` option, which tmux copies from the client into
// the session at new-session/attach-session time. So this best-effort adds
// our two names to that list (in-memory server option, never touches the
// user's tmux.conf) whenever a tmux server happens to already be running.
// Panes that existed before this runs are unaffected; new panes/sessions
// created afterward pick up the values.

import { exec } from 'child_process'

export const REQUIRED_NAMES = ['WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET'] as const

/** Parses `tmux show-options -g update-environment` output: one `update-environment[N] NAME` line per entry. */
export function parseUpdateEnvironment(raw: string): string[] {
  const names: string[] = []
  for (const line of raw.split('\n')) {
    const m = /^update-environment\[\d+\]\s+(\S+)\s*$/.exec(line)
    if (m) names.push(m[1])
  }
  return names
}

/** Appends any missing names, preserving existing order and entries. */
export function mergeUpdateEnvironment(current: readonly string[], additions: readonly string[]): string[] {
  const merged = [...current]
  for (const name of additions) if (!merged.includes(name)) merged.push(name)
  return merged
}

function run(cmd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    exec(cmd, (err, stdout) => { if (err) reject(err); else resolve(stdout) })
  })
}

/**
 * Best-effort. Does nothing (and never throws) when tmux is not installed or
 * no server is currently running — this must never start a tmux server as a
 * side effect of opening a worktree tab.
 */
export async function ensureTmuxUpdateEnvironment(names: readonly string[] = REQUIRED_NAMES): Promise<void> {
  try {
    const raw = await run('tmux show-options -g update-environment')
    const current = parseUpdateEnvironment(raw)
    const merged = mergeUpdateEnvironment(current, names)
    if (merged.length === current.length) return // already covers our names
    await run(`tmux set-option -g update-environment "${merged.join(' ')}"`)
  } catch {
    // No server running, tmux not installed, or a transient failure — the
    // raw-shell case still works without this, so just skip.
  }
}
