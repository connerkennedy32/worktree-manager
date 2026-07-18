// Process-table inspection for the agent-status backstop. Answers exactly one
// question: does this pty still have a live claude in its subtree? Used only to
// clear a stale status, never to set one — hooks are the source of truth.
// No electron import: this runs inside the daemon's plain Node process.

import { exec } from 'child_process'

export interface ProcEntry {
  pid: number
  ppid: number
  comm: string
}

const LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/

/**
 * Parses `ps -axo pid,ppid,comm`. `comm` may contain spaces (e.g.
 * "claude bg-pty-host"), so only the first two whitespace-separated fields are
 * split off and the remainder is kept verbatim.
 */
export function parseProcessTable(psOutput: string): ProcEntry[] {
  const entries: ProcEntry[] = []
  for (const line of psOutput.split('\n')) {
    const m = LINE.exec(line)
    if (!m) continue // header ("PID PPID COMM") and blank lines
    const comm = m[3].trim()
    if (!comm) continue
    entries.push({ pid: Number(m[1]), ppid: Number(m[2]), comm })
  }
  return entries
}

/**
 * True when a `comm` names the claude CLI. Handles the bare name, an absolute
 * path, and a name with trailing argv words. Deliberately does NOT match the
 * versioned binary (".../versions/2.1.201") — those are claude's own daemon
 * processes, reparented to launchd, and outside any pty's subtree.
 */
export function isAgentComm(comm: string): boolean {
  const first = comm.trim().split(/\s+/)[0] ?? ''
  return first.slice(first.lastIndexOf('/') + 1) === 'claude'
}

function buildChildIndex(entries: ProcEntry[]): Map<number, ProcEntry[]> {
  const children = new Map<number, ProcEntry[]>()
  for (const e of entries) {
    const siblings = children.get(e.ppid)
    if (siblings) siblings.push(e)
    else children.set(e.ppid, [e])
  }
  return children
}

/**
 * Breadth-first search of rootPid's subtree (excluding rootPid itself) for an
 * entry matching `match`. `visited` guards against a cyclic ppid chain, which
 * a torn process table can briefly produce.
 */
function hasDescendantMatching(entries: ProcEntry[], rootPid: number, match: (e: ProcEntry) => boolean): boolean {
  const children = buildChildIndex(entries)
  const visited = new Set<number>([rootPid])
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (visited.has(entry.pid)) continue
    visited.add(entry.pid)
    if (match(entry)) return true
    queue.push(...(children.get(entry.pid) ?? []))
  }
  return false
}

/** True when any descendant of rootPid (excluding rootPid itself) is a claude process. */
export function hasAgentDescendant(entries: ProcEntry[], rootPid: number): boolean {
  return hasDescendantMatching(entries, rootPid, e => isAgentComm(e.comm))
}

/** True when a `comm` names the tmux binary (client or server). */
export function isTmuxComm(comm: string): boolean {
  const first = comm.trim().split(/\s+/)[0] ?? ''
  return first.slice(first.lastIndexOf('/') + 1) === 'tmux'
}

/**
 * Pids of detached tmux *servers* — tmux daemonizes on first run, so a
 * server is a `tmux` process reparented to pid 1, distinct from the `tmux`
 * *client* process a pty runs to attach/create a session (a normal child of
 * that pty's shell).
 */
export function detachedTmuxServerPids(entries: ProcEntry[]): number[] {
  return entries.filter(e => e.ppid === 1 && isTmuxComm(e.comm)).map(e => e.pid)
}

/**
 * `hasAgentDescendant`, extended for tmux. A pane's shell is a child of the
 * tmux *server* process, not of the pty that ran `tmux attach`/`tmux new` —
 * that pty only has the tmux *client* as a descendant — so claude running
 * inside tmux is invisible to a plain subtree walk from the pty's root pid.
 *
 * If this pty's subtree contains a tmux client at all, additionally search
 * every detached tmux server's subtree for a claude process. This can't tell
 * *which* server a given client is attached to (that's a socket, not a ppid
 * link), so on a shared default socket this may report "still alive" for a
 * worktree whose own claude actually died, as long as some other worktree's
 * claude survives on the same server. That is the intended failure
 * direction: the ps backstop must never falsely clear a live status, and a
 * false "still alive" only delays a clear rather than lying about a running
 * turn — matching the false "not gone" bias already accepted for a failing
 * `ps` (see AgentTracker.sweep).
 */
export function hasAgentDescendantThroughTmux(entries: ProcEntry[], rootPid: number): boolean {
  if (hasAgentDescendant(entries, rootPid)) return true
  if (!hasDescendantMatching(entries, rootPid, e => isTmuxComm(e.comm))) return false
  return detachedTmuxServerPids(entries).some(serverPid => hasAgentDescendant(entries, serverPid))
}

/** Reads the process table. One call serves every session. */
export function readProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec('ps -axo pid,ppid,comm', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}
