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

/** True when any descendant of rootPid (excluding rootPid itself) is a claude process. */
export function hasAgentDescendant(entries: ProcEntry[], rootPid: number): boolean {
  const children = new Map<number, ProcEntry[]>()
  for (const e of entries) {
    const siblings = children.get(e.ppid)
    if (siblings) siblings.push(e)
    else children.set(e.ppid, [e])
  }

  // Breadth-first over the subtree. `visited` guards against a cyclic ppid
  // chain, which a torn process table can briefly produce.
  const visited = new Set<number>([rootPid])
  const queue = [...(children.get(rootPid) ?? [])]
  while (queue.length > 0) {
    const entry = queue.shift()!
    if (visited.has(entry.pid)) continue
    visited.add(entry.pid)
    if (isAgentComm(entry.comm)) return true
    queue.push(...(children.get(entry.pid) ?? []))
  }
  return false
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
