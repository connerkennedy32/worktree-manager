# Agent Status Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show in each sidebar row what the agent in that worktree is doing — working, blocked on permission, failed, or finished-and-unseen — so any visible dot means "this needs me".

**Architecture:** Claude Code hooks report lifecycle events to a script we install in the user's global settings. The script posts to an HTTP server on a unix socket owned by the pty-daemon, which maps events to per-worktree statuses and broadcasts changes to the renderer. A `ps` check runs only while something is active, purely to clear state when an agent is killed without firing `SessionEnd`.

**Tech Stack:** TypeScript, Electron, node-pty, zustand, React, vitest, bash.

**Spec:** `docs/superpowers/specs/2026-07-16-agent-status-indicator-design.md`

**Prior art:** `github.com/superset-sh/superset` solves this in the same shape of app. Their `deriveTerminalAgentStatus.ts` and `notify-hook.template.sh` are worth reading before starting.

## Global Constraints

- `src/main/pty-daemon/*` must not import electron — the daemon runs as plain Node. `@shared/*` is fine: the daemon is built by the `main` config in `electron.vite.config.ts`, which declares the alias (line 20), and `src/shared/agent-status.ts` is pure TypeScript with no electron dependency. Note `agentTracker.ts` imports `mapHookEvent` as a **value**, so `agent-status.ts` really is bundled into the daemon — it must stay dependency-free. (`protocol.ts` uses `import type` only, so it keeps its zero-runtime-deps property.)
- Hook events used, all verified against https://code.claude.com/docs/en/hooks.md: `UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `StopFailure`, `SessionEnd`. `SessionStart` is deliberately ignored.
- The hook script must `exit 0` on every path. A hook failure must never disturb the user's Claude session.
- Never overwrite `~/.claude/settings.json` that failed to parse. Back up before first write. Write atomically (temp + rename).
- `ps` runs **only** when at least one worktree status is not `none`.
- The `ps` backstop may only clear status to `none`. It must never set a positive status.
- Tests live in `tests/` mirroring `src/`. Run with `npx vitest run`.
- Existing code style: 2-space indent, no semicolons, single quotes.

---

### Task 1: Event mapping and dot derivation (pure)

The entire status model, as pure functions. No fs, no sockets, no timers.

**Files:**
- Create: `src/shared/agent-status.ts`
- Test: `tests/shared/agent-status.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type RawStatus = 'none' | 'working' | 'permission' | 'done' | 'failed'`
  - `interface AgentReport { status: RawStatus; at: number }`
  - `type DotState = 'working' | 'permission' | 'failed' | 'done'`
  - `mapHookEvent(event: string): RawStatus | null`
  - `deriveDot(report: AgentReport | undefined, seenAt: number | undefined): DotState | null`

- [ ] **Step 1: Write the failing tests**

Create `tests/shared/agent-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapHookEvent, deriveDot } from '../../src/shared/agent-status'

describe('mapHookEvent', () => {
  it('maps a submitted prompt to working', () => {
    expect(mapHookEvent('UserPromptSubmit')).toBe('working')
  })

  it('keeps a long multi-tool turn working', () => {
    expect(mapHookEvent('PostToolUse')).toBe('working')
  })

  it('treats a failed tool call as still working, since the turn continues', () => {
    expect(mapHookEvent('PostToolUseFailure')).toBe('working')
  })

  it('maps a permission prompt to permission', () => {
    expect(mapHookEvent('PermissionRequest')).toBe('permission')
  })

  it('maps a finished turn to done', () => {
    expect(mapHookEvent('Stop')).toBe('done')
  })

  it('maps an API-error turn end to failed', () => {
    expect(mapHookEvent('StopFailure')).toBe('failed')
  })

  it('maps session end to none', () => {
    expect(mapHookEvent('SessionEnd')).toBe('none')
  })

  it('ignores SessionStart, which fires while the agent is still idle', () => {
    expect(mapHookEvent('SessionStart')).toBeNull()
  })

  it('ignores unknown events rather than guessing', () => {
    expect(mapHookEvent('PreCompact')).toBeNull()
    expect(mapHookEvent('')).toBeNull()
    expect(mapHookEvent('Stop ; rm -rf /')).toBeNull()
  })
})

describe('deriveDot', () => {
  it('shows nothing when there is no report', () => {
    expect(deriveDot(undefined, undefined)).toBeNull()
  })

  it('shows nothing for none', () => {
    expect(deriveDot({ status: 'none', at: 100 }, undefined)).toBeNull()
  })

  it('shows working', () => {
    expect(deriveDot({ status: 'working', at: 100 }, undefined)).toBe('working')
  })

  it('shows permission', () => {
    expect(deriveDot({ status: 'permission', at: 100 }, undefined)).toBe('permission')
  })

  it('shows failed', () => {
    expect(deriveDot({ status: 'failed', at: 100 }, undefined)).toBe('failed')
  })

  it('shows done when the turn finished and the tab was never visited', () => {
    expect(deriveDot({ status: 'done', at: 100 }, undefined)).toBe('done')
  })

  it('shows done when the turn finished after the last visit', () => {
    expect(deriveDot({ status: 'done', at: 200 }, 100)).toBe('done')
  })

  it('clears done once the tab has been visited since it finished', () => {
    expect(deriveDot({ status: 'done', at: 100 }, 200)).toBeNull()
  })

  it('clears done when visit and finish collide, preferring the quieter result', () => {
    expect(deriveDot({ status: 'done', at: 100 }, 100)).toBeNull()
  })

  it('does not seen-gate permission: visiting does not answer the prompt', () => {
    expect(deriveDot({ status: 'permission', at: 100 }, 999)).toBe('permission')
  })

  it('does not seen-gate failed: visiting does not fix the error', () => {
    expect(deriveDot({ status: 'failed', at: 100 }, 999)).toBe('failed')
  })

  it('does not seen-gate working', () => {
    expect(deriveDot({ status: 'working', at: 100 }, 999)).toBe('working')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/shared/agent-status.test.ts`
Expected: FAIL — cannot resolve `../../src/shared/agent-status`.

- [ ] **Step 3: Write the implementation**

Create `src/shared/agent-status.ts`:

```ts
// The agent status model. Pure: shared verbatim by the daemon (which maps
// incoming hook events) and the renderer (which decides what to draw).

export type RawStatus = 'none' | 'working' | 'permission' | 'done' | 'failed'

export interface AgentReport {
  status: RawStatus
  at: number
}

export type DotState = 'working' | 'permission' | 'failed' | 'done'

// Claude Code hook event names -> our status. Events absent from this table are
// ignored rather than guessed at. SessionStart is deliberately absent: it fires
// when the agent boots and is still idle awaiting input, which is not a working
// state and gives the user nothing to act on.
const EVENTS: Record<string, RawStatus> = {
  UserPromptSubmit: 'working',
  // A turn can run many tools; each one re-asserts working so a long turn
  // never decays to done.
  PostToolUse: 'working',
  // A failed tool call does not end the turn — the agent is still going.
  PostToolUseFailure: 'working',
  PermissionRequest: 'permission',
  Stop: 'done',
  StopFailure: 'failed',
  SessionEnd: 'none'
}

export function mapHookEvent(event: string): RawStatus | null {
  return EVENTS[event] ?? null
}

/**
 * Decides what dot to draw, or null for none.
 *
 * `done` is seen-gated: a turn that finished before the user last visited that
 * worktree is old news and draws nothing, which is what makes any visible dot
 * mean "unhandled". `permission` and `failed` are live states — visiting the
 * tab neither answers a permission prompt nor fixes an error — so they are not
 * gated and persist until the agent itself moves on.
 */
export function deriveDot(report: AgentReport | undefined, seenAt: number | undefined): DotState | null {
  if (!report) return null
  switch (report.status) {
    case 'working': return 'working'
    case 'permission': return 'permission'
    case 'failed': return 'failed'
    case 'done': return report.at > (seenAt ?? 0) ? 'done' : null
    case 'none': return null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/shared/agent-status.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/shared/agent-status.ts tests/shared/agent-status.test.ts
git commit -m "Add agent status model: hook event mapping and dot derivation"
```

---

### Task 2: `ps` process inspection (pure)

The backstop's logic. Pure functions over strings — no PTYs, no shelling out.

**Files:**
- Create: `src/main/pty-daemon/agentProcess.ts`
- Test: `tests/pty-daemon/agentProcess.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ProcEntry { pid: number; ppid: number; comm: string }`
  - `parseProcessTable(psOutput: string): ProcEntry[]`
  - `isAgentComm(comm: string): boolean`
  - `hasAgentDescendant(entries: ProcEntry[], rootPid: number): boolean`
  - `readProcessTable(): Promise<string>`

**Background — real `ps -axo pid,ppid,comm` output, captured on this machine:**

```
  PID  PPID COMM
15820 11275 claude
54405 54052 /Users/connerkennedy/.local/bin/claude
22867 22772 claude bg-pty-host
77291     1 /Users/connerkennedy/.local/share/claude/versions/2.1.201
```

Three traps, all covered below:
- `comm` can contain **spaces** — never split the whole line on whitespace.
- `comm` can be an **absolute path** — basename it.
- Version-numbered `comm` values are Claude's own daemon infrastructure with `ppid 1`; they must NOT match. A shell-launched `claude` is a true descendant of its PTY shell (verified: `claude` 15820 → `-zsh` 11275), so the walk finds the real one.

- [ ] **Step 1: Write the failing tests**

Create `tests/pty-daemon/agentProcess.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseProcessTable, isAgentComm, hasAgentDescendant
} from '../../src/main/pty-daemon/agentProcess'

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
    expect(parseProcessTable(PS_SAMPLE).find(e => e.pid === 15820))
      .toEqual({ pid: 15820, ppid: 11275, comm: 'claude' })
  })

  it('keeps a comm containing spaces intact', () => {
    expect(parseProcessTable(PS_SAMPLE).find(e => e.pid === 22867)!.comm).toBe('claude bg-pty-host')
  })

  it('keeps an absolute-path comm intact', () => {
    expect(parseProcessTable(PS_SAMPLE).find(e => e.pid === 54405)!.comm)
      .toBe('/Users/connerkennedy/.local/bin/claude')
  })

  it('ignores blank lines', () => {
    expect(parseProcessTable('  PID  PPID COMM\n\n15820 11275 claude\n')).toHaveLength(1)
  })

  it('returns nothing for empty input', () => {
    expect(parseProcessTable('')).toEqual([])
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

  it('does not match a command that merely contains claude', () => {
    expect(isAgentComm('claudette')).toBe(false)
    expect(isAgentComm('/usr/bin/notclaude')).toBe(false)
  })
})

describe('hasAgentDescendant', () => {
  const tree = [
    { pid: 1, ppid: 0, comm: '/sbin/launchd' },
    { pid: 100, ppid: 1, comm: '/bin/zsh' },
    { pid: 200, ppid: 100, comm: 'claude' },
    { pid: 300, ppid: 1, comm: '/bin/zsh' },
    { pid: 400, ppid: 300, comm: 'vim' }
  ]

  it('finds a direct claude child', () => {
    expect(hasAgentDescendant(tree, 100)).toBe(true)
  })

  it('finds a claude nested under an intermediate process', () => {
    expect(hasAgentDescendant([
      { pid: 100, ppid: 1, comm: '/bin/zsh' },
      { pid: 150, ppid: 100, comm: 'npm' },
      { pid: 200, ppid: 150, comm: 'claude' }
    ], 100)).toBe(true)
  })

  it('does not see claude in a sibling subtree', () => {
    expect(hasAgentDescendant(tree, 300)).toBe(false)
  })

  it('returns false for an unknown pid', () => {
    expect(hasAgentDescendant(tree, 999)).toBe(false)
  })

  it('ignores the daemon subtree reparented to launchd', () => {
    expect(hasAgentDescendant([
      { pid: 100, ppid: 1, comm: '/bin/zsh' },
      { pid: 900, ppid: 1, comm: 'claude bg-pty-host' }
    ], 100)).toBe(false)
  })

  it('terminates on a cyclic parent chain', () => {
    expect(hasAgentDescendant([
      { pid: 10, ppid: 11, comm: 'a' },
      { pid: 11, ppid: 10, comm: 'b' }
    ], 10)).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pty-daemon/agentProcess.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/main/pty-daemon/agentProcess.ts`:

```ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/agentProcess.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/agentProcess.ts tests/pty-daemon/agentProcess.test.ts
git commit -m "Add claude process detection for the agent status backstop"
```

---

### Task 3: settings.json merge (pure)

> **CORRECTION (shipped in commit 3380d13):** the code and two tests below
> described cross-path "stale install cleanup", identifying our entries by a
> substring/loose match. That was found unsafe on the user's global config (it
> could delete a user's own hook whose path contains `notify-hook.sh`) and was
> traced to a contradiction in this task's own text. Per human decision, the
> shipped implementation identifies our entries **by exact `command ===
> scriptPath` only** and does **not** do cross-path cleanup. The
> "drops our entry from a stale install path" test was removed and the
> empty-husk test rewritten to reinstall at the same path. Treat the exact-path
> behavior as the requirement; the code block below is retained for history.

This edits the user's **global** Claude config. Getting it wrong damages something we do not own, so the merge is a pure function tested hard before it is ever wired to a real file.

**Files:**
- Create: `src/main/agent-hooks/merge.ts`
- Test: `tests/main/agent-hooks-merge.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `HOOK_EVENTS: readonly string[]`
  - `mergeHooks(existing: unknown, scriptPath: string): Record<string, unknown>`

Hook config shape, per https://code.claude.com/docs/en/hooks.md:

```json
{
  "hooks": {
    "Stop": [ { "hooks": [ { "type": "command", "command": "/path/notify-hook.sh" } ] } ],
    "PostToolUse": [ { "matcher": "*", "hooks": [ { "type": "command", "command": "/path/notify-hook.sh" } ] } ]
  }
}
```

Tool-scoped events (`PostToolUse`, `PostToolUseFailure`, `PermissionRequest`) take `matcher: "*"`; the rest omit `matcher`.

- [ ] **Step 1: Write the failing tests**

Create `tests/main/agent-hooks-merge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mergeHooks, HOOK_EVENTS } from '../../src/main/agent-hooks/merge'

const SCRIPT = '/cfg/notify-hook.sh'
const OTHER = '/somewhere/user-own-hook.sh'

const entryFor = (settings: any, event: string) =>
  (settings.hooks?.[event] ?? []).flatMap((m: any) => m.hooks ?? [])

describe('mergeHooks', () => {
  it('registers every event we rely on', () => {
    const out = mergeHooks({}, SCRIPT)
    for (const event of HOOK_EVENTS) {
      expect(entryFor(out, event).map((h: any) => h.command)).toContain(SCRIPT)
    }
  })

  it('does not register SessionStart, which fires while the agent is idle', () => {
    expect(HOOK_EVENTS).not.toContain('SessionStart')
    expect(mergeHooks({}, SCRIPT).hooks).not.toHaveProperty('SessionStart')
  })

  it('uses a wildcard matcher for tool-scoped events only', () => {
    const out: any = mergeHooks({}, SCRIPT)
    expect(out.hooks.PostToolUse[0].matcher).toBe('*')
    expect(out.hooks.PermissionRequest[0].matcher).toBe('*')
    expect(out.hooks.Stop[0]).not.toHaveProperty('matcher')
  })

  it('builds command entries of type command', () => {
    const out: any = mergeHooks({}, SCRIPT)
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: SCRIPT })
  })

  it('preserves unrelated top-level settings', () => {
    const out: any = mergeHooks({ model: 'opus', permissions: { allow: ['Bash'] } }, SCRIPT)
    expect(out.model).toBe('opus')
    expect(out.permissions).toEqual({ allow: ['Bash'] })
  })

  it("preserves the user's own hooks on an event we also use", () => {
    const out: any = mergeHooks({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER }] }] }
    }, SCRIPT)
    const commands = entryFor(out, 'Stop').map((h: any) => h.command)
    expect(commands).toContain(OTHER)
    expect(commands).toContain(SCRIPT)
  })

  it('preserves the user hooks on events we never touch', () => {
    const out: any = mergeHooks({
      hooks: { PreCompact: [{ hooks: [{ type: 'command', command: OTHER }] }] }
    }, SCRIPT)
    expect(entryFor(out, 'PreCompact').map((h: any) => h.command)).toEqual([OTHER])
  })

  it('is idempotent: installing twice does not duplicate our entry', () => {
    const once: any = mergeHooks({}, SCRIPT)
    const twice: any = mergeHooks(once, SCRIPT)
    expect(entryFor(twice, 'Stop').filter((h: any) => h.command === SCRIPT)).toHaveLength(1)
    expect(twice).toEqual(once)
  })

  it('drops our entry from a stale install path', () => {
    const stale: any = mergeHooks({}, '/old/path/notify-hook.sh')
    const out: any = mergeHooks(stale, SCRIPT)
    const commands = entryFor(out, 'Stop').map((h: any) => h.command)
    expect(commands).toEqual([SCRIPT])
  })

  it('removes an event key entirely when we were its only hook', () => {
    const stale: any = mergeHooks({}, '/old/path/notify-hook.sh')
    // Pretend a stale event we no longer register still holds only our entry.
    stale.hooks.PreCompact = [{ hooks: [{ type: 'command', command: '/old/path/notify-hook.sh' }] }]
    const out: any = mergeHooks(stale, SCRIPT)
    expect(out.hooks).not.toHaveProperty('PreCompact')
  })

  it('tolerates a null or non-object input', () => {
    expect(() => mergeHooks(null, SCRIPT)).not.toThrow()
    expect(() => mergeHooks('garbage', SCRIPT)).not.toThrow()
    expect(entryFor(mergeHooks(null, SCRIPT), 'Stop').map((h: any) => h.command)).toContain(SCRIPT)
  })

  it('tolerates a malformed hooks section without throwing', () => {
    expect(() => mergeHooks({ hooks: 'nonsense' }, SCRIPT)).not.toThrow()
    expect(() => mergeHooks({ hooks: { Stop: 'nonsense' } }, SCRIPT)).not.toThrow()
    expect(() => mergeHooks({ hooks: { Stop: [{ hooks: 'nope' }] } }, SCRIPT)).not.toThrow()
  })

  it('does not mutate its input', () => {
    const input = { hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER }] }] } }
    const snapshot = JSON.parse(JSON.stringify(input))
    mergeHooks(input, SCRIPT)
    expect(input).toEqual(snapshot)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main/agent-hooks-merge.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/main/agent-hooks/merge.ts`:

```ts
// Merges our notify-hook into a Claude Code settings object.
//
// This touches the user's GLOBAL config, so the contract is strict: preserve
// everything we did not put there, identify our own entries solely by script
// path, and never throw on malformed input. Pure — the caller owns all fs.

// Events we register. Order mirrors a turn's lifecycle. SessionStart is
// deliberately absent: it fires when the agent boots and is still idle awaiting
// input, so registering it would light up rows with nothing to act on.
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SessionEnd'
] as const

// Tool-scoped events take a matcher; the rest have nothing to match on.
const NEEDS_MATCHER = new Set<string>(['PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/** Strips every command entry pointing at `scriptPath`, dropping husks left behind. */
function withoutOurs(matchers: unknown, scriptPath: string): unknown[] {
  if (!Array.isArray(matchers)) return []
  const kept: unknown[] = []
  for (const matcher of matchers) {
    if (!isObject(matcher)) { kept.push(matcher); continue }
    if (!Array.isArray(matcher.hooks)) { kept.push(matcher); continue }
    const hooks = matcher.hooks.filter(h => !(isObject(h) && h.command === scriptPath))
    // A matcher whose only hook was ours is now empty — drop it rather than
    // leave an empty shell in the user's config.
    if (hooks.length > 0) kept.push({ ...matcher, hooks })
  }
  return kept
}

export function mergeHooks(existing: unknown, scriptPath: string): Record<string, unknown> {
  const settings: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  const existingHooks = isObject(settings.hooks) ? settings.hooks : {}

  const hooks: Record<string, unknown> = {}

  // Carry every event forward minus our entries. This both preserves the user's
  // hooks and cleans up our own stale installs from a previous script path.
  for (const [event, matchers] of Object.entries(existingHooks)) {
    const kept = withoutOurs(matchers, scriptPath)
    if (kept.length > 0) hooks[event] = kept
  }

  for (const event of HOOK_EVENTS) {
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command: scriptPath }] }
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*'
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), entry]
  }

  settings.hooks = hooks
  return settings
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/agent-hooks-merge.test.ts`
Expected: PASS, all tests green.

Note: the "idempotent" test asserts deep equality between one and two installs. If it fails on key ordering, the bug is real — `withoutOurs` must be dropping our entry before it is re-added, so the rebuilt object matches.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-hooks/merge.ts tests/main/agent-hooks-merge.test.ts
git commit -m "Add idempotent merge of notify-hook into claude settings"
```

---

### Task 4: Install the hook script and settings

Wires Task 3's merge to real files, and writes the bash script.

**Files:**
- Create: `src/main/agent-hooks/install.ts`
- Test: `tests/main/agent-hooks-install.test.ts`

**Interfaces:**
- Consumes: `mergeHooks` (Task 3), `configDir` from `../config`.
- Produces:
  - `hookScriptPath(): string` — `<configDir>/notify-hook.sh`
  - `hookSocketPath(): string` — `<configDir>/agent-hook.sock`
  - `claudeSettingsPath(): string` — `$WTM_CLAUDE_SETTINGS` or `~/.claude/settings.json`
  - `installAgentHooks(): void`

`claudeSettingsPath` honours a `WTM_CLAUDE_SETTINGS` env override **so tests never touch the developer's real `~/.claude/settings.json`**. This mirrors the existing `WTM_CONFIG_DIR` override in `src/main/config.ts:5`.

- [ ] **Step 1: Write the failing tests**

Create `tests/main/agent-hooks-install.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
let settings: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-hooks-'))
  settings = join(dir, 'settings.json')
  process.env.WTM_CONFIG_DIR = dir
  process.env.WTM_CLAUDE_SETTINGS = settings
})

describe('installAgentHooks', () => {
  it('writes an executable hook script', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    expect(existsSync(hookScriptPath())).toBe(true)
    // owner-executable bit
    expect(statSync(hookScriptPath()).mode & 0o100).toBeTruthy()
  })

  it('creates settings.json when none exists', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const out = JSON.parse(readFileSync(settings, 'utf8'))
    expect(out.hooks.Stop[0].hooks[0].command).toBe(hookScriptPath())
  })

  it("preserves the user's existing settings", async () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }))
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    expect(JSON.parse(readFileSync(settings, 'utf8')).model).toBe('opus')
  })

  it('backs up the original once', async () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }))
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const backup = `${settings}.wtm-backup`
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({ model: 'opus' })

    // A second install must not overwrite the pristine backup with our own output.
    installAgentHooks()
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('refuses to touch a settings file it cannot parse', async () => {
    writeFileSync(settings, '{ this is not json')
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    expect(() => installAgentHooks()).not.toThrow()
    expect(readFileSync(settings, 'utf8')).toBe('{ this is not json')
  })

  it('is idempotent across repeated installs', async () => {
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const first = readFileSync(settings, 'utf8')
    installAgentHooks()
    expect(readFileSync(settings, 'utf8')).toBe(first)
  })
})

describe('the hook script', () => {
  it('exits silently when not launched from one of our terminals', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const { execFileSync } = await import('child_process')
    // No WTM_TERMINAL_ID: must exit 0 and emit nothing.
    const out = execFileSync('bash', [hookScriptPath()], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
      env: { PATH: process.env.PATH ?? '' }
    })
    expect(out.toString()).toBe('')
  })

  it('exits silently when the socket does not exist', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const { execFileSync } = await import('child_process')
    const out = execFileSync('bash', [hookScriptPath()], {
      input: JSON.stringify({ hook_event_name: 'Stop' }),
      env: {
        PATH: process.env.PATH ?? '',
        WTM_TERMINAL_ID: 'abc',
        WTM_HOOK_SOCKET: join(dir, 'does-not-exist.sock')
      }
    })
    expect(out.toString()).toBe('')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/main/agent-hooks-install.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/main/agent-hooks/install.ts`:

```ts
// Installs the Claude Code notify-hook: writes the script and registers it in
// the user's global ~/.claude/settings.json.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { configDir } from '../config'
import { mergeHooks } from './merge'

export function hookScriptPath(): string { return join(configDir(), 'notify-hook.sh') }
export function hookSocketPath(): string { return join(configDir(), 'agent-hook.sock') }

// The env override keeps tests off the developer's real Claude config, mirroring
// WTM_CONFIG_DIR in ../config.
export function claudeSettingsPath(): string {
  return process.env.WTM_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json')
}

// Installed in the user's GLOBAL settings, so this runs for every `claude` on the
// machine, not just ours. The env guard must therefore be the very first thing it
// does, and every path must exit 0 — a broken hook must never disturb a session.
const SCRIPT = `#!/bin/bash
# Worktree Manager agent hook. Generated — edits will be overwritten.
[ -z "$WTM_TERMINAL_ID" ] && exit 0
[ -S "$WTM_HOOK_SOCKET" ] || exit 0

EVENT=$(cat | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
# Never guess an event on a parse failure: a wrong "Stop" would falsely clear a
# working indicator. Dropping the event is always safer.
[ -z "$EVENT" ] && exit 0

curl -sS --unix-socket "$WTM_HOOK_SOCKET" \\
  -X POST -H 'Content-Type: application/json' \\
  -d "{\\"id\\":\\"$WTM_TERMINAL_ID\\",\\"event\\":\\"$EVENT\\"}" \\
  --connect-timeout 1 --max-time 2 \\
  http://localhost/hook >/dev/null 2>&1
exit 0
`

/**
 * Idempotent. Safe to call on every app start.
 *
 * Deliberately never throws: failing to install hooks costs the status
 * indicator, which must not be allowed to take the app down with it.
 */
export function installAgentHooks(): void {
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(hookScriptPath(), SCRIPT, { mode: 0o755 })

    const settingsFile = claudeSettingsPath()
    mkdirSync(dirname(settingsFile), { recursive: true })

    let existing: unknown = {}
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, 'utf8')
      try {
        existing = JSON.parse(raw)
      } catch {
        // Someone else's malformed config. Rewriting it would destroy data we
        // cannot read, so leave it alone and go without the indicator.
        console.error('[wtm] ~/.claude/settings.json is not valid JSON; skipping hook install')
        return
      }
      const backup = `${settingsFile}.wtm-backup`
      if (!existsSync(backup)) copyFileSync(settingsFile, backup)
    }

    const merged = mergeHooks(existing, hookScriptPath())

    // Temp-and-rename: a crash mid-write must not leave the user with a
    // truncated Claude config.
    const tmp = `${settingsFile}.wtm-tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
    renameSync(tmp, settingsFile)
  } catch (e) {
    console.error('[wtm] failed to install agent hooks:', e)
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/agent-hooks-install.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/agent-hooks/install.ts tests/main/agent-hooks-install.test.ts
git commit -m "Install claude notify-hook script and settings entries"
```

---

### Task 5: Terminal ids and env injection

**Files:**
- Modify: `src/main/pty-daemon/sessionStore.ts:4` (Session type), `:11-27` (start)
- Test: `tests/pty-daemon/sessionStore.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `PtyManager.start(worktreePath, onData, env?: Record<string, string>)` — optional extra env
  - `PtyManager.id(worktreePath: string): string | undefined`
  - `PtyManager.pathForId(id: string): string | undefined`
  - `PtyManager.pid(worktreePath: string): number | undefined`

The id is opaque rather than the worktree path because the hook script is bash assembling JSON by hand; a path would need quote/backslash escaping, a uuid never does.

- [ ] **Step 1: Write the failing test**

Append inside the existing `describe('PtyManager', ...)` in `tests/pty-daemon/sessionStore.test.ts`:

```ts
  it('assigns an opaque id per session and maps it back to the worktree', async () => {
    mgr = new PtyManager()
    const p = homedir()
    mgr.start(p, () => {})

    const id = mgr.id(p)!
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(mgr.pathForId(id)).toBe(p)
    expect(mgr.pathForId('not-a-real-id')).toBeUndefined()
    expect(mgr.id('/no/such/worktree')).toBeUndefined()
    expect(mgr.pid(p)).toBeGreaterThan(0)
  })

  it('injects extra env into the pty', async () => {
    mgr = new PtyManager()
    const p = homedir()
    let got = ''
    mgr.start(p, d => { got += d }, { WTM_TEST_MARKER: 'wtm_env_ok' })

    mgr.write(p, 'echo "[$WTM_TEST_MARKER]"\n')
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (got.includes('[wtm_env_ok]')) { clearInterval(iv); resolve() }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); reject(new Error('timeout')) }
      }, 50)
    })
    expect(got).toContain('[wtm_env_ok]')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pty-daemon/sessionStore.test.ts`
Expected: FAIL — `mgr.id is not a function`.

- [ ] **Step 3: Write the implementation**

In `src/main/pty-daemon/sessionStore.ts`, add the import:

```ts
import { randomUUID } from 'crypto'
```

Change the `Session` type (line 4):

```ts
type Session = { proc: pty.IPty; buffer: string; id: string }
```

Change `start` to take extra env and assign an id:

```ts
  start(worktreePath: string, onData: (data: string) => void, extraEnv: Record<string, string> = {}) {
    if (this.sessions.has(worktreePath)) return
    const shell = process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : 'bash')
    const args = platform() === 'win32' ? [] : ['-l']
    const id = randomUUID()
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color', cols: 100, rows: 30, cwd: worktreePath,
      env: { ...process.env, ...extraEnv } as any
    })
    const session: Session = { proc, buffer: '', id }
    proc.onData(d => {
      session.buffer += d
      if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER)
      onData(d)
    })
    proc.onExit(() => this.sessions.delete(worktreePath))
    this.sessions.set(worktreePath, session)
  }
```

Add accessors beside `list()`:

```ts
  id(worktreePath: string) { return this.sessions.get(worktreePath)?.id }
  pid(worktreePath: string) { return this.sessions.get(worktreePath)?.proc.pid }
  pathForId(id: string) {
    for (const [path, s] of this.sessions) if (s.id === id) return path
    return undefined
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/sessionStore.test.ts`
Expected: PASS, all tests green including the pre-existing buffer test.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/sessionStore.ts tests/pty-daemon/sessionStore.test.ts
git commit -m "Give pty sessions an opaque id and injectable env"
```

---

### Task 6: Agent tracker — hook server, status store, backstop

**Files:**
- Create: `src/main/pty-daemon/agentTracker.ts`
- Test: `tests/pty-daemon/agentTracker.test.ts`

**Interfaces:**
- Consumes: `mapHookEvent`, `RawStatus`, `AgentReport` (Task 1); `parseProcessTable`, `hasAgentDescendant` (Task 2); `PtyManager.pathForId`, `.pid`, `.list` (Task 5).
- Produces:
  - `interface TrackerSessions { list(): string[]; pid(p: string): number | undefined; pathForId(id: string): string | undefined }`
  - `class AgentTracker` with `constructor(sessions: TrackerSessions, emit: (path: string, report: AgentReport) => void, readTable?: () => Promise<string>, now?: () => number)`
  - `AgentTracker.handleHook(id: string, event: string): void`
  - `AgentTracker.sweep(): Promise<void>`
  - `AgentTracker.snapshot(): Record<string, AgentReport>`
  - `AgentTracker.start(): void` / `.stop(): void`

`readTable` and `now` are injected so tests never shell out or race a clock.

- [ ] **Step 1: Write the failing tests**

Create `tests/pty-daemon/agentTracker.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AgentTracker } from '../../src/main/pty-daemon/agentTracker'
import type { AgentReport } from '../../src/shared/agent-status'

const WITH_AGENT = ['  PID  PPID COMM', '100 1 /bin/zsh', '200 100 claude'].join('\n')
const NO_AGENT = ['  PID  PPID COMM', '100 1 /bin/zsh'].join('\n')

const sessions = (paths = ['/wt/a']) => ({
  list: () => paths,
  pid: (p: string) => (paths.includes(p) ? 100 : undefined),
  pathForId: (id: string) => (id === 'id-a' ? '/wt/a' : undefined)
})

function make(table = WITH_AGENT, paths = ['/wt/a']) {
  const seen: [string, AgentReport][] = []
  let clock = 1000
  const tracker = new AgentTracker(
    sessions(paths),
    (p, r) => seen.push([p, r]),
    async () => table,
    () => clock
  )
  return { tracker, seen, tick: (ms: number) => { clock += ms } }
}

describe('handleHook', () => {
  it('maps an event onto the right worktree and emits', () => {
    const { tracker, seen } = make()
    tracker.handleHook('id-a', 'UserPromptSubmit')
    expect(seen).toEqual([['/wt/a', { status: 'working', at: 1000 }]])
  })

  it('ignores an unknown terminal id', () => {
    const { tracker, seen } = make()
    tracker.handleHook('bogus-id', 'Stop')
    expect(seen).toEqual([])
  })

  it('ignores an event that carries no status', () => {
    const { tracker, seen } = make()
    tracker.handleHook('id-a', 'SessionStart')
    expect(seen).toEqual([])
    expect(tracker.snapshot()).toEqual({})
  })

  it('re-emits Stop even though the status is unchanged, because `at` moved', () => {
    const { tracker, seen, tick } = make()
    tracker.handleHook('id-a', 'Stop')
    tick(50)
    tracker.handleHook('id-a', 'Stop')
    expect(seen).toHaveLength(2)
    expect(seen[1][1].at).toBe(1050)
  })

  it('walks a full turn: prompt -> tool -> permission -> stop', () => {
    const { tracker, seen } = make()
    tracker.handleHook('id-a', 'UserPromptSubmit')
    tracker.handleHook('id-a', 'PostToolUse')
    tracker.handleHook('id-a', 'PermissionRequest')
    tracker.handleHook('id-a', 'Stop')
    expect(seen.map(([, r]) => r.status)).toEqual(['working', 'working', 'permission', 'done'])
  })

  it('records StopFailure as failed', () => {
    const { tracker } = make()
    tracker.handleHook('id-a', 'StopFailure')
    expect(tracker.snapshot()['/wt/a'].status).toBe('failed')
  })
})

describe('sweep', () => {
  it('does not run ps when nothing is active', async () => {
    let calls = 0
    const tracker = new AgentTracker(
      sessions(), () => {}, async () => { calls++; return WITH_AGENT }, () => 1000
    )
    await tracker.sweep()
    expect(calls).toBe(0)
  })

  it('leaves a working status alone while claude is alive', async () => {
    const { tracker, seen } = make(WITH_AGENT)
    tracker.handleHook('id-a', 'UserPromptSubmit')
    await tracker.sweep()
    expect(seen).toHaveLength(1)
    expect(tracker.snapshot()['/wt/a'].status).toBe('working')
  })

  it('clears a stale working status when claude is gone', async () => {
    const { tracker, seen } = make(NO_AGENT)
    tracker.handleHook('id-a', 'UserPromptSubmit')
    await tracker.sweep()
    expect(seen[1]).toEqual(['/wt/a', { status: 'none', at: 1000 }])
    expect(tracker.snapshot()['/wt/a']).toBeUndefined()
  })

  it('never sets a positive status: a dead-to-alive flip does not emit', async () => {
    const { tracker, seen } = make(WITH_AGENT)
    await tracker.sweep()
    expect(seen).toEqual([])
  })

  it('survives a failing ps without throwing or losing state', async () => {
    const seen: [string, AgentReport][] = []
    const tracker = new AgentTracker(
      sessions(), (p, r) => seen.push([p, r]), async () => { throw new Error('ps exploded') }, () => 1000
    )
    tracker.handleHook('id-a', 'UserPromptSubmit')
    await expect(tracker.sweep()).resolves.toBeUndefined()
    expect(tracker.snapshot()['/wt/a'].status).toBe('working')
  })

  it('drops a status whose pty has exited', async () => {
    const seen: [string, AgentReport][] = []
    let paths = ['/wt/a']
    const tracker = new AgentTracker(
      { list: () => paths, pid: () => 100, pathForId: () => '/wt/a' },
      (p, r) => seen.push([p, r]),
      async () => WITH_AGENT,
      () => 1000
    )
    tracker.handleHook('id-a', 'UserPromptSubmit')
    paths = []
    await tracker.sweep()
    expect(tracker.snapshot()).toEqual({})
    expect(seen[1][1].status).toBe('none')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/pty-daemon/agentTracker.test.ts`
Expected: FAIL — `AgentTracker is not a constructor`.

- [ ] **Step 3: Write the implementation**

Create `src/main/pty-daemon/agentTracker.ts`:

```ts
// Owns per-worktree agent status inside the daemon.
//
// Hooks are the source of truth: Claude tells us what it is doing. The sweep is
// only a backstop for the one thing hooks cannot report — an agent killed
// without firing SessionEnd, which would otherwise leave a row stuck forever.
// It may only clear a status, never set one.

import { mapHookEvent, type AgentReport } from '@shared/agent-status'
import { hasAgentDescendant, parseProcessTable, readProcessTable } from './agentProcess'

const SWEEP_MS = 2000

export interface TrackerSessions {
  list(): string[]
  pid(worktreePath: string): number | undefined
  pathForId(id: string): string | undefined
}

export class AgentTracker {
  private reports = new Map<string, AgentReport>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private sessions: TrackerSessions,
    private emit: (path: string, report: AgentReport) => void,
    private readTable: () => Promise<string> = readProcessTable,
    private now: () => number = Date.now
  ) {}

  /** Called for each hook POST. `id` is the pty's opaque WTM_TERMINAL_ID. */
  handleHook(id: string, event: string): void {
    const path = this.sessions.pathForId(id)
    if (!path) return // a stale id from a pty that has since exited
    const status = mapHookEvent(event)
    if (!status) return // an event we do not model; never guess

    const at = this.now()
    if (status === 'none') {
      this.reports.delete(path)
    } else {
      this.reports.set(path, { status, at })
    }
    // Always emit, even when the status is unchanged: `at` advancing is itself
    // meaningful, since the renderer gates `done` against when the user last
    // looked at that worktree. One timestamp, shared by the stored and emitted
    // report so snapshot() and the push never disagree.
    this.emit(path, { status, at })
  }

  /**
   * Clears statuses whose agent is gone. Skips the `ps` entirely when nothing is
   * active, so an idle machine does no work.
   */
  async sweep(): Promise<void> {
    if (this.reports.size === 0) return

    let entries
    try {
      entries = parseProcessTable(await this.readTable())
    } catch {
      return // a failed ps is transient; keep what we have
    }

    const live = new Set(this.sessions.list())
    for (const path of [...this.reports.keys()]) {
      const pid = this.sessions.pid(path)
      const gone = !live.has(path) || pid === undefined || !hasAgentDescendant(entries, pid)
      if (!gone) continue
      this.reports.delete(path)
      this.emit(path, { status: 'none', at: this.now() })
    }
  }

  snapshot(): Record<string, AgentReport> {
    return Object.fromEntries(this.reports)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sweep() }, SWEEP_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/agentTracker.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/agentTracker.ts tests/pty-daemon/agentTracker.test.ts
git commit -m "Add agent tracker: hook events with a process-check backstop"
```

---

### Task 7: Hook HTTP server on a unix socket

**Files:**
- Create: `src/main/pty-daemon/hookServer.ts`
- Test: `tests/pty-daemon/hookServer.test.ts`

**Interfaces:**
- Consumes: nothing (takes a callback).
- Produces: `startHookServer(socketPath: string, onHook: (id: string, event: string) => void): http.Server`

The existing daemon socket speaks length-prefixed JSON frames, not HTTP, so this is a **second, separate** socket. Verified: macOS ships curl 8.7.1 with `--unix-socket`, and a Node HTTP server bound to a socket path receives the POST.

- [ ] **Step 1: Write the failing test**

Create `tests/pty-daemon/hookServer.test.ts`:

```ts
import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Server } from 'http'
import { startHookServer } from '../../src/main/pty-daemon/hookServer'

let server: Server | undefined
afterEach(() => { server?.close(); server = undefined })

function serve(onHook: (id: string, event: string) => void) {
  const sock = join(mkdtempSync(join(tmpdir(), 'wtm-hook-')), 'agent-hook.sock')
  return new Promise<string>(resolve => {
    server = startHookServer(sock, onHook)
    server.on('listening', () => resolve(sock))
  })
}

const post = (sock: string, body: string) =>
  execFileSync('curl', [
    '-sS', '--unix-socket', sock, '-X', 'POST',
    '-H', 'Content-Type: application/json', '-d', body,
    '--max-time', '2', 'http://localhost/hook'
  ]).toString()

describe('startHookServer', () => {
  it('receives a hook posted over the unix socket', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    post(sock, JSON.stringify({ id: 'id-a', event: 'Stop' }))
    expect(got).toEqual([['id-a', 'Stop']])
  })

  it('ignores a malformed body without crashing', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    expect(() => post(sock, 'not json at all')).not.toThrow()
    expect(got).toEqual([])
  })

  it('ignores a body missing its fields', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    post(sock, JSON.stringify({ id: 'id-a' }))
    post(sock, JSON.stringify({ event: 'Stop' }))
    post(sock, JSON.stringify({ id: 5, event: [] }))
    expect(got).toEqual([])
  })

  it('rebinds over a stale socket file left by a crash', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    server!.close()
    // The socket file still exists on disk; a fresh bind must reclaim it.
    server = startHookServer(sock, (id, event) => got.push([id, event]))
    await new Promise(r => server!.on('listening', r))
    post(sock, JSON.stringify({ id: 'id-a', event: 'Stop' }))
    expect(got).toEqual([['id-a', 'Stop']])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/pty-daemon/hookServer.test.ts`
Expected: FAIL — cannot resolve the module.

- [ ] **Step 3: Write the implementation**

Create `src/main/pty-daemon/hookServer.ts`:

```ts
// HTTP endpoint the notify-hook script posts to.
//
// A second socket, separate from the daemon's own: that one speaks
// length-prefixed JSON frames, and curl speaks HTTP. A unix socket rather than a
// localhost port keeps this off the network entirely and needs no port
// allocation — filesystem permissions are the access control.

import * as http from 'http'
import { unlinkSync } from 'fs'

const MAX_BODY = 64 * 1024

export function startHookServer(
  socketPath: string,
  onHook: (id: string, event: string) => void
): http.Server {
  // A crashed daemon leaves the socket file behind and bind would fail with
  // EADDRINUSE, so clear it first.
  try { unlinkSync(socketPath) } catch { /* nothing to remove */ }

  const server = http.createServer((req, res) => {
    let body = ''
    let tooBig = false
    req.on('data', chunk => {
      body += chunk
      // The hook posts a few dozen bytes. Anything larger is not ours.
      if (body.length > MAX_BODY) { tooBig = true; req.destroy() }
    })
    req.on('end', () => {
      res.end('ok')
      if (tooBig) return
      try {
        const { id, event } = JSON.parse(body)
        if (typeof id === 'string' && typeof event === 'string') onHook(id, event)
      } catch {
        // Malformed input must never take the daemon down.
      }
    })
  })

  server.on('error', e => process.stderr.write(`[pty-daemon] hook server: ${e}\n`))
  server.listen(socketPath)
  return server
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/pty-daemon/hookServer.test.ts`
Expected: PASS, all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/hookServer.ts tests/pty-daemon/hookServer.test.ts
git commit -m "Add hook HTTP server on a unix socket"
```

---

### Task 8: Wire the daemon

**Files:**
- Modify: `src/main/pty-daemon/protocol.ts:7-22`
- Modify: `src/main/pty-daemon/daemon.ts`

**Interfaces:**
- Consumes: `AgentTracker` (Task 6), `startHookServer` (Task 7), `PtyManager` (Task 5).
- Produces: `ServerMessage` variant `{ type: 'agentStatus'; path: string; report: AgentReport }`; daemon broadcasts on change and snapshots on `hello`.

- [ ] **Step 1: Add the protocol variant**

In `src/main/pty-daemon/protocol.ts`, add the import at the top:

```ts
import type { AgentReport } from '@shared/agent-status'
```

Add the variant to `ServerMessage`:

```ts
  | { type: 'agentStatus'; path: string; report: AgentReport }
```

This is `import type`, erased at compile time, so `protocol.ts` keeps its no-runtime-deps property.

- [ ] **Step 2: Wire the daemon**

In `src/main/pty-daemon/daemon.ts`, add imports:

```ts
import { AgentTracker } from './agentTracker'
import { startHookServer } from './hookServer'
```

Add the hook socket path beside the existing path constants:

```ts
const hookSocketPath = path.join(configDir(), 'agent-hook.sock')
```

After `broadcast` is defined, create the tracker and hook server:

```ts
// Hooks report what the agent is doing; the tracker's sweep only clears status
// when an agent dies without firing SessionEnd.
const agents = new AgentTracker(sessions, (p, report) => broadcast({ type: 'agentStatus', path: p, report }))
agents.start()
startHookServer(hookSocketPath, (id, event) => agents.handleHook(id, event))
```

Extend the `hello` case so a newly connected client gets current state rather than waiting for the next change:

```ts
    case 'hello':
      sock.write(encodeFrame({ type: 'welcome', version: PROTOCOL_VERSION } satisfies ServerMessage))
      for (const [p, report] of Object.entries(agents.snapshot())) {
        sock.write(encodeFrame({ type: 'agentStatus', path: p, report } satisfies ServerMessage))
      }
      return
```

- [ ] **Step 3: Inject the hook env into every session**

The env must exist at `pty.spawn` time, and `PtyManager.start` is what mints the id (Task 5) — so `PtyManager` injects `WTM_TERMINAL_ID` itself, and the daemon supplies only `WTM_HOOK_SOCKET`. Splitting it this way means the id can never disagree with the one `pathForId` resolves against.

In `src/main/pty-daemon/sessionStore.ts`, fold the id into the spawn env:

```ts
    const id = randomUUID()
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color', cols: 100, rows: 30, cwd: worktreePath,
      env: { ...process.env, ...extraEnv, WTM_TERMINAL_ID: id } as any
    })
```

In `src/main/pty-daemon/daemon.ts`, add a helper above `handleMessage`. Both the `start` and `reset` cases spawn sessions, and a shared helper stops their env from drifting apart:

```ts
// The notify-hook script reads WTM_HOOK_SOCKET (here) and WTM_TERMINAL_ID (set
// by PtyManager) out of its inherited environment to report which terminal it
// belongs to.
function startSession(worktreePath: string) {
  sessions.start(worktreePath, chunk => broadcast({ type: 'data', path: worktreePath, chunk }), {
    WTM_HOOK_SOCKET: hookSocketPath
  })
}
```

Then replace the `start` case body with `if (!sessions.has(message.path)) startSession(message.path)`, and the `reset` case's `sessions.start(...)` call with `startSession(message.path)`.

- [ ] **Step 4: Verify it compiles and the suite passes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS, no type errors, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/main/pty-daemon/protocol.ts src/main/pty-daemon/daemon.ts src/main/pty-daemon/sessionStore.ts
git commit -m "Wire hook server and agent tracker into the daemon"
```

---

### Task 9: Forward status to the renderer

**Files:**
- Modify: `src/main/pty-daemon/client.ts:51-67`, `:69-93`, `:114-147`, `:162-172`
- Modify: `src/main/ipc.ts:40`, add handler
- Modify: `src/main/index.ts` (call `installAgentHooks`)
- Modify: `src/shared/ipc-types.ts` (Api + IPC map)
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: the `agentStatus` `ServerMessage` (Task 8), `installAgentHooks` (Task 4).
- Produces:
  - `PtyDaemonClient.connect(onData, onAgentStatus)`
  - `PtyDaemonClient.agentStatuses(): Record<string, AgentReport>`
  - `Api.getAgentStatuses(): Promise<Record<string, AgentReport>>`
  - `Api.onAgentStatus(cb: (worktreePath: string, report: AgentReport) => void): () => void`
  - `IPC.getAgentStatuses = 'agent:list'`, `IPC.agentStatus = 'agent:status'`

Both a push and a fetch are needed: `registerIpc` guards with `registered` (`ipc.ts:37`), so the daemon client connects only once and a renderer reload would otherwise miss the connect-time snapshot.

- [ ] **Step 1: Add the client cache and callback**

In `src/main/pty-daemon/client.ts`, import the type:

```ts
import type { AgentReport } from '@shared/agent-status'
```

Add fields beside `private buffers` (line 56):

```ts
  private agents = new Map<string, AgentReport>()
  private onAgentStatus: (path: string, report: AgentReport) => void
```

Change the constructor (lines 61-67):

```ts
  private constructor(
    socket: net.Socket,
    onData: (path: string, data: string) => void,
    onAgentStatus: (path: string, report: AgentReport) => void
  ) {
    this.socket = socket
    this.onData = onData
    this.onAgentStatus = onAgentStatus
    this.socket.on('data', chunk => {
      for (const message of this.decoder.push(chunk)) this.handleMessage(message as ServerMessage)
    })
  }
```

Add a case to `handleMessage`, after `replayResponse`:

```ts
      case 'agentStatus': {
        if (message.report.status === 'none') this.agents.delete(message.path)
        else this.agents.set(message.path, message.report)
        this.onAgentStatus(message.path, message.report)
        return
      }
```

Change `connect` (line 114) and the construction (line 137):

```ts
  static async connect(
    onData: (path: string, data: string) => void,
    onAgentStatus: (path: string, report: AgentReport) => void
  ): Promise<PtyDaemonClient> {
```

```ts
    const client = new PtyDaemonClient(socket, onData, onAgentStatus)
```

Add an accessor beside `list()`:

```ts
  agentStatuses(): Record<string, AgentReport> { return Object.fromEntries(this.agents) }
```

Add cleanup in `kill` and `killAll`, beside the existing `buffers` cleanup:

```ts
    this.agents.delete(path)
```

```ts
    this.agents.clear()
```

- [ ] **Step 2: Add the shared types**

In `src/shared/ipc-types.ts`, add the import at the top:

```ts
import type { AgentReport } from './agent-status'
```

Add to `Api` after `onStatusChanged` (line 75):

```ts
  getAgentStatuses(): Promise<Record<string, AgentReport>>
  onAgentStatus(cb: (worktreePath: string, report: AgentReport) => void): () => void
```

Add to the `IPC` map after the `termData`/`statusChanged` line (line 91):

```ts
  getAgentStatuses: 'agent:list', agentStatus: 'agent:status',
```

- [ ] **Step 3: Wire the main process**

In `src/main/ipc.ts`, change the connect call (line 40):

```ts
  ptys = await PtyDaemonClient.connect(
    (p, d) => send(IPC.termData, p, d),
    (p, r) => send(IPC.agentStatus, p, r)
  )
```

Add a handler beside `IPC.listTerminals` (line 74):

```ts
  ipcMain.handle(IPC.getAgentStatuses, () => ptys.agentStatuses())
```

In `src/main/index.ts`, call the installer during startup, before the window is created:

```ts
import { installAgentHooks } from './agent-hooks/install'
```

```ts
  // Idempotent, never throws — the app must start even if hook install fails.
  installAgentHooks()
```

- [ ] **Step 4: Expose it in the preload**

In `src/preload/index.ts`, extend the imports (line 2):

```ts
import { IPC, type Api } from '@shared/ipc-types'
import type { AgentReport } from '@shared/agent-status'
```

Add after `listTerminals` (line 20):

```ts
  getAgentStatuses: () => ipcRenderer.invoke(IPC.getAgentStatuses),
```

Add after the `onStatusChanged` block (line 34):

```ts
  onAgentStatus: (cb) => {
    const h = (_e: unknown, p: string, r: AgentReport) => cb(p, r)
    ipcRenderer.on(IPC.agentStatus, h as any)
    return () => ipcRenderer.removeListener(IPC.agentStatus, h as any)
  },
```

- [ ] **Step 5: Verify it compiles and the suite passes**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS. TypeScript flags any `Api` member left unimplemented in the preload — that is the intended check.

- [ ] **Step 6: Commit**

```bash
git add src/main/pty-daemon/client.ts src/main/ipc.ts src/main/index.ts src/shared/ipc-types.ts src/preload/index.ts
git commit -m "Forward agent status from daemon to renderer"
```

---

### Task 10: Store state and the sidebar dot

**Files:**
- Modify: `src/renderer/state/store.ts:14-32`, `:34-35`, `:39-58`, `:76`
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/components/sidebar-theme.css`
- Test: `tests/renderer/store-seen.test.ts`

**Interfaces:**
- Consumes: `deriveDot`, `AgentReport` (Task 1); `Api.getAgentStatuses`, `Api.onAgentStatus` (Task 9).
- Produces: `State.agentStatuses: Record<string, AgentReport>`, `State.seenAt: Record<string, number>`.

**No component-render test, deliberately.** `vitest.config.ts` sets `include: ['tests/**/*.test.ts']` with `environment: 'node'` and no react plugin, so a `.tsx` test would not even be collected. The repo's convention (see `changed-files.ts` / `changed-files.test.ts`) is to extract pure logic and test that — which Task 1 already did for `deriveDot`, the only real logic here. The dot itself is a className lookup; its verification is `tsc` plus Task 11.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/store-seen.test.ts`. This covers the seen-gating wiring — the one piece of renderer logic not already covered by Task 1:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { deriveDot } from '../../src/shared/agent-status'
import { loadSeenAt, saveSeenAt } from '../../src/renderer/state/seen'

beforeEach(() => {
  const store: Record<string, string> = {}
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v }
  }
})

describe('seenAt persistence', () => {
  it('round-trips through localStorage', () => {
    saveSeenAt({ '/wt/a': 123 })
    expect(loadSeenAt()).toEqual({ '/wt/a': 123 })
  })

  it('returns empty when nothing was stored', () => {
    expect(loadSeenAt()).toEqual({})
  })

  it('returns empty rather than throwing on corrupt storage', () => {
    localStorage.setItem('wtm.seenAt', '{ not json')
    expect(loadSeenAt()).toEqual({})
  })

  it('drives the dot: visiting a worktree clears its finished dot', () => {
    const report = { status: 'done' as const, at: 100 }
    expect(deriveDot(report, loadSeenAt()['/wt/a'])).toBe('done')
    saveSeenAt({ '/wt/a': 200 })
    expect(deriveDot(report, loadSeenAt()['/wt/a'])).toBeNull()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/renderer/store-seen.test.ts`
Expected: FAIL — cannot resolve `../../src/renderer/state/seen`.

- [ ] **Step 3: Add the seen store**

Create `src/renderer/state/seen.ts`:

```ts
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
```

- [ ] **Step 4: Add the store state**

In `src/renderer/state/store.ts`, extend imports:

```ts
import type { AgentReport } from '@shared/agent-status'
import { loadSeenAt, saveSeenAt } from './seen'
```

Add to `State` after `statuses` (line 17):

```ts
  agentStatuses: Record<string, AgentReport>
  seenAt: Record<string, number>
```

Change the initial state (line 35):

```ts
  repos: [], worktrees: [], statuses: {}, agentStatuses: {}, seenAt: loadSeenAt(),
  openDiff: null, modalOpen: 0,
```

In `init`, after the `onStatusChanged` subscription (line 45):

```ts
    // Agent status is pushed on change only, so seed it once: the main process
    // connects to the daemon a single time (ipc.ts:37), so a window reload does
    // not re-trigger the daemon's connect-time snapshot.
    set({ agentStatuses: await window.api.getAgentStatuses() })
    window.api.onAgentStatus((p, r) => set(st => ({ agentStatuses: { ...st.agentStatuses, [p]: r } })))
```

Change `select` (line 76) to stamp the visit:

```ts
  select: (p) => {
    const seenAt = { ...get().seenAt, [p]: Date.now() }
    saveSeenAt(seenAt)
    set({ selected: p, seenAt })
    localStorage.setItem('wtm.selected', p)
  },
```

- [ ] **Step 5: Add the dot and render it**

In `src/renderer/components/Sidebar.tsx`, extend imports:

```ts
import { deriveDot, type DotState } from '@shared/agent-status'
```

Add after `BranchIcon` (line 28):

```tsx
const DOT_TITLE: Record<DotState, string> = {
  working: 'Agent working',
  permission: 'Agent waiting for permission',
  failed: 'Agent stopped on an error',
  done: 'Agent finished'
}

// Renders even when there is no dot: a fixed-width slot keeps every row's label
// at the same x position, so a starting agent never shifts the list sideways.
function AgentDot({ state }: { state: DotState | null }) {
  return <span className={`wt-agent-dot${state ? ` ${state}` : ''}`} title={state ? DOT_TITLE[state] : ''} />
}
```

Pull state in the component body (line 30):

```ts
  const { worktrees, statuses, agentStatuses, seenAt, selected, select, refreshWorktrees, repos } = useStore()
```

Inside the row map, beside `count`:

```ts
                const count = statuses[w.path]?.changeCount ?? 0
                const dot = deriveDot(agentStatuses[w.path], seenAt[w.path])
```

Render at the leading edge, before the branch/main icon:

```tsx
                        <AgentDot state={dot} />
                        {w.isMain ? <MainDotIcon /> : <BranchIcon />}
                        {w.path.split('/').filter(Boolean).pop()}
```

The dot's 7px plus the row's 6px gap adds 13px of leading indent, so bump the branch line's `paddingLeft` from `16` to `29`:

```tsx
                      <span style={{ fontSize: 11, color: '#888', overflow: 'hidden', textOverflow: 'ellipsis',
                                     whiteSpace: 'nowrap', paddingLeft: 29 }}>
                        {w.branch}
                      </span>
```

- [ ] **Step 6: Add the styles**

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
.wt-agent-dot.permission {
  background: #e0b97d;
  animation: wt-agent-pulse 1.2s ease-in-out infinite;
}
.wt-agent-dot.failed { background: #f28b82; }
.wt-agent-dot.done { background: #7d8590; }

@keyframes wt-agent-pulse {
  0%, 100% { opacity: 1; transform: scale(1); }
  50% { opacity: 0.35; transform: scale(0.75); }
}

/* Without motion the pulse cannot carry the state, so colour must. */
@media (prefers-reduced-motion: reduce) {
  .wt-agent-dot.working, .wt-agent-dot.permission { animation: none; }
}
```

- [ ] **Step 7: Run tests and typecheck**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS, no type errors.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/state/seen.ts src/renderer/state/store.ts src/renderer/components/Sidebar.tsx src/renderer/components/sidebar-theme.css tests/renderer/store-seen.test.ts
git commit -m "Show agent status dot in sidebar rows"
```

---

### Task 11: End-to-end verification in the real app

Everything above is unit-tested in isolation. Nothing has yet proved that Claude actually runs our hook.

**Files:** none (verification only).

- [ ] **Step 1: Confirm the install landed**

Run: `npm run dev`, then in another shell:

```bash
cat ~/.claude/settings.json
```

Expected: a `hooks` section with our `notify-hook.sh` on all seven events, **and every pre-existing setting still present**. If you had prior hooks, confirm they survived and that `~/.claude/settings.json.wtm-backup` exists.

- [ ] **Step 2: Confirm the script is inert outside the app**

In a plain terminal (not the app), run `claude` and give it a trivial task.

Expected: it behaves completely normally — no errors, no delay. The hook runs but exits at the env guard. This is the blast-radius check for a global install.

- [ ] **Step 3: Confirm `working`**

In one worktree's terminal inside the app, run `claude` and give it a multi-second task.

Expected: the row shows a **green pulsing** dot within a moment of the prompt being submitted. Other rows stay bare.

- [ ] **Step 4: Confirm `permission`**

Give the agent a task needing approval (something not pre-approved, e.g. `rm` a scratch file).

Expected: the dot turns **amber and pulsing** while the prompt is open. This state was impossible under the old heuristic design.

- [ ] **Step 5: Confirm `done` and seen-gating**

Approve it and let the turn finish, while looking at a *different* worktree.

Expected: the agent's row shows a **grey static** dot. Click that row: the dot **disappears**. Click away and back: it stays gone.

- [ ] **Step 6: Confirm the backstop**

Start a long turn, then from another shell: `pkill -9 -f 'claude'`.

Expected: within ~2s the dot clears to nothing. Without the backstop this row would be stuck green forever — this is the bug the sweep exists for.

- [ ] **Step 7: Confirm reload persistence**

With an agent mid-turn, reload the window (`Cmd-R`).

Expected: the dot reappears in the correct state without waiting for a status change — exercising the `getAgentStatuses()` fetch.

- [ ] **Step 8: Confirm a fresh terminal works**

Create a new worktree, open its terminal, run `claude`.

Expected: the dot works there too — proving env injection happens for every session, not just ones alive at install time.

- [ ] **Step 9: Report findings**

If any step failed, stop and report rather than patching around it. In particular, if Step 3 shows no dot, debug in this order:
1. `echo $WTM_TERMINAL_ID` inside the app's terminal — is env injection working?
2. `ls -l <configDir>/agent-hook.sock` — is the server listening?
3. Add `set -x` to the script temporarily and check whether Claude is running it at all.

---

## Notes for the implementer

- **Hooks are the source of truth. The sweep only clears.** If you find yourself making `sweep()` set a status to `working`, stop — that reintroduces the guessing this design exists to remove.
- **Never guess an event.** Both the bash script and `mapHookEvent` drop unknown input rather than defaulting. A false `Stop` clears a working indicator and lies to the user; a dropped event just delays it.
- **`~/.claude/settings.json` is not ours.** It is the user's global config for every project. Preserve unknown keys, never write a file that failed to parse, and keep the env guard as the script's first line.
- **Do not add a react testing environment** for the sidebar. Extract logic the way `changed-files.ts` was extracted if it ever grows any.
- The `agentStatuses` map is push-driven and intentionally **not** part of the 3s poll in `store.ts:49`.
