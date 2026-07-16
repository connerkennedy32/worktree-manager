# Agent Status Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show in each sidebar row whether a `claude` agent is running in that worktree's terminal, and whether it is working or waiting on the user.

**Architecture:** The pty-daemon owns the PTYs and their pids, so detection lives there. It polls `ps` every 2s, resolves each session to `none`/`working`/`waiting`, and broadcasts only on change over the existing Unix-socket protocol. The main process forwards to the renderer via IPC; the sidebar renders a dot.

**Tech Stack:** TypeScript, Electron, node-pty, zustand, React, vitest.

**Spec:** `docs/superpowers/specs/2026-07-16-agent-status-indicator-design.md`

## Global Constraints

- `src/main/pty-daemon/protocol.ts` must not import electron or node-pty — it is required from the daemon's plain Node process.
- `src/main/pty-daemon/agentWatcher.ts` must not import electron — same reason.
- Match agent name `claude` only.
- Quiet threshold for `working`: **750ms**.
- Poll interval: **2000ms**.
- Broadcast on **change only**.
- Tests live in `tests/` mirroring `src/`. Run with `npx vitest run`.
- Existing code style: 2-space indent, no semicolons, single quotes.

---

### Task 1: Process-table parsing and status resolution (pure logic)

The whole feature rests on correctly identifying a `claude` descendant. This task is pure functions over strings and numbers — no PTYs, no timers, no sockets.

**Files:**
- Create: `src/main/pty-daemon/agentWatcher.ts`
- Test: `tests/pty-daemon/agentWatcher.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type AgentStatus = 'none' | 'working' | 'waiting'`
  - `interface ProcEntry { pid: number; ppid: number; comm: string }`
  - `parseProcessTable(psOutput: string): ProcEntry[]`
  - `isAgentComm(comm: string): boolean`
  - `hasAgentDescendant(entries: ProcEntry[], rootPid: number): boolean`
  - `resolveStatus(entries: ProcEntry[], rootPid: number, lastDataAt: number, now: number): AgentStatus`
  - `const QUIET_MS = 750`

**Background — real `ps -axo pid,ppid,comm` output on this machine:**

```
  PID  PPID COMM
15820 11275 claude
54405 54052 /Users/connerkennedy/.local/bin/claude
22867 22772 claude bg-pty-host
77291     1 /Users/connerkennedy/.local/share/claude/versions/2.1.201
```

Three traps this encodes, all covered by the tests below:
- `comm` can contain **spaces** — never split the whole line on whitespace.
- `comm` can be an **absolute path** — basename it.
- Version-numbered `comm` values are Claude's own daemon infrastructure with `ppid 1`; they must NOT match, and the descendant walk never reaches them anyway.

- [ ] **Step 1: Write the failing tests**

Create `tests/pty-daemon/agentWatcher.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseProcessTable, isAgentComm, hasAgentDescendant, resolveStatus, QUIET_MS
} from '../../src/main/pty-daemon/agentWatcher'

// Verbatim shape of `ps -axo pid,ppid,comm` on macOS, including the header.
const PS_SAMPLE = [
  '  PID  PPID COMM',
  '    1     0 /sbin/launchd',
  '11275 54626 -zsh',
  '15820 11275 claude',
  '22867 22772 claude bg-pty-host',
  '54405 54052 /Users/connerkennedy/.local/bin/claude',
  '77291     1 /Users/connerkennedy/.local/share/claude/versions/2.1.201'
].join('\n')

describe('parseProcessTable', () => {
  it('skips the header row', () => {
    expect(parseProcessTable(PS_SAMPLE).some(e => e.comm === 'COMM')).toBe(false)
  })

  it('parses pid and ppid as numbers', () => {
    const e = parseProcessTable(PS_SAMPLE).find(e => e.pid === 15820)!
    expect(e).toEqual({ pid: 15820, ppid: 11275, comm: 'claude' })
  })

  it('keeps a comm containing spaces intact', () => {
    const e = parseProcessTable(PS_SAMPLE).find(e => e.pid === 22867)!
    expect(e.comm).toBe('claude bg-pty-host')
  })

  it('keeps an absolute-path comm intact', () => {
    const e = parseProcessTable(PS_SAMPLE).find(e => e.pid === 54405)!
    expect(e.comm).toBe('/Users/connerkennedy/.local/bin/claude')
  })

  it('ignores blank lines', () => {
    expect(parseProcessTable('  PID  PPID COMM\n\n15820 11275 claude\n')).toHaveLength(1)
  })
})

describe('isAgentComm', () => {
  it('matches a bare claude', () => {
    expect(isAgentComm('claude')).toBe(true)
  })

  it('matches an absolute path to claude', () => {
    expect(isAgentComm('/Users/connerkennedy/.local/bin/claude')).toBe(true)
  })

  it('matches claude with trailing argv words', () => {
    expect(isAgentComm('claude bg-pty-host')).toBe(true)
  })

  it('does not match the versioned daemon binary', () => {
    expect(isAgentComm('/Users/connerkennedy/.local/share/claude/versions/2.1.201')).toBe(false)
  })

  it('does not match a shell', () => {
    expect(isAgentComm('-zsh')).toBe(false)
  })

  it('does not match a substring of another command', () => {
    expect(isAgentComm('claudette')).toBe(false)
    expect(isAgentComm('/usr/bin/notclaude')).toBe(false)
  })
})

describe('hasAgentDescendant', () => {
  const tree: { pid: number; ppid: number; comm: string }[] = [
    { pid: 1, ppid: 0, comm: '/sbin/launchd' },
    { pid: 100, ppid: 1, comm: '/bin/zsh' },   // our PTY shell
    { pid: 200, ppid: 100, comm: 'claude' },   // direct child
    { pid: 300, ppid: 1, comm: '/bin/zsh' },   // unrelated shell
    { pid: 400, ppid: 300, comm: 'vim' }
  ]

  it('finds a direct claude child', () => {
    expect(hasAgentDescendant(tree, 100)).toBe(true)
  })

  it('finds a claude nested under an intermediate process', () => {
    const nested = [
      { pid: 100, ppid: 1, comm: '/bin/zsh' },
      { pid: 150, ppid: 100, comm: 'npm' },
      { pid: 200, ppid: 150, comm: 'claude' }
    ]
    expect(hasAgentDescendant(nested, 100)).toBe(true)
  })

  it('returns false when the subtree has no claude', () => {
    expect(hasAgentDescendant(tree, 300)).toBe(false)
  })

  it('returns false for a shell with no children', () => {
    expect(hasAgentDescendant(tree, 999)).toBe(false)
  })

  it('does not match claude outside the subtree', () => {
    // pid 200 (claude) hangs off 100, so 300's subtree must stay clean
    expect(hasAgentDescendant(tree, 300)).toBe(false)
  })

  it('ignores the daemon subtree reparented to launchd', () => {
    const daemonish = [
      { pid: 100, ppid: 1, comm: '/bin/zsh' },
      { pid: 900, ppid: 1, comm: 'claude bg-pty-host' }
    ]
    expect(hasAgentDescendant(daemonish, 100)).toBe(false)
  })

  it('terminates on a cyclic parent chain', () => {
    const cyclic = [
      { pid: 10, ppid: 11, comm: 'a' },
      { pid: 11, ppid: 10, comm: 'b' }
    ]
    expect(hasAgentDescendant(cyclic, 10)).toBe(false)
  })
})

describe('resolveStatus', () => {
  const withAgent = [
    { pid: 100, ppid: 1, comm: '/bin/zsh' },
    { pid: 200, ppid: 100, comm: 'claude' }
  ]
  const noAgent = [{ pid: 100, ppid: 1, comm: '/bin/zsh' }]
  const NOW = 1_000_000

  it('is none when no agent is present, however recent the output', () => {
    expect(resolveStatus(noAgent, 100, NOW, NOW)).toBe('none')
  })

  it('is working when an agent is present and output is recent', () => {
    expect(resolveStatus(withAgent, 100, NOW - 100, NOW)).toBe('working')
  })

  it('is waiting when an agent is present but output is quiet', () => {
    expect(resolveStatus(withAgent, 100, NOW - QUIET_MS - 1, NOW)).toBe('waiting')
  })

  it('treats exactly QUIET_MS of silence as waiting', () => {
    expect(resolveStatus(withAgent, 100, NOW - QUIET_MS, NOW)).toBe('waiting')
  })

  it('treats one ms under QUIET_MS as working', () => {
    expect(resolveStatus(withAgent, 100, NOW - QUIET_MS + 1, NOW)).toBe('working')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pty-daemon/agentWatcher.test.ts`
Expected: FAIL — cannot resolve `../../src/main/pty-daemon/agentWatcher`.

- [ ] **Step 3: Write the implementation**

Create `src/main/pty-daemon/agentWatcher.ts`:

```ts
// Detects whether a `claude` agent is running inside a PTY's process subtree,
// and whether it is actively working. Pure logic + a poll loop; no electron
// import — this runs inside the daemon's plain Node process.

export type AgentStatus = 'none' | 'working' | 'waiting'

export interface ProcEntry {
  pid: number
  ppid: number
  comm: string
}

// Claude Code repaints its spinner continuously while thinking, so output that
// has gone quiet for this long means it is waiting on the user rather than working.
export const QUIET_MS = 750

const LINE = /^\s*(\d+)\s+(\d+)\s+(.*)$/

/**
 * Parses `ps -axo pid,ppid,comm` output. `comm` may contain spaces (e.g.
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
 * processes, reparented to launchd, and outside any PTY's subtree.
 */
export function isAgentComm(comm: string): boolean {
  const first = comm.trim().split(/\s+/)[0] ?? ''
  const base = first.slice(first.lastIndexOf('/') + 1)
  return base === 'claude'
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

/** Resolves one PTY session to an agent status. Pure: no clock, no process access. */
export function resolveStatus(
  entries: ProcEntry[], rootPid: number, lastDataAt: number, now: number
): AgentStatus {
  if (!hasAgentDescendant(entries, rootPid)) return 'none'
  return now - lastDataAt < QUIET_MS ? 'working' : 'waiting'
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/agentWatcher.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/agentWatcher.ts tests/pty-daemon/agentWatcher.test.ts
git commit -m "Add agent process detection and status resolution"
```

---

### Task 2: Expose pid and lastDataAt from PtyManager

The watcher needs each session's root pid and time of last output. Both already exist inside `PtyManager` but are not reachable.

**Files:**
- Modify: `src/main/pty-daemon/sessionStore.ts:4` (Session type), `:19-24` (onData handler), `:29-31` (accessors)
- Test: `tests/pty-daemon/sessionStore.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PtyManager.pid(worktreePath: string): number | undefined`
  - `PtyManager.lastDataAt(worktreePath: string): number | undefined`

- [ ] **Step 1: Write the failing test**

Append to `tests/pty-daemon/sessionStore.test.ts` inside the existing `describe('PtyManager', ...)` block:

```ts
  it('exposes the session pid and stamps lastDataAt on output', async () => {
    mgr = new PtyManager()
    const p = homedir()
    mgr.start(p, () => {})

    expect(mgr.pid(p)).toBeGreaterThan(0)
    expect(mgr.pid('/no/such/worktree')).toBeUndefined()
    expect(mgr.lastDataAt('/no/such/worktree')).toBeUndefined()

    // Wait for the shell's own prompt output to stamp lastDataAt.
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if ((mgr!.lastDataAt(p) ?? 0) > 0) { clearInterval(iv); resolve() }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); reject(new Error('timeout')) }
      }, 50)
    })

    const first = mgr.lastDataAt(p)!
    mgr.write(p, 'echo wtm_stamp\n')
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (mgr!.lastDataAt(p)! > first) { clearInterval(iv); resolve() }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); reject(new Error('timeout')) }
      }, 50)
    })
    expect(mgr.lastDataAt(p)!).toBeGreaterThan(first)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pty-daemon/sessionStore.test.ts`
Expected: FAIL — `mgr.pid is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/main/pty-daemon/sessionStore.ts`, change the `Session` type (line 4):

```ts
type Session = { proc: pty.IPty; buffer: string; lastDataAt: number }
```

Change the session construction and `onData` handler (lines 19-24) to stamp the time:

```ts
    const session: Session = { proc, buffer: '', lastDataAt: 0 }
    proc.onData(d => {
      session.buffer += d
      if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER)
      session.lastDataAt = Date.now()
      onData(d)
    })
```

Add two accessors next to the existing ones (after line 31, beside `list()`):

```ts
  pid(worktreePath: string) { return this.sessions.get(worktreePath)?.proc.pid }
  lastDataAt(worktreePath: string) { return this.sessions.get(worktreePath)?.lastDataAt }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/sessionStore.test.ts`
Expected: PASS, both tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/sessionStore.ts tests/pty-daemon/sessionStore.test.ts
git commit -m "Expose pty session pid and last-output time"
```

---

### Task 3: Protocol message and change-only broadcast

**Files:**
- Modify: `src/shared/ipc-types.ts` (add `AgentStatus`)
- Modify: `src/main/pty-daemon/protocol.ts:7-22`
- Modify: `src/main/pty-daemon/agentWatcher.ts` (add the `AgentWatcher` class)
- Test: `tests/pty-daemon/agentWatcher.test.ts` (append)

**Interfaces:**
- Consumes: `parseProcessTable`, `resolveStatus` (Task 1); `PtyManager.pid`, `PtyManager.lastDataAt`, `PtyManager.list` (Task 2).
- Produces:
  - `AgentStatus` re-exported from `@shared/ipc-types`
  - `ServerMessage` variant `{ type: 'agentStatus'; path: string; status: AgentStatus }`
  - `class AgentWatcher` with `constructor(sessions: AgentWatcherSessions, emit: (path: string, status: AgentStatus) => void, readTable: () => Promise<string>)`, `tick(): Promise<void>`, `start(): void`, `stop(): void`, `snapshot(): Record<string, AgentStatus>`
  - `interface AgentWatcherSessions { list(): string[]; pid(p: string): number | undefined; lastDataAt(p: string): number | undefined }`

`AgentStatus` is declared in `@shared/ipc-types` (it crosses the IPC boundary to the renderer) and imported by `agentWatcher.ts`. `@shared/ipc-types` contains only types and a const map — no electron import — so the daemon's plain Node process can require it.

Note: `readTable` is injected so `tick()` is testable without shelling out.

- [ ] **Step 1: Write the failing tests**

In `tests/pty-daemon/agentWatcher.test.ts`, extend the existing import from Task 1 to add `AgentWatcher`:

```ts
import {
  parseProcessTable, isAgentComm, hasAgentDescendant, resolveStatus, QUIET_MS, AgentWatcher
} from '../../src/main/pty-daemon/agentWatcher'
```

Then append:

```ts
describe('AgentWatcher', () => {
  const TABLE_WITH_AGENT = ['  PID  PPID COMM', '100 1 /bin/zsh', '200 100 claude'].join('\n')
  const TABLE_NO_AGENT = ['  PID  PPID COMM', '100 1 /bin/zsh'].join('\n')

  function fakeSessions(paths: string[], lastDataAt: number) {
    return {
      list: () => paths,
      pid: (p: string) => (paths.includes(p) ? 100 : undefined),
      lastDataAt: (p: string) => (paths.includes(p) ? lastDataAt : undefined)
    }
  }

  it('emits a status for a session on first tick', async () => {
    const seen: [string, string][] = []
    const w = new AgentWatcher(
      fakeSessions(['/wt/a'], Date.now()),
      (p, s) => seen.push([p, s]),
      async () => TABLE_WITH_AGENT
    )
    await w.tick()
    expect(seen).toEqual([['/wt/a', 'working']])
  })

  it('does not re-emit an unchanged status', async () => {
    const seen: [string, string][] = []
    const w = new AgentWatcher(
      fakeSessions(['/wt/a'], Date.now()),
      (p, s) => seen.push([p, s]),
      async () => TABLE_WITH_AGENT
    )
    await w.tick()
    await w.tick()
    await w.tick()
    expect(seen).toHaveLength(1)
  })

  it('emits again when the status changes', async () => {
    const seen: [string, string][] = []
    let table = TABLE_WITH_AGENT
    const w = new AgentWatcher(
      fakeSessions(['/wt/a'], Date.now()),
      (p, s) => seen.push([p, s]),
      async () => table
    )
    await w.tick()
    table = TABLE_NO_AGENT
    await w.tick()
    expect(seen).toEqual([['/wt/a', 'working'], ['/wt/a', 'none']])
  })

  it('reports waiting when output has gone quiet', async () => {
    const seen: [string, string][] = []
    const w = new AgentWatcher(
      fakeSessions(['/wt/a'], Date.now() - 5000),
      (p, s) => seen.push([p, s]),
      async () => TABLE_WITH_AGENT
    )
    await w.tick()
    expect(seen).toEqual([['/wt/a', 'waiting']])
  })

  it('exposes a snapshot of current statuses', async () => {
    const w = new AgentWatcher(
      fakeSessions(['/wt/a'], Date.now()),
      () => {},
      async () => TABLE_WITH_AGENT
    )
    await w.tick()
    expect(w.snapshot()).toEqual({ '/wt/a': 'working' })
  })

  it('drops sessions that have gone away', async () => {
    let paths = ['/wt/a']
    const w = new AgentWatcher(
      { list: () => paths, pid: () => 100, lastDataAt: () => Date.now() },
      () => {},
      async () => TABLE_WITH_AGENT
    )
    await w.tick()
    paths = []
    await w.tick()
    expect(w.snapshot()).toEqual({})
  })

  it('survives a failing ps without throwing', async () => {
    const w = new AgentWatcher(
      fakeSessions(['/wt/a'], Date.now()),
      () => {},
      async () => { throw new Error('ps exploded') }
    )
    await expect(w.tick()).resolves.toBeUndefined()
    expect(w.snapshot()).toEqual({})
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pty-daemon/agentWatcher.test.ts`
Expected: FAIL — `AgentWatcher is not a constructor`.

- [ ] **Step 3: Write the implementation**

Add to `src/shared/ipc-types.ts`, after the `WorktreeStatus` interface (line 20):

```ts
export type AgentStatus = 'none' | 'working' | 'waiting'
```

In `src/main/pty-daemon/protocol.ts`, import the type at the top and add the `ServerMessage` variant:

```ts
import type { AgentStatus } from '@shared/ipc-types'
```

```ts
export type ServerMessage =
  | { type: 'welcome'; version: number }
  | { type: 'data'; path: string; chunk: string }
  | { type: 'list'; reqId: number; paths: string[] }
  | { type: 'replayResponse'; reqId: number; path: string; buffer: string }
  | { type: 'agentStatus'; path: string; status: AgentStatus }
```

In `src/main/pty-daemon/agentWatcher.ts`, replace the local `AgentStatus` declaration from Task 1 with an import, so the type has one home. At the **top of the file**, the import block becomes:

```ts
import { exec } from 'child_process'
import type { AgentStatus } from '@shared/ipc-types'

export type { AgentStatus }
```

(Delete the `export type AgentStatus = 'none' | 'working' | 'waiting'` line added in Task 1.)

Then append the rest to the end of the file:

```ts
const POLL_MS = 2000

/** The slice of PtyManager the watcher needs. Narrow on purpose: keeps tests trivial. */
export interface AgentWatcherSessions {
  list(): string[]
  pid(worktreePath: string): number | undefined
  lastDataAt(worktreePath: string): number | undefined
}

/** Reads the process table. One `ps` call serves every session. */
export function readProcessTable(): Promise<string> {
  return new Promise((resolve, reject) => {
    exec('ps -axo pid,ppid,comm', { maxBuffer: 8 * 1024 * 1024 }, (err, stdout) => {
      if (err) reject(err)
      else resolve(stdout)
    })
  })
}

export class AgentWatcher {
  private statuses = new Map<string, AgentStatus>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private sessions: AgentWatcherSessions,
    private emit: (path: string, status: AgentStatus) => void,
    private readTable: () => Promise<string> = readProcessTable
  ) {}

  /** One poll cycle. Emits only for sessions whose status changed. */
  async tick(): Promise<void> {
    let entries: ProcEntry[]
    try {
      entries = parseProcessTable(await this.readTable())
    } catch {
      return // a failed ps is transient; keep the last known statuses
    }

    const now = Date.now()
    const live = new Set(this.sessions.list())

    for (const path of live) {
      const pid = this.sessions.pid(path)
      const lastDataAt = this.sessions.lastDataAt(path)
      if (pid === undefined || lastDataAt === undefined) continue
      const status = resolveStatus(entries, pid, lastDataAt, now)
      if (this.statuses.get(path) === status) continue
      this.statuses.set(path, status)
      this.emit(path, status)
    }

    // Forget sessions whose pty exited, so a recreated worktree starts clean.
    for (const path of [...this.statuses.keys()]) {
      if (!live.has(path)) this.statuses.delete(path)
    }
  }

  snapshot(): Record<string, AgentStatus> {
    return Object.fromEntries(this.statuses)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.tick() }, POLL_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/agentWatcher.test.ts`
Expected: PASS, all Task 1 and Task 3 tests green.

- [ ] **Step 5: Verify the typecheck passes**

Run: `npx tsc --noEmit`
Expected: no errors.

The `@shared` import is safe for the daemon despite its "no electron" constraint: the daemon is built by the `main` config in `electron.vite.config.ts`, which declares the `@shared` alias (line 20), and both new imports are `import type` — erased at compile time, so they add no runtime dependency to the daemon bundle at all.

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-types.ts src/main/pty-daemon/protocol.ts src/main/pty-daemon/agentWatcher.ts tests/pty-daemon/agentWatcher.test.ts
git commit -m "Add agent status watcher with change-only emission"
```

---

### Task 4: Wire the watcher into the daemon

**Files:**
- Modify: `src/main/pty-daemon/daemon.ts`

**Interfaces:**
- Consumes: `AgentWatcher` (Task 3), `PtyManager` (Task 2).
- Produces: daemon broadcasts `agentStatus` on change, and sends a full snapshot to each client on `hello`.

- [ ] **Step 1: Add the watcher to the daemon**

In `src/main/pty-daemon/daemon.ts`, add the import beside the existing `PtyManager` import:

```ts
import { AgentWatcher } from './agentWatcher'
```

After `const clients = new Set<net.Socket>()` and the `broadcast` function, create and start the watcher:

```ts
// Detection lives here rather than in the Electron main process: the daemon owns
// the ptys and their pids, and outlives the app.
const agents = new AgentWatcher(sessions, (path, status) => broadcast({ type: 'agentStatus', path, status }))
agents.start()
```

In `handleMessage`, extend the `hello` case so a newly connected client gets current state instead of waiting for the next change:

```ts
    case 'hello':
      sock.write(encodeFrame({ type: 'welcome', version: PROTOCOL_VERSION } satisfies ServerMessage))
      for (const [path, status] of Object.entries(agents.snapshot())) {
        sock.write(encodeFrame({ type: 'agentStatus', path, status } satisfies ServerMessage))
      }
      return
```

`PtyManager` structurally satisfies `AgentWatcherSessions` via the `list`/`pid`/`lastDataAt` methods from Task 2, so no cast is needed.

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors in `daemon.ts`.

- [ ] **Step 3: Verify the full suite still passes**

Run: `npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 4: Commit**

```bash
git add src/main/pty-daemon/daemon.ts
git commit -m "Broadcast agent status from the pty daemon"
```

---

### Task 5: Forward agent status to the renderer

**Files:**
- Modify: `src/main/pty-daemon/client.ts:51-67` (fields/constructor), `:69-93` (handleMessage), `:114-147` (connect)
- Modify: `src/main/ipc.ts:40` (connect call), add handler
- Modify: `src/shared/ipc-types.ts` (Api + IPC map)
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `AgentStatus` (Task 3), the `agentStatus` `ServerMessage` (Task 3).
- Produces:
  - `PtyDaemonClient.connect(onData, onAgentStatus)` — second parameter added
  - `PtyDaemonClient.agentStatuses(): Record<string, AgentStatus>`
  - `Api.getAgentStatuses(): Promise<Record<string, AgentStatus>>`
  - `Api.onAgentStatus(cb: (worktreePath: string, status: AgentStatus) => void): () => void`
  - `IPC.getAgentStatuses = 'agent:list'`, `IPC.agentStatus = 'agent:status'`

Both a push and a fetch are needed: `registerIpc` guards with `registered` (`ipc.ts:37`) so the daemon client connects only once, meaning a renderer reload never re-triggers the connect-time snapshot. The client caches statuses and the renderer fetches them on init.

- [ ] **Step 1: Add the client-side cache and callback**

In `src/main/pty-daemon/client.ts`, import the type:

```ts
import type { AgentStatus } from '@shared/ipc-types'
```

Add a field beside `private buffers = new Map<string, string>()` (line 56):

```ts
  private agents = new Map<string, AgentStatus>()
  private onAgentStatus: (path: string, status: AgentStatus) => void
```

Change the constructor (lines 61-67) to accept and store it:

```ts
  private constructor(
    socket: net.Socket,
    onData: (path: string, data: string) => void,
    onAgentStatus: (path: string, status: AgentStatus) => void
  ) {
    this.socket = socket
    this.onData = onData
    this.onAgentStatus = onAgentStatus
    this.socket.on('data', chunk => {
      for (const message of this.decoder.push(chunk)) this.handleMessage(message as ServerMessage)
    })
  }
```

Add a case to `handleMessage` (after the `replayResponse` case, line 91):

```ts
      case 'agentStatus': {
        this.agents.set(message.path, message.status)
        this.onAgentStatus(message.path, message.status)
        return
      }
```

Change the `connect` signature (line 114) and the construction (line 137):

```ts
  static async connect(
    onData: (path: string, data: string) => void,
    onAgentStatus: (path: string, status: AgentStatus) => void
  ): Promise<PtyDaemonClient> {
```

```ts
    const client = new PtyDaemonClient(socket, onData, onAgentStatus)
```

Add an accessor beside `list()` (line 157):

```ts
  agentStatuses(): Record<string, AgentStatus> { return Object.fromEntries(this.agents) }
```

Add cleanup in `kill` (line 162) and `killAll` (line 168), beside the existing `buffers` cleanup:

```ts
    this.agents.delete(path)
```

```ts
    this.agents.clear()
```

- [ ] **Step 2: Add the shared types**

In `src/shared/ipc-types.ts`, add to the `Api` interface after `onStatusChanged` (line 75):

```ts
  getAgentStatuses(): Promise<Record<string, AgentStatus>>
  onAgentStatus(cb: (worktreePath: string, status: AgentStatus) => void): () => void
```

Add to the `IPC` const map, after the `termData`/`statusChanged` line (line 91):

```ts
  getAgentStatuses: 'agent:list', agentStatus: 'agent:status',
```

- [ ] **Step 3: Wire the main process**

In `src/main/ipc.ts`, change the connect call (line 40):

```ts
  ptys = await PtyDaemonClient.connect(
    (p, d) => send(IPC.termData, p, d),
    (p, s) => send(IPC.agentStatus, p, s)
  )
```

Add a handler beside `IPC.listTerminals` (line 74):

```ts
  ipcMain.handle(IPC.getAgentStatuses, () => ptys.agentStatuses())
```

- [ ] **Step 4: Expose it in the preload**

In `src/preload/index.ts`, add after `listTerminals` (line 20):

```ts
  getAgentStatuses: () => ipcRenderer.invoke(IPC.getAgentStatuses),
```

Add after the `onStatusChanged` block (line 34), following the same pattern:

```ts
  onAgentStatus: (cb) => {
    const h = (_e: unknown, p: string, s: AgentStatus) => cb(p, s)
    ipcRenderer.on(IPC.agentStatus, h as any)
    return () => ipcRenderer.removeListener(IPC.agentStatus, h as any)
  },
```

Extend the existing type import at line 2:

```ts
import { IPC, type Api, type AgentStatus } from '@shared/ipc-types'
```

- [ ] **Step 5: Verify it compiles**

Run: `npx tsc --noEmit`
Expected: no errors. TypeScript will flag any `Api` member left unimplemented in the preload — that is the intended check here.

- [ ] **Step 6: Verify the full suite still passes**

Run: `npx vitest run`
Expected: PASS, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/main/pty-daemon/client.ts src/main/ipc.ts src/shared/ipc-types.ts src/preload/index.ts
git commit -m "Forward agent status from daemon to renderer"
```

---

### Task 6: Store state and the sidebar dot

**Files:**
- Modify: `src/renderer/state/store.ts:14-32` (State), `:34-35` (initial), `:39-58` (init)
- Modify: `src/renderer/components/Sidebar.tsx` (add `AgentDot`, render it)
- Modify: `src/renderer/components/sidebar-theme.css` (append)

**Interfaces:**
- Consumes: `Api.getAgentStatuses`, `Api.onAgentStatus` (Task 5).
- Produces: `State.agentStatuses: Record<string, AgentStatus>`; `AgentDot` component (module-local to Sidebar.tsx).

**No unit test in this task, deliberately.** `vitest.config.ts` sets
`include: ['tests/**/*.test.ts']` and `environment: 'node'` with no react
plugin, so component rendering is not set up and a `.tsx` test would not even
be collected. The repo's convention (see `src/renderer/components/changed-files.ts`,
tested by `tests/renderer/changed-files.test.ts`) is to extract *pure logic*
into a module and test that, while leaving presentational components to
typecheck plus manual verification. `AgentDot` is a className concat over a
three-value union — extracting it to make it testable would be ceremony for no
signal. Its verification is `npx tsc --noEmit` (Step 5) and Task 7's
end-to-end pass, which is the only thing that can actually confirm the dot
looks and behaves right.

Do NOT add a react testing environment for this. If a future change puts real
logic in the sidebar, extract it the way `changed-files.ts` was extracted.

- [ ] **Step 1: Add the store state**

In `src/renderer/state/store.ts`, extend the type import (line 2):

```ts
import type { Worktree, WorktreeStatus, AgentStatus } from '@shared/ipc-types'
```

Add to the `State` interface after `statuses` (line 17):

```ts
  agentStatuses: Record<string, AgentStatus>
```

Add to the initial state (line 35):

```ts
  repos: [], worktrees: [], statuses: {}, agentStatuses: {}, openDiff: null, modalOpen: 0,
```

In `init`, after the `onStatusChanged` subscription (line 45), add:

```ts
    // Agent status is pushed from the daemon on change only, so seed the current
    // state once — a renderer reload does not re-trigger the daemon's connect-time
    // snapshot, since the main process connects only once.
    set({ agentStatuses: await window.api.getAgentStatuses() })
    window.api.onAgentStatus((p, s) => set(st => ({ agentStatuses: { ...st.agentStatuses, [p]: s } })))
```

- [ ] **Step 2: Add the dot component and render it**

In `src/renderer/components/Sidebar.tsx`, extend the type import (line 6):

```ts
import type { Worktree, AgentStatus } from '@shared/ipc-types'
```

Add the component after `BranchIcon` (line 28):

```tsx
const AGENT_TITLE: Record<AgentStatus, string> = {
  working: 'Agent working',
  waiting: 'Agent waiting for input',
  none: ''
}

// Always renders, even for 'none': a fixed-width slot keeps every row's label on
// the same x position, so a starting agent never shifts the list sideways.
function AgentDot({ status }: { status: AgentStatus }) {
  return <span className={`wt-agent-dot ${status}`} title={AGENT_TITLE[status]} />
}
```

Pull the state in the component body (line 30):

```ts
  const { worktrees, statuses, agentStatuses, selected, select, refreshWorktrees, repos } = useStore()
```

Inside the row map, beside the existing `count` line:

```ts
                const count = statuses[w.path]?.changeCount ?? 0
                const agent = agentStatuses[w.path] ?? 'none'
```

Render the dot at the leading edge, immediately before the branch/main icon:

```tsx
                        <AgentDot status={agent} />
                        {w.isMain ? <MainDotIcon /> : <BranchIcon />}
                        {w.path.split('/').filter(Boolean).pop()}
```

The dot's 7px width plus the row's 6px gap adds 13px of leading indent, so bump the branch line's `paddingLeft` from `16` to `29` to keep it aligned under the name:

```tsx
                      <span style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis',
                                     whiteSpace: 'nowrap', paddingLeft: 29 }}>
                        {w.branch}
                      </span>
```

- [ ] **Step 3: Add the styles**

Append to `src/renderer/components/sidebar-theme.css`, after `.wt-badge`:

```css
.wt-agent-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
  background: transparent;
}
.wt-agent-dot.working {
  background: #3fb950;
  animation: wt-agent-pulse 1.2s ease-in-out infinite;
}
.wt-agent-dot.waiting { background: #7d8590; }

@keyframes wt-agent-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}

/* Without motion the pulse cannot carry the state, so colour alone must. */
@media (prefers-reduced-motion: reduce) {
  .wt-agent-dot.working { animation: none; }
}
```

- [ ] **Step 4: Verify the full suite and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors. The typecheck is the real gate here — it catches a wrong `AgentStatus` union member or a missing store field.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/state/store.ts src/renderer/components/Sidebar.tsx src/renderer/components/sidebar-theme.css
git commit -m "Show agent status dot in sidebar rows"
```

---

### Task 7: End-to-end verification in the real app

Unit tests cannot prove the spinner-repaint assumption that `working` depends on. This task drives the actual app.

**Files:** none (verification only).

- [ ] **Step 1: Launch the app**

Run: `npm run dev`

- [ ] **Step 2: Confirm the baseline**

With no agent running in any worktree, confirm every sidebar row shows no dot, and that row labels are aligned (the invisible slot must not look like a gap).

- [ ] **Step 3: Confirm `working`**

In one worktree's terminal, type `claude` and give it a task that takes several seconds (e.g. "list every file in this repo and summarise it").

Expected: within ~2s that row shows a **green pulsing** dot. Other rows stay bare.

- [ ] **Step 4: Confirm `waiting`**

Let the agent finish and return to its prompt.

Expected: within ~2s the dot goes **grey and static**. This is the key assertion — it proves the quiet-threshold heuristic separates working from waiting.

- [ ] **Step 5: Confirm the flicker bound**

Watch the dot during a long agent turn.

Expected: it stays green. Brief grey flickers mean Claude Code paused its repaint longer than 750ms — if that happens, raise `QUIET_MS` in `agentWatcher.ts` and note the new value in the spec's "Known weakness" section.

- [ ] **Step 6: Confirm teardown**

Exit the agent with `Ctrl-D`.

Expected: within ~2s the dot disappears entirely.

- [ ] **Step 7: Confirm reload persistence**

With an agent running, reload the window (`Cmd-R`).

Expected: the dot reappears in the correct state without needing a status change — this exercises the `getAgentStatuses()` fetch from Task 5.

- [ ] **Step 8: Commit any threshold change**

Only if Step 5 forced a change:

```bash
git add src/main/pty-daemon/agentWatcher.ts docs/superpowers/specs/2026-07-16-agent-status-indicator-design.md
git commit -m "Tune agent quiet threshold from observed behaviour"
```

---

## Notes for the implementer

- **Do not** try to detect the agent by scraping terminal output for spinner glyphs. Output activity is used only as a coarse "is it emitting anything" signal, gated behind process presence. Scraping ANSI art is brittle across versions.
- **Do not** widen the `claude` match to the versioned binary path. Those processes have `ppid 1` and belong to Claude's own daemon; matching them would light up unrelated rows.
- The `agentStatuses` map is intentionally **not** part of the 3s poll in `store.ts:49`. It is push-driven. Adding it to the poll would duplicate work and defeat the change-only broadcast.
