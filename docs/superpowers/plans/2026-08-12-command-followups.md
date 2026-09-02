# Repo Command Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a repo command, after it succeeds, select a worktree in the sidebar and type lines into that worktree's terminal — collapsing "create worktree → click it → tmux → cc → paste ticket" into one button press.

**Architecture:** Two optional fields (`select`, `terminal`) on `RepoCommand`. The main process already knows the command's `cwd` and its substitution variables, so it resolves both fields and returns them on the `CommandOutcome`. The renderer selects the returned path; a new `term:runLines` IPC starts that worktree's pty and types the lines, waiting for the pty to go quiet between them. Spec: `docs/superpowers/specs/2026-08-12-command-followups-design.md`.

**Tech Stack:** TypeScript, Electron (main/preload/renderer), Zustand store, Vitest.

## Global Constraints

- Follow-ups are **best-effort**: they never turn an `ok: true` outcome into a failure, and never surface their own error message.
- A malformed `select`/`terminal` invalidates **that one command entry** only — `parseCommandsFile` keeps dropping bad entries individually.
- Substitution uses `substituteShell` when `command.shell === true`, else literal `substitute`-style replacement — matching how `run` is treated in the same mode.
- Quiet-wait constants are fixed, not configurable: `QUIET_MS = 250`, `MAX_WAIT_MS = 2000`.
- No new dependencies.
- Run the suite with `npx vitest run <path>`.

---

## File Structure

| File | Responsibility |
|---|---|
| `src/shared/ipc-types.ts` (modify) | `select`/`terminal` on `RepoCommand`; `select`/`terminal` on `CommandOutcome`; `termRunLines` on the API surface + `IPC` channel map |
| `src/shared/repo-commands.ts` (modify) | validate the two new fields in `isRepoCommand`; document them in `exampleCommandsFile` |
| `src/main/command-followups.ts` (create) | pure: given a command, its cwd and vars, produce the absolute `select` path and the substituted `terminal` lines |
| `src/main/repo-commands.ts` (modify) | call the above and attach the result to a successful outcome |
| `src/main/term-lines.ts` (create) | pure-ish: type lines into a sink, waiting for quiet between them |
| `src/main/ipc.ts` (modify) | pty data taps + the `term:runLines` handler |
| `src/preload/index.ts` (modify) | expose `termRunLines` |
| `src/renderer/components/DiffPanel.tsx` (modify) | after a successful command, select the returned worktree and send the lines |
| `tests/shared/repo-commands.test.ts` (modify) | validation cases |
| `tests/main/command-followups.test.ts` (create) | resolution + substitution cases |
| `tests/main/term-lines.test.ts` (create) | sequencing, quiet-wait, cap |

---

### Task 1: Config surface — types, validation, docs

**Files:**
- Modify: `src/shared/ipc-types.ts` (`RepoCommand` ~line 81, `CommandOutcome` line 79)
- Modify: `src/shared/repo-commands.ts` (`isRepoCommand` ~line 74, `exampleCommandsFile` ~line 130)
- Test: `tests/shared/repo-commands.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `RepoCommand.select?: string`, `RepoCommand.terminal?: string[]`, `CommandOutcome.select?: string`, `CommandOutcome.terminal?: string[]`.

- [ ] **Step 1: Write the failing tests**

Append to `tests/shared/repo-commands.test.ts` (it already imports `parseCommandsFile`; add the import if absent):

```ts
describe('select and terminal follow-ups', () => {
  const wrap = (cmd: unknown) => parseCommandsFile({ '/repo': [cmd] })['/repo']

  it('keeps valid select and terminal fields', () => {
    const entries = wrap({
      label: 'New worktree', run: 'git worktree add ../wt/{{name}}',
      select: '../wt/{{name}}', terminal: ['tmux new -s {{name}}']
    })
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ select: '../wt/{{name}}', terminal: ['tmux new -s {{name}}'] })
  })

  it('drops an entry whose select is not a non-empty string', () => {
    expect(wrap({ label: 'a', run: 'b', select: '   ' })).toHaveLength(0)
    expect(wrap({ label: 'a', run: 'b', select: 3 })).toHaveLength(0)
  })

  it('drops an entry whose terminal is not an array of non-empty strings', () => {
    expect(wrap({ label: 'a', run: 'b', terminal: 'tmux' })).toHaveLength(0)
    expect(wrap({ label: 'a', run: 'b', terminal: ['ok', ''] })).toHaveLength(0)
    expect(wrap({ label: 'a', run: 'b', terminal: [1] })).toHaveLength(0)
  })

  it('keeps sibling entries when one has a bad follow-up', () => {
    const entries = parseCommandsFile({ '/repo': [
      { label: 'bad', run: 'x', terminal: 'nope' },
      { label: 'good', run: 'y' }
    ] })['/repo']
    expect(entries.map(e => (e as { label: string }).label)).toEqual(['good'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/shared/repo-commands.test.ts`
Expected: FAIL — entries with a bad `select`/`terminal` are currently kept.

- [ ] **Step 3: Add the types**

In `src/shared/ipc-types.ts`, replace `export type CommandOutcome = { ok: boolean; message: string }` with:

```ts
export type CommandOutcome = {
  ok: boolean
  message: string
  // Follow-ups the command asked for, resolved by main: an absolute worktree
  // path to select, and terminal lines with placeholders already substituted.
  // Only present on a successful run.
  select?: string
  terminal?: string[]
}
```

Then add to the `RepoCommand` interface, after the `shell` field:

```ts
  // After the command succeeds, select this worktree in the sidebar. Resolved
  // against the command's effective cwd, so `../.worktrees/{{name}}` works from
  // a `cwd: "repo"` command. A path that matches no worktree is a no-op.
  select?: string
  // Lines typed into the selected worktree's terminal, each followed by Enter.
  // Without `select`, they go to whatever worktree is already selected.
  terminal?: string[]
```

- [ ] **Step 4: Add the validation**

In `src/shared/repo-commands.ts`, inside `isRepoCommand`, before the final `return true`:

```ts
  if (v.select !== undefined && (typeof v.select !== 'string' || !v.select.trim())) return false
  if (v.terminal !== undefined) {
    if (!Array.isArray(v.terminal)) return false
    if (!v.terminal.every(l => typeof l === 'string' && l.trim())) return false
  }
```

- [ ] **Step 5: Document the fields in the example file**

In `exampleCommandsFile`, add these lines to the `'// how this works'` array, after the `cwd` line:

```ts
        'select: a path to select in the sidebar once the command succeeds -',
        'resolved against cwd, e.g. "../.worktrees/{{name}}" for a cwd:"repo" command.',
        'terminal: lines typed into that worktree\'s terminal, each with Enter.',
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run tests/shared/repo-commands.test.ts`
Expected: PASS, including the pre-existing cases.

- [ ] **Step 7: Commit**

```bash
git add src/shared/ipc-types.ts src/shared/repo-commands.ts tests/shared/repo-commands.test.ts
git commit -m "Accept select and terminal follow-ups on a repo command"
```

---

### Task 2: Resolve follow-ups in main

**Files:**
- Create: `src/main/command-followups.ts`
- Modify: `src/main/repo-commands.ts`
- Test: `tests/main/command-followups.test.ts`

**Interfaces:**
- Consumes: `RepoCommand.select`/`.terminal` (Task 1); existing `substituteShell` and `PLACEHOLDER`-based substitution from `@shared/repo-commands`.
- Produces: `resolveFollowUps(command: RepoCommand, cwd: string, vars: Record<string, string>): { select?: string; terminal?: string[] }`, and a `CommandOutcome` carrying those fields.

- [ ] **Step 1: Export a string-level substitute from shared**

`substitute` in `src/shared/repo-commands.ts` takes tokens, not a string. Add alongside it:

```ts
// Non-shell substitution for a value that is not a command line — a path, or a
// line of terminal input — so it is not tokenized and not shell-quoted.
export function substituteText(text: string, vars: Record<string, string>): string {
  return text.replace(PLACEHOLDER, (_m, name: string) => vars[name] ?? '')
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/main/command-followups.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { resolveFollowUps } from '../../src/main/command-followups'
import type { RepoCommand } from '../../src/shared/ipc-types'

const base: RepoCommand = { label: 'New worktree', run: 'git worktree add x' }
const vars = { name: 'roo-1234-fix', repo: '/code/app', worktree: '/code/app' }

describe('resolveFollowUps', () => {
  it('is empty when the command declares neither field', () => {
    expect(resolveFollowUps(base, '/code/app', vars)).toEqual({})
  })

  it('resolves a relative select against the cwd', () => {
    const out = resolveFollowUps({ ...base, select: '../.worktrees/{{name}}' }, '/code/app', vars)
    expect(out.select).toBe('/code/.worktrees/roo-1234-fix')
  })

  it('leaves an absolute select absolute', () => {
    const out = resolveFollowUps({ ...base, select: '/tmp/{{name}}' }, '/code/app', vars)
    expect(out.select).toBe('/tmp/roo-1234-fix')
  })

  it('substitutes terminal lines literally in non-shell mode', () => {
    const out = resolveFollowUps(
      { ...base, terminal: ['tmux new -s {{name}} \\; send-keys \'cc "{{name}} solve this"\' Enter'] },
      '/code/app', vars
    )
    expect(out.terminal).toEqual([
      'tmux new -s roo-1234-fix \\; send-keys \'cc "roo-1234-fix solve this"\' Enter'
    ])
  })

  it('shell-quotes terminal lines when the command is shell mode', () => {
    const out = resolveFollowUps(
      { ...base, shell: true, terminal: ['cc {{name}}'] }, '/code/app', { name: "it's" }
    )
    expect(out.terminal).toEqual([`cc 'it'\\''s'`])
  })

  it('resolves an unknown placeholder to empty rather than leaving it literal', () => {
    const out = resolveFollowUps({ ...base, terminal: ['cc {{nope}}'] }, '/code/app', vars)
    expect(out.terminal).toEqual(['cc '])
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run tests/main/command-followups.test.ts`
Expected: FAIL — cannot resolve `src/main/command-followups`.

- [ ] **Step 4: Implement the module**

Create `src/main/command-followups.ts`:

```ts
import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { RepoCommand } from '@shared/ipc-types'
import { substituteShell, substituteText } from '@shared/repo-commands'

// The select path is compared against `git worktree list` output, which reports
// real paths — so a symlinked parent (/tmp on macOS) would otherwise never
// match. A path that does not exist yet stays as resolved.
function realIfPossible(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

// Placeholders in these fields follow the same rule as `run`: shell mode quotes
// values for you, plain mode inserts them verbatim.
export function resolveFollowUps(
  command: RepoCommand,
  cwd: string,
  vars: Record<string, string>
): { select?: string; terminal?: string[] } {
  const sub = (text: string): string =>
    command.shell ? substituteShell(text, vars) : substituteText(text, vars)

  const out: { select?: string; terminal?: string[] } = {}
  if (command.select) out.select = realIfPossible(resolve(cwd, substituteText(command.select, vars)))
  if (command.terminal?.length) out.terminal = command.terminal.map(sub)
  return out
}
```

Note: `select` always uses `substituteText`, never shell quoting — it is a path, not a command line, and quoting it would corrupt the path.

Update the shell-mode test expectation in Step 2 only if it disagrees with this rule; it should not.

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run tests/main/command-followups.test.ts`
Expected: PASS.

- [ ] **Step 6: Attach the follow-ups to a successful outcome**

In `src/main/repo-commands.ts`, add the import:

```ts
import { resolveFollowUps } from './command-followups'
```

and replace the final success return:

```ts
  if (code !== 0) return { ok: false, message: lastLine(output) || `${file} exited ${code}.` }
  // Only on success: a command that failed should not select or type anything.
  return { ok: true, message: `${command.label} done`, ...resolveFollowUps(command, cwd, vars) }
```

- [ ] **Step 7: Run the full suite**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/command-followups.ts src/main/repo-commands.ts src/shared/repo-commands.ts tests/main/command-followups.test.ts
git commit -m "Resolve command follow-ups and return them on the outcome"
```

---

### Task 3: Type lines into a worktree's terminal

**Files:**
- Create: `src/main/term-lines.ts`
- Modify: `src/main/ipc.ts` (pty `onData` closure ~line 66, near the lazygit handler ~line 125, `termInput` ~line 174)
- Modify: `src/shared/ipc-types.ts` (API surface ~line 229, `IPC` map ~line 274)
- Modify: `src/preload/index.ts`
- Test: `tests/main/term-lines.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces: `sendLines(lines: string[], sink: LineSink, opts?: { quietMs?: number; maxMs?: number }): Promise<void>` where `LineSink = { write(data: string): void; onData(cb: () => void): () => void }`; IPC `termRunLines(worktreePath: string, lines: string[]): void`.

- [ ] **Step 1: Write the failing test**

Create `tests/main/term-lines.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendLines } from '../../src/main/term-lines'

function fakeSink() {
  const written: string[] = []
  const listeners = new Set<() => void>()
  return {
    written,
    emit: () => listeners.forEach(l => l()),
    sink: {
      write: (d: string) => { written.push(d) },
      onData: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) }
    }
  }
}

describe('sendLines', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends the first line immediately, each with Enter', async () => {
    const { sink, written } = fakeSink()
    void sendLines(['tmux'], sink)
    expect(written).toEqual(['tmux\r'])
  })

  it('waits for quiet before each subsequent line', async () => {
    const { sink, written, emit } = fakeSink()
    const done = sendLines(['tmux', 'cc go'], sink, { quietMs: 250, maxMs: 2000 })
    expect(written).toEqual(['tmux\r'])

    // Output keeps arriving: the quiet window keeps restarting.
    await vi.advanceTimersByTimeAsync(200); emit()
    await vi.advanceTimersByTimeAsync(200)
    expect(written).toEqual(['tmux\r'])

    await vi.advanceTimersByTimeAsync(250)
    await done
    expect(written).toEqual(['tmux\r', 'cc go\r'])
  })

  it('gives up waiting at the cap when output never stops', async () => {
    const { sink, written, emit } = fakeSink()
    const done = sendLines(['tmux', 'cc go'], sink, { quietMs: 250, maxMs: 2000 })
    const chatty = setInterval(emit, 100)
    await vi.advanceTimersByTimeAsync(2000)
    clearInterval(chatty)
    await done
    expect(written).toEqual(['tmux\r', 'cc go\r'])
  })

  it('unsubscribes from output when finished', async () => {
    const { sink, emit } = fakeSink()
    const off = vi.fn()
    const spied = { ...sink, onData: (cb: () => void) => { sink.onData(cb); return off } }
    const done = sendLines(['a', 'b'], spied, { quietMs: 250, maxMs: 2000 })
    await vi.advanceTimersByTimeAsync(250)
    await done
    emit()
    expect(off).toHaveBeenCalled()
  })

  it('does nothing for an empty list', async () => {
    const { sink, written } = fakeSink()
    await sendLines([], sink)
    expect(written).toEqual([])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/main/term-lines.test.ts`
Expected: FAIL — cannot resolve `src/main/term-lines`.

- [ ] **Step 3: Implement the sequencer**

Create `src/main/term-lines.ts`:

```ts
// Typing a line before the previous one has produced a shell ready to receive
// it sends keystrokes somewhere unintended — `cc` arriving before tmux exists.
// Waiting for the pty to fall silent is the closest available proxy for "ready".
export const QUIET_MS = 250
// A program that never stops printing would otherwise stall the sequence
// forever. Past this point we type anyway and accept the race; the one-line
// `tmux new … \; send-keys …` form avoids the question entirely.
export const MAX_WAIT_MS = 2_000

export interface LineSink {
  write(data: string): void
  // Called on every chunk of pty output; returns an unsubscribe.
  onData(cb: () => void): () => void
}

function waitForQuiet(sink: LineSink, quietMs: number, maxMs: number): Promise<void> {
  return new Promise(resolve => {
    let quietTimer: ReturnType<typeof setTimeout>
    let off: () => void = () => {}
    const finish = (): void => {
      clearTimeout(quietTimer)
      clearTimeout(capTimer)
      off()
      resolve()
    }
    const restart = (): void => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, quietMs)
    }
    const capTimer = setTimeout(finish, maxMs)
    off = sink.onData(restart)
    restart()
  })
}

export async function sendLines(
  lines: string[],
  sink: LineSink,
  opts: { quietMs?: number; maxMs?: number } = {}
): Promise<void> {
  const { quietMs = QUIET_MS, maxMs = MAX_WAIT_MS } = opts
  for (let i = 0; i < lines.length; i++) {
    // Not before the first line: the pty buffers input written before the shell
    // is up, which is how the lazygit button has always worked.
    if (i > 0) await waitForQuiet(sink, quietMs, maxMs)
    sink.write(`${lines[i]}\r`)
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/main/term-lines.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the IPC channel and API type**

In `src/shared/ipc-types.ts`, in the terminal section of the API interface, after `termInput`:

```ts
  // Types lines into a worktree's terminal, starting it if needed. Fire-and-
  // forget: pacing between lines happens in main.
  termRunLines(worktreePath: string, lines: string[]): void
```

and in the `IPC` map, alongside `termInput`:

```ts
  termRunLines: 'term:runLines',
```

In `src/preload/index.ts`, next to the existing `termInput` binding:

```ts
  termRunLines: (p, lines) => ipcRenderer.send(IPC.termRunLines, p, lines),
```

- [ ] **Step 6: Wire the pty data tap and the handler in main**

In `src/main/ipc.ts`, add the import and a module-level tap registry near the `ptys` declaration (~line 30):

```ts
import { sendLines, type LineSink } from './term-lines'

// The daemon client delivers output through one callback, so anything else that
// needs to observe a worktree's output registers here instead.
const dataTaps = new Map<string, Set<() => void>>()

function ptySink(path: string): LineSink {
  return {
    write: data => ptys.write(path, data),
    onData: cb => {
      const set = dataTaps.get(path) ?? new Set()
      dataTaps.set(path, set)
      set.add(cb)
      return () => { set.delete(cb); if (!set.size) dataTaps.delete(path) }
    }
  }
}
```

In the `PtyDaemonClient.connect(...)` call at ~line 66, add the tap notification to the existing `onData` closure body (keep everything it already does — the `send(IPC.termData, ...)` forward — and add):

```ts
      dataTaps.get(path)?.forEach(cb => cb())
```

Then add the handler next to the lazygit one (~line 125):

```ts
  ipcMain.on(IPC.termRunLines, (_e, p: string, lines: string[]) => {
    ptys.start(p)
    // Best-effort: a failed write must not take down the command that asked for it.
    void sendLines(lines, ptySink(p)).catch(() => {})
  })
```

- [ ] **Step 7: Verify it builds and the suite passes**

Run: `npm run build && npx vitest run`
Expected: build succeeds, all tests PASS.

- [ ] **Step 8: Commit**

```bash
git add src/main/term-lines.ts src/main/ipc.ts src/shared/ipc-types.ts src/preload/index.ts tests/main/term-lines.test.ts
git commit -m "Add term:runLines, typing paced lines into a worktree terminal"
```

---

### Task 4: Wire the follow-ups into the command button

**Files:**
- Modify: `src/renderer/components/DiffPanel.tsx` (`doRepoCommand`, ~line 201-212)
- Modify: `README.md` (the "Features" list)

**Interfaces:**
- Consumes: `CommandOutcome.select`/`.terminal` (Task 2), `window.api.termRunLines` (Task 3), the store's `select` action and `worktrees` list.
- Produces: no new exports.

- [ ] **Step 1: Confirm what DiffPanel already pulls from the store**

Run: `grep -n "useStore" src/renderer/components/DiffPanel.tsx | head`

`doRepoCommand` already uses `refreshStatus` and `refreshWorktrees`. Add `select` and `worktrees` to whatever selector pattern that file uses — do not introduce a second pattern.

- [ ] **Step 2: Apply the follow-ups**

In `doRepoCommand`, replace the body of the `try` block with:

```ts
      const outcome = await window.api.runRepoCommand({
        worktreePath: selected, command, inputs, message: msg.trim(), branch
      })
      setResult({ ...outcome, source: 'command' })
      await refreshStatus(selected)
      await refreshWorktrees()

      // Follow-ups are best-effort and never change the reported outcome: a
      // select that matches nothing (the command made no worktree, or made it
      // somewhere else) simply types nothing rather than typing into the wrong
      // terminal.
      if (outcome.ok) {
        const target = outcome.select
          ? useStore.getState().worktrees.find(w => w.path === outcome.select)?.path
          : selected
        if (target) {
          if (target !== selected) select(target)
          if (outcome.terminal?.length) window.api.termRunLines(target, outcome.terminal)
        }
      }
```

`useStore.getState()` rather than the closed-over `worktrees`: the list was refreshed a line earlier, and the closure still holds the pre-refresh value.

- [ ] **Step 3: Verify it builds**

Run: `npm run build && npx vitest run`
Expected: build succeeds, all tests PASS.

- [ ] **Step 4: Document the feature**

In `README.md`, extend the "Worktree launchpad" bullet with a sentence:

```markdown
  A repo command can add `"select"` and `"terminal"` to jump to the worktree it
  just created and type into its terminal — e.g. creating a worktree from a
  Linear branch name and landing in tmux with Claude Code already on the ticket.
```

- [ ] **Step 5: Verify by hand**

Add to your commands file for a real repo:

```json
{
  "label": "Create worktree",
  "run": "git worktree add --no-track -b {{name}} ../.worktrees/{{name}} main",
  "cwd": "repo",
  "select": "../.worktrees/{{name}}",
  "terminal": ["tmux new -s {{name}} \\; send-keys 'cc \"{{name}} solve this\"' Enter"]
}
```

Run `npm run dev`, click the button, paste a Linear branch name. Expected: the new worktree is created and selected, its terminal shows a tmux session, and Claude Code is running with the branch name and "solve this". Confirm this before claiming the feature works — nothing in the suite covers tmux.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/DiffPanel.tsx README.md
git commit -m "Select and type into the worktree a command just created"
```

---

## Self-Review Notes

- Spec coverage: config surface (Task 1), substitution + shell-mode rule + path resolution (Task 2), execution order and pty start (Tasks 3-4), timing with both mitigations (Task 3), best-effort error handling (Tasks 2 and 4), all four test areas (Tasks 1-3, with the by-hand tmux check in Task 4).
- One deviation worth flagging: the spec says `select` follows the command's shell-mode quoting; the plan always substitutes it literally, because shell-quoting a path would embed quote characters into the path and guarantee no match. Update the spec's "Config surface" paragraph to say so.
