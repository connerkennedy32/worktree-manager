# PR Status Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show each worktree's GitHub PR state (draft / in review / changes requested / approved / merged / closed) as a colored dot in the sidebar, refreshed by a manual button and cached to disk.

**Architecture:** A pure state-derivation function in `@shared`, a main-process module that shells out to the `gh` CLI once per worktree, a JSON cache in userData alongside `names.json`, two IPC channels, and a dot in `WorktreeRow` plus a refresh button in the `Sidebar` header.

**Tech Stack:** TypeScript, Electron (main/preload/renderer split), React + zustand, vitest, `gh` CLI.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-08-13-pr-status-indicator-design.md`.
- All cross-process types go in `src/shared/ipc-types.ts`; channel strings only in its `IPC` const map.
- Adding an API means touching four files in order: `ipc-types.ts` → `src/main/ipc.ts` → `src/preload/index.ts` → renderer consumer.
- Tests: `npx vitest run <path>`. `npm run test:fast` excludes the slow `tests/git/**` suite.
- Main-process modules must never import `electron` at module top level if tests load them — use a lazy `require('electron')` inside the function, as `src/main/config.ts` does.
- Never throw across IPC for expected failures; return an outcome object (see `PushOutcome` for the established pattern).
- No DOM testing library exists in this repo. Do not add one. Renderer tests cover pure functions only.
- Comments explain *why*, matching the density of surrounding code. No decorative comments.

---

### Task 1: Shared PR state types and derivation

**Files:**
- Create: `src/shared/pr-status.ts`
- Test: `tests/shared/pr-status.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `type PrState`, `interface PrStatus`, `interface RawPr`, `function derivePrState(raw: RawPr): PrState`, `const PR_STATE_LABEL: Record<PrState, string>`.

- [ ] **Step 1: Write the failing test**

Create `tests/shared/pr-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { derivePrState, PR_STATE_LABEL, type RawPr } from '@shared/pr-status'

const raw = (over: Partial<RawPr> = {}): RawPr =>
  ({ number: 1, url: 'u', isDraft: false, state: 'OPEN', reviewDecision: '', ...over })

describe('derivePrState', () => {
  it('reports a merged PR as merged even when it was a draft', () => {
    expect(derivePrState(raw({ state: 'MERGED', isDraft: true }))).toBe('merged')
  })

  it('reports a closed PR as closed', () => {
    expect(derivePrState(raw({ state: 'CLOSED' }))).toBe('closed')
  })

  it('reports a draft as draft even when approved', () => {
    expect(derivePrState(raw({ isDraft: true, reviewDecision: 'APPROVED' }))).toBe('draft')
  })

  it('reports an approved open PR as approved', () => {
    expect(derivePrState(raw({ reviewDecision: 'APPROVED' }))).toBe('approved')
  })

  it('reports a changes-requested PR as changesRequested', () => {
    expect(derivePrState(raw({ reviewDecision: 'CHANGES_REQUESTED' }))).toBe('changesRequested')
  })

  it('falls back to review for REVIEW_REQUIRED, empty, and unknown decisions', () => {
    expect(derivePrState(raw({ reviewDecision: 'REVIEW_REQUIRED' }))).toBe('review')
    expect(derivePrState(raw({ reviewDecision: '' }))).toBe('review')
    expect(derivePrState(raw({ reviewDecision: 'SOMETHING_NEW' }))).toBe('review')
  })

  it('falls back to review for an unrecognized state string', () => {
    expect(derivePrState(raw({ state: 'WEIRD' }))).toBe('review')
  })

  it('labels every state', () => {
    expect(PR_STATE_LABEL.changesRequested).toBe('Changes requested')
    expect(PR_STATE_LABEL.none).toBe('No pull request')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/shared/pr-status.test.ts`
Expected: FAIL — cannot resolve `@shared/pr-status`.

- [ ] **Step 3: Write minimal implementation**

Create `src/shared/pr-status.ts`:

```ts
// PR state as shown in the sidebar. 'none' means the branch has no pull
// request at all — the row then renders no dot, rather than a neutral one.
export type PrState =
  | 'none' | 'draft' | 'review' | 'changesRequested' | 'approved' | 'merged' | 'closed'

export interface PrStatus {
  state: PrState
  number?: number
  url?: string
}

// The subset of `gh pr view --json ...` we ask for. `reviewDecision` is '' when
// the repo requires no review, and gh may add values we don't know about.
export interface RawPr {
  number: number
  url: string
  isDraft: boolean
  state: string           // OPEN | CLOSED | MERGED
  reviewDecision: string  // APPROVED | CHANGES_REQUESTED | REVIEW_REQUIRED | ''
}

export const PR_STATE_LABEL: Record<PrState, string> = {
  none: 'No pull request',
  draft: 'Draft',
  review: 'In review',
  changesRequested: 'Changes requested',
  approved: 'Approved',
  merged: 'Merged',
  closed: 'Closed'
}

// Merged/closed outrank draft because the PR's life is over either way; draft
// outranks any review decision because a stray approval on a draft doesn't make
// it reviewable. Anything unrecognized lands on 'review', the neutral open state.
export function derivePrState(raw: RawPr): PrState {
  if (raw.state === 'MERGED') return 'merged'
  if (raw.state === 'CLOSED') return 'closed'
  if (raw.isDraft) return 'draft'
  if (raw.reviewDecision === 'APPROVED') return 'approved'
  if (raw.reviewDecision === 'CHANGES_REQUESTED') return 'changesRequested'
  return 'review'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/shared/pr-status.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
git add src/shared/pr-status.ts tests/shared/pr-status.test.ts
git commit -m "Add shared PR state model and derivation"
```

---

### Task 2: Fetch PR status from the gh CLI

**Files:**
- Create: `src/main/github/gh.ts`
- Create: `src/main/github/pr-status.ts`
- Test: `tests/main/pr-status.test.ts`

**Interfaces:**
- Consumes: `derivePrState`, `PrStatus`, `RawPr` from `@shared/pr-status` (Task 1).
- Produces:
  - `src/main/github/gh.ts`: `type GhRunner = (args: string[], cwd: string) => Promise<GhResult>`, `interface GhResult { ok: boolean; stdout: string; stderr: string }`, `const runGh: GhRunner`, `function ghMissing(stderr: string): boolean`.
  - `src/main/github/pr-status.ts`: `function fetchPrStatus(worktreePath: string, run?: GhRunner): Promise<PrStatus | null>` (null = call failed, keep the cached value), `function refreshAll(paths: string[], run?: GhRunner): Promise<PrRefreshResult>`.
  - `src/shared/ipc-types.ts` gains `interface PrRefreshResult { statuses: Record<string, PrStatus>; error?: string }` in Task 4 — for this task, declare it locally in `src/main/github/pr-status.ts` and export it; Task 4 moves it to `@shared` and re-imports.

- [ ] **Step 1: Write the failing test**

Create `tests/main/pr-status.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { fetchPrStatus, refreshAll } from '../../src/main/github/pr-status'
import type { GhResult } from '../../src/main/github/gh'

const ok = (json: unknown): GhResult => ({ ok: true, stdout: JSON.stringify(json), stderr: '' })
const fail = (stderr: string): GhResult => ({ ok: false, stdout: '', stderr })

describe('fetchPrStatus', () => {
  it('maps a gh payload onto a PrStatus', async () => {
    const run = async () => ok({
      number: 42, url: 'https://gh/pr/42', isDraft: false,
      state: 'OPEN', reviewDecision: 'APPROVED'
    })
    expect(await fetchPrStatus('/wt/a', run)).toEqual({
      state: 'approved', number: 42, url: 'https://gh/pr/42'
    })
  })

  it('treats "no pull requests found" as a definite absence of a PR', async () => {
    const run = async () => fail('no pull requests found for branch "feat-x"')
    expect(await fetchPrStatus('/wt/a', run)).toEqual({ state: 'none' })
  })

  it('returns null on any other failure so the cached value survives', async () => {
    const run = async () => fail('fatal: could not resolve host github.com')
    expect(await fetchPrStatus('/wt/a', run)).toBeNull()
  })

  it('returns null on unparseable stdout', async () => {
    const run = async (): Promise<GhResult> => ({ ok: true, stdout: 'not json', stderr: '' })
    expect(await fetchPrStatus('/wt/a', run)).toBeNull()
  })

  it('runs gh in the worktree directory', async () => {
    const seen: Array<{ args: string[]; cwd: string }> = []
    const run = async (args: string[], cwd: string) => { seen.push({ args, cwd }); return fail('no pull requests found') }
    await fetchPrStatus('/wt/a', run)
    expect(seen[0].cwd).toBe('/wt/a')
    expect(seen[0].args).toEqual(['pr', 'view', '--json', 'number,url,isDraft,state,reviewDecision'])
  })
})

describe('refreshAll', () => {
  it('keys results by worktree path and skips the ones that failed', async () => {
    const run = async (_args: string[], cwd: string): Promise<GhResult> => {
      if (cwd === '/wt/a') return ok({ number: 1, url: 'u1', isDraft: true, state: 'OPEN', reviewDecision: '' })
      if (cwd === '/wt/b') return fail('no pull requests found')
      return fail('boom')
    }
    const res = await refreshAll(['/wt/a', '/wt/b', '/wt/c'], run)
    expect(res.statuses).toEqual({
      '/wt/a': { state: 'draft', number: 1, url: 'u1' },
      '/wt/b': { state: 'none' }
    })
    expect(res.error).toBeUndefined()
  })

  it('reports a gh installation problem once instead of per worktree', async () => {
    const run = async (): Promise<GhResult> => fail('gh: command not found')
    const res = await refreshAll(['/wt/a', '/wt/b'], run)
    expect(res.statuses).toEqual({})
    expect(res.error).toMatch(/gh/i)
  })

  it('reports an authentication problem', async () => {
    const run = async (): Promise<GhResult> =>
      fail('To get started with GitHub CLI, please run: gh auth login')
    const res = await refreshAll(['/wt/a'], run)
    expect(res.statuses).toEqual({})
    expect(res.error).toMatch(/auth/i)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/pr-status.test.ts`
Expected: FAIL — module `src/main/github/pr-status` not found.

- [ ] **Step 3: Write the gh runner**

Create `src/main/github/gh.ts`:

```ts
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'

export interface GhResult { ok: boolean; stdout: string; stderr: string }
export type GhRunner = (args: string[], cwd: string) => Promise<GhResult>

// A packaged Electron app inherits the launchd environment, not a login shell's,
// so PATH usually lacks Homebrew. Try the usual install locations before giving
// up and letting PATH resolution fail with a readable message.
const CANDIDATES = ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/usr/bin/gh']

export function resolveGh(): string {
  return CANDIDATES.find(existsSync) ?? 'gh'
}

// gh writes its payload to stdout and its complaints to stderr, and exits 1 for
// both "no PR here" and real failures — so the caller, not this runner, decides
// what a non-zero exit means.
export const runGh: GhRunner = (args, cwd) =>
  new Promise(resolve => {
    execFile(resolveGh(), args, { cwd, timeout: 15_000, env: process.env },
      (err, stdout, stderr) => resolve({ ok: !err, stdout, stderr: stderr || (err?.message ?? '') }))
  })

// gh being absent surfaces as ENOENT from execFile, whose message names the
// binary; the auth prompt is gh's own wording.
export function ghMissing(stderr: string): boolean {
  return /ENOENT/.test(stderr) || /command not found/i.test(stderr) || /spawn .*gh/i.test(stderr)
}

export function ghUnauthenticated(stderr: string): boolean {
  return /gh auth login/i.test(stderr) || /authentication|not logged in/i.test(stderr)
}
```

- [ ] **Step 4: Write the fetch/fan-out module**

Create `src/main/github/pr-status.ts`:

```ts
import { derivePrState, type PrStatus, type RawPr } from '@shared/pr-status'
import { ghMissing, ghUnauthenticated, runGh, type GhRunner } from './gh'

export interface PrRefreshResult {
  statuses: Record<string, PrStatus>
  error?: string
}

const FIELDS = 'number,url,isDraft,state,reviewDecision'

// gh says this when the branch simply has no PR — an ordinary answer, not a
// failure, so it maps to a real 'none' status that gets cached like any other.
const NO_PR = /no (open )?pull requests? found/i

// null means "we learned nothing" — the caller keeps whatever it had cached
// rather than blanking a dot because the network hiccuped.
export async function fetchPrStatus(
  worktreePath: string, run: GhRunner = runGh
): Promise<PrStatus | null> {
  const res = await run(['pr', 'view', '--json', FIELDS], worktreePath)
  if (!res.ok) return NO_PR.test(res.stderr) ? { state: 'none' } : null
  try {
    const raw = JSON.parse(res.stdout) as RawPr
    return { state: derivePrState(raw), number: raw.number, url: raw.url }
  } catch {
    return null
  }
}

const CONCURRENCY = 6

// A tiny worker pool rather than Promise.all: a user with twenty worktrees
// would otherwise fire twenty gh processes, each opening its own connection.
async function pool<T>(items: T[], n: number, work: (item: T) => Promise<void>): Promise<void> {
  let i = 0
  const workers = Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) await work(items[i++])
  })
  await Promise.all(workers)
}

// A missing or unauthenticated gh is one problem with the machine, not one per
// worktree, so it's reported once and no statuses come back at all.
export async function refreshAll(
  paths: string[], run: GhRunner = runGh
): Promise<PrRefreshResult> {
  const statuses: Record<string, PrStatus> = {}
  let error: string | undefined

  const probing: GhRunner = async (args, cwd) => {
    const res = await run(args, cwd)
    if (!res.ok && !NO_PR.test(res.stderr)) {
      if (ghMissing(res.stderr)) error ??= 'GitHub CLI (gh) not found. Install it to see PR status.'
      else if (ghUnauthenticated(res.stderr)) error ??= 'GitHub CLI is not authenticated. Run `gh auth login`.'
    }
    return res
  }

  await pool(paths, CONCURRENCY, async p => {
    const s = await fetchPrStatus(p, probing)
    if (s) statuses[p] = s
  })

  return error ? { statuses: {}, error } : { statuses }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run tests/main/pr-status.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 6: Commit**

```bash
git add src/main/github tests/main/pr-status.test.ts
git commit -m "Fetch per-worktree PR status from the gh CLI"
```

---

### Task 3: Persist PR status to userData

**Files:**
- Modify: `src/main/config.ts` (add alongside `readLayout`/`writeLayout`)
- Test: `tests/main/pr-status-config.test.ts`

**Interfaces:**
- Consumes: `PrStatus` from `@shared/pr-status` (Task 1).
- Produces: `readPrStatuses(): Promise<Record<string, PrStatus>>`, `writePrStatuses(statuses: Record<string, PrStatus>): Promise<Record<string, PrStatus>>` exported from `src/main/config.ts`.

Note: `tests/main/layout-config.test.ts` already shows the pattern for pointing config at a temp dir via `process.env.WTM_CONFIG_DIR`. Read it before writing this test and follow it.

- [ ] **Step 1: Write the failing test**

Create `tests/main/pr-status-config.test.ts`:

```ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-pr-'))
  process.env.WTM_CONFIG_DIR = dir
})
afterEach(() => {
  delete process.env.WTM_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('pr status cache', () => {
  it('returns {} when nothing has been written yet', async () => {
    const { readPrStatuses } = await import('../../src/main/config')
    expect(await readPrStatuses()).toEqual({})
  })

  it('round-trips statuses for worktrees that still exist', async () => {
    const { readPrStatuses, writePrStatuses } = await import('../../src/main/config')
    const live = join(dir, 'wt-live')
    mkdirSync(live)
    await writePrStatuses({ [live]: { state: 'approved', number: 7, url: 'u' } })
    expect(await readPrStatuses()).toEqual({ [live]: { state: 'approved', number: 7, url: 'u' } })
  })

  it('prunes entries whose worktree directory is gone', async () => {
    const { readPrStatuses, writePrStatuses } = await import('../../src/main/config')
    const live = join(dir, 'wt-live')
    mkdirSync(live)
    await writePrStatuses({
      [live]: { state: 'draft' },
      [join(dir, 'wt-gone')]: { state: 'merged' }
    })
    expect(await readPrStatuses()).toEqual({ [live]: { state: 'draft' } })
  })

  it('degrades to {} on a corrupt file', async () => {
    const { readPrStatuses } = await import('../../src/main/config')
    writeFileSync(join(dir, 'pr-status.json'), '{ not json')
    expect(await readPrStatuses()).toEqual({})
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/main/pr-status-config.test.ts`
Expected: FAIL — `readPrStatuses` is not exported from config.

- [ ] **Step 3: Implement in `src/main/config.ts`**

Add the import at the top, next to the existing `@shared/ipc-types` import:

```ts
import type { PrStatus } from '@shared/pr-status'
```

Add a file helper next to `layoutFile()`:

```ts
function prStatusFile(): string { return join(configDir(), 'pr-status.json') }
```

Add these functions after `writeLayout`:

```ts
// Last-known PR state per worktree path, so dots are on screen at launch
// instead of after the user remembers to hit refresh. Cosmetic and rebuildable,
// so a corrupt file degrades to "no dots" rather than throwing.
export async function readPrStatuses(): Promise<Record<string, PrStatus>> {
  const f = prStatusFile()
  if (!existsSync(f)) return {}
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'))?.statuses
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, PrStatus>
  } catch { return {} }
}

// Entries for worktrees that no longer exist are dropped here rather than on
// read, so the file doesn't accumulate every branch the user has ever had.
export async function writePrStatuses(
  statuses: Record<string, PrStatus>
): Promise<Record<string, PrStatus>> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const live = Object.fromEntries(Object.entries(statuses).filter(([p]) => existsSync(p)))
  writeFileSync(prStatusFile(), `${JSON.stringify({ statuses: live }, null, 2)}\n`)
  return live
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/main/pr-status-config.test.ts`
Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/main/config.ts tests/main/pr-status-config.test.ts
git commit -m "Cache PR status in userData"
```

---

### Task 4: Wire PR status across IPC

**Files:**
- Modify: `src/shared/ipc-types.ts` (types, `Api`, `IPC` map)
- Modify: `src/main/github/pr-status.ts` (import `PrRefreshResult` from shared instead of declaring it)
- Modify: `src/main/ipc.ts`
- Modify: `src/preload/index.ts`

**Interfaces:**
- Consumes: `refreshAll` (Task 2), `readPrStatuses`/`writePrStatuses` (Task 3).
- Produces: `window.api.getPrStatuses(): Promise<Record<string, PrStatus>>` and `window.api.refreshPrStatuses(paths: string[]): Promise<PrRefreshResult>`.

- [ ] **Step 1: Move `PrRefreshResult` into shared types**

In `src/shared/ipc-types.ts`, add near the top with the other imports:

```ts
import type { PrStatus } from './pr-status'
```

Add after the `SyncOutcome` type:

```ts
// A refresh reports both what it learned and, if the machine's gh is missing or
// logged out, one message explaining why nothing came back — the button needs
// something to say, and that failure is not per worktree.
export interface PrRefreshResult {
  statuses: Record<string, PrStatus>
  error?: string
}
```

Add to the `Api` interface, after `syncWithTrunk`:

```ts
  // GitHub PR state per worktree. getPrStatuses returns the disk cache without
  // touching the network; refreshPrStatuses shells out to `gh` once per path and
  // is only ever called from the sidebar's refresh button.
  getPrStatuses(): Promise<Record<string, PrStatus>>
  refreshPrStatuses(worktreePaths: string[]): Promise<PrRefreshResult>
  // Open an absolute https URL in the OS browser. Distinct from openInBrowser,
  // which takes a worktree-relative file and builds a file:// URL from it.
  openUrl(url: string): void
```

Add to the `IPC` const map, after the `gtCreate` line:

```ts
  getPrStatuses: 'pr:get', refreshPrStatuses: 'pr:refresh', openUrl: 'browser:openUrl',
```

Then in `src/main/github/pr-status.ts`, delete the local `PrRefreshResult` interface and import it instead:

```ts
import type { PrRefreshResult } from '@shared/ipc-types'
```

- [ ] **Step 2: Register the main handlers**

In `src/main/ipc.ts`, add the import next to the other git imports:

```ts
import { refreshAll } from './github/pr-status'
```

Inside `registerIpc`, next to the `IPC.syncWithTrunk` handler, add:

```ts
  ipcMain.handle(IPC.getPrStatuses, () => config.readPrStatuses())
  // Merged into the cache rather than replacing it: a worktree whose gh call
  // failed keeps its previous dot instead of going blank.
  ipcMain.handle(IPC.refreshPrStatuses, async (_e, paths: string[]) => {
    const res = await refreshAll(paths)
    if (res.error) return res
    const merged = { ...(await config.readPrStatuses()), ...res.statuses }
    return { statuses: await config.writePrStatuses(merged) }
  })
  // https only: a malformed cached value must not become an arbitrary-scheme
  // launch, and every URL this sends comes from `gh pr view`.
  ipcMain.on(IPC.openUrl, (_e, url: string) => {
    if (/^https:\/\//.test(url)) shell.openExternal(url)
  })
```

- [ ] **Step 3: Add the preload passthrough**

In `src/preload/index.ts`, after the `syncWithTrunk` line:

```ts
  getPrStatuses: () => ipcRenderer.invoke(IPC.getPrStatuses),
  refreshPrStatuses: (paths) => ipcRenderer.invoke(IPC.refreshPrStatuses, paths),
```

And next to the existing `openInBrowser` line:

```ts
  openUrl: (url) => ipcRenderer.send(IPC.openUrl, url),
```

- [ ] **Step 4: Verify it typechecks and nothing regressed**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: no errors. If `tsc -p` is not configured for a clean run in this repo, run `npm run build` instead and expect a successful build.

Run: `npm run test:fast`
Expected: PASS, no regressions.

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-types.ts src/main/ipc.ts src/main/github/pr-status.ts src/preload/index.ts
git commit -m "Expose PR status over IPC"
```

---

### Task 5: Show the dot and the refresh button

**Files:**
- Modify: `src/renderer/state/store.ts`
- Modify: `src/renderer/components/WorktreeRow.tsx`
- Modify: `src/renderer/components/Sidebar.tsx:218-226` (the header row)
- Modify: `src/renderer/components/sidebar-theme.css`

**Interfaces:**
- Consumes: `window.api.getPrStatuses` / `window.api.refreshPrStatuses` (Task 4), `PrStatus` and `PR_STATE_LABEL` (Task 1).
- Produces: store fields `prStatuses`, `prError`, `prRefreshing`, and action `refreshPrStatuses()`.

- [ ] **Step 1: Add PR state to the store**

In `src/renderer/state/store.ts`, add to the imports:

```ts
import type { PrStatus } from '@shared/pr-status'
```

Add to the `State` interface, after `seenAt`:

```ts
  // GitHub PR state per worktree path. Refreshed only when the user asks — the
  // sidebar header button — and seeded from the main-process disk cache at init.
  prStatuses: Record<string, PrStatus>
  prRefreshing: boolean
  prError?: string
  refreshPrStatuses: () => Promise<void>
```

Add to the store's initial state, next to `names: {}`:

```ts
  prStatuses: {}, prRefreshing: false,
```

Add the action, after `refreshStatus`:

```ts
  refreshPrStatuses: async () => {
    if (get().prRefreshing) return
    set({ prRefreshing: true })
    try {
      const paths = get().worktrees.map(w => w.path)
      const res = await window.api.refreshPrStatuses(paths)
      // On error the main process returns no statuses at all, so keep the ones
      // already on screen and just surface the message on the button.
      set(res.error ? { prError: res.error } : { prStatuses: res.statuses, prError: undefined })
    } catch (e: any) {
      set({ prError: e?.message ?? String(e) })
    } finally {
      set({ prRefreshing: false })
    }
  },
```

In `init`, right after the `set({ agentStatuses: ... })` line, seed the cache:

```ts
    set({ prStatuses: await window.api.getPrStatuses() })
```

- [ ] **Step 2: Render the dot in `WorktreeRow.tsx`**

Add to the imports:

```ts
import { PR_STATE_LABEL } from '@shared/pr-status'
```

Add a component next to `WorkingSpinner`:

```tsx
function PrDot({ path }: { path: string }) {
  const pr = useStore(st => st.prStatuses[path])
  if (!pr || pr.state === 'none') return null
  const label = pr.number ? `PR #${pr.number} · ${PR_STATE_LABEL[pr.state]}` : PR_STATE_LABEL[pr.state]
  return (
    <span className={`wt-pr-dot wt-pr-${pr.state}`}
          title={label}
          onClick={e => { e.stopPropagation(); if (pr.url) window.api.openUrl(pr.url) }} />
  )
}
```

`window.api.openUrl` is the API added in Task 4. Do not use `openInBrowser` — it takes a worktree-relative file and builds a `file://` URL, which is the wrong thing for a PR link.

Render it in the name row, immediately after the existing icon expression on line 80:

```tsx
          {dot === 'working' ? <WorkingSpinner /> : (w.isMain ? <MainDotIcon /> : <BranchIcon />)}
          <PrDot path={w.path} />
```

- [ ] **Step 3: Add the refresh button to the header**

In `src/renderer/components/Sidebar.tsx`, pull the new fields from the store in the existing destructure at line 14:

```ts
  const { worktrees, statuses, names, rename, selected, select, refreshWorktrees, repos,
          prRefreshing, prError, refreshPrStatuses } = useStore()
```

Replace the header block (lines 221-226) with:

```tsx
      <div style={{ padding: 8, fontWeight: 600, borderBottom: '1px solid #333',
                    display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>WORKTREES</span>
        <button className="wt-btn wt-btn-ghost"
                onClick={refreshPrStatuses}
                disabled={prRefreshing}
                title={prError ?? 'Refresh PR status'}>
          <span className={prRefreshing ? 'wt-pr-spin' : undefined}>↻</span>
        </button>
        <button className="wt-btn wt-btn-ghost" onClick={createGroup}>+ Group</button>
        <button className="wt-btn wt-btn-ghost" onClick={addRepo}>+ Repo</button>
      </div>
```

- [ ] **Step 4: Add the styles**

Append to `src/renderer/components/sidebar-theme.css`:

```css
.wt-pr-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
  display: inline-block;
  cursor: pointer;
}
.wt-pr-draft            { background: #8b949e; }
.wt-pr-review           { background: #d29922; }
.wt-pr-changesRequested { background: #f28b82; }
.wt-pr-approved         { background: #3fb950; }
.wt-pr-merged           { background: #a371f7; }
.wt-pr-closed           { background: #6e7681; }

.wt-pr-spin {
  display: inline-block;
  animation: wt-row-spin 0.8s linear infinite;
}
@media (prefers-reduced-motion: reduce) {
  .wt-pr-spin { animation: none; }
}
```

- [ ] **Step 5: Verify**

Run: `npm run test:fast`
Expected: PASS, no regressions.

Run: `npm run build`
Expected: successful build, no type errors.

Then launch the app (`npm run dev`), click the ↻ button with at least one worktree whose branch has an open PR, and confirm: a colored dot appears on that row, its tooltip reads `PR #N · <state>`, clicking it opens the PR in the browser, and worktrees with no PR show no dot. Quit and relaunch to confirm the dots come back from cache without pressing refresh.

- [ ] **Step 6: Commit**

```bash
git add src/renderer src/shared src/main src/preload
git commit -m "Show PR status dots and a sidebar refresh button"
```
