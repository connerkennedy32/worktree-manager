# Diff Modal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clicking a file in the changes panel opens a full-app modal that renders that file's diff, lets the user browse and stage other files without closing, and toggles between inline and side-by-side rendering with the choice persisted.

**Architecture:** Row-derivation logic moves out of `DiffPanel` into `changed-files.ts` (pure functions + a hook) so the panel and the new modal render the same list from one source. `openDiff` in the zustand store is the open/closed signal — the panel writes it, the modal reads it. `DiffModal` renders from `App.tsx` as a fixed full-viewport overlay. `DiffPanel` loses all inline-diff machinery and becomes a launcher plus commit box.

**Tech Stack:** React 18, zustand 4, react-diff-view 3, TypeScript, Vitest 2 (node environment), Electron + electron-vite.

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-16-diff-modal-design.md`. Read it before Task 1.
- Branch: `diff-modal` (already checked out, spec already committed).
- **Testing reality:** `vitest.config.ts` sets `environment: 'node'` and `include: ['tests/**/*.test.ts']`. There is no jsdom, no `@testing-library/react`, and no existing renderer test. **Do not add a renderer test stack** — it is not in the spec's scope. TDD applies to the pure functions in Task 1, which run in the existing node environment. Components are verified manually per the spec's Testing section.
- Do not modify anything under `src/main/` or `src/shared/`. This change adds no IPC and reuses `window.api.getFileDiff`, `window.api.stagePath`, `window.api.getCommittedFiles` exactly as they exist.
- `localStorage` keys in this codebase are namespaced `wtm.*` (see `store.ts:35` → `wtm.selected`). The view preference key is therefore **`wtm.diffView`**, values `'split'` | `'unified'`, defaulting to `'split'`.
- Existing status-letter colors, copy strings, and dark surface values are reused verbatim: `#2d2d2d` surface, `#444` border, radius 6, `1px solid #333` dividers, `system-ui` for chrome.
- Run `npx tsc --noEmit` before each commit. The project has no lint step.

---

### Task 1: Pure row derivation + `useChangedFiles` hook

Extracts the list logic `DiffPanel` owns today so both surfaces share it. The pure
functions are the only genuinely testable unit in this change — they get TDD.

**Files:**
- Create: `src/renderer/components/changed-files.ts`
- Modify: `src/renderer/state/store.ts` (add `DiffTarget` type + `openDiff` state)
- Test: `tests/renderer/changed-files.test.ts`

**Interfaces:**
- Consumes: `WorktreeStatus`, `CommittedChanges` from `@shared/ipc-types` (already exist, unchanged).
- Produces:
  - `DiffTarget = { key: string; path: string; staged: boolean; untracked: boolean; committed: boolean }` — exported from `src/renderer/state/store.ts`.
  - `Row extends DiffTarget { code: string }` — exported from `changed-files.ts`.
  - `buildWorkingRows(status?: WorktreeStatus): Row[]`
  - `buildCommittedRows(committed: CommittedChanges | null): Row[]`
  - `useChangedFiles(selected?: string): { stagedRows: Row[]; unstagedRows: Row[]; committedRows: Row[]; committed: CommittedChanges | null; stagedCount: number; total: number }`
  - Store gains `openDiff: DiffTarget | null` and `setOpenDiff: (t: DiffTarget | null) => void`.

Row keys keep today's suffix scheme exactly: `path + ':s'` staged, `path + ':w'`
unstaged, `path + ':u'` untracked, `path + ':c'` committed. Task 3 depends on these
suffixes to re-target the open file after staging.

- [ ] **Step 1: Write the failing test**

Create `tests/renderer/changed-files.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildWorkingRows, buildCommittedRows } from '../../src/renderer/components/changed-files'
import type { WorktreeStatus, CommittedChanges } from '@shared/ipc-types'

const status = (files: WorktreeStatus['files']): WorktreeStatus =>
  ({ worktreePath: '/wt', files, changeCount: files.length })

describe('buildWorkingRows', () => {
  it('returns nothing when status is missing', () => {
    expect(buildWorkingRows(undefined)).toEqual([])
  })

  it('maps an untracked file to a single untracked row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: '?', working: '?' }]))
    expect(rows).toEqual([
      { key: 'a.ts:u', path: 'a.ts', staged: false, untracked: true, committed: false, code: '?' }
    ])
  })

  it('maps a staged-only file to a single staged row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: 'M', working: ' ' }]))
    expect(rows).toEqual([
      { key: 'a.ts:s', path: 'a.ts', staged: true, untracked: false, committed: false, code: 'M' }
    ])
  })

  it('maps an unstaged-only file to a single unstaged row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: ' ', working: 'M' }]))
    expect(rows).toEqual([
      { key: 'a.ts:w', path: 'a.ts', staged: false, untracked: false, committed: false, code: 'M' }
    ])
  })

  it('splits a partially staged file into both a staged and an unstaged row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: 'A', working: 'M' }]))
    expect(rows.map(r => r.key)).toEqual(['a.ts:s', 'a.ts:w'])
    expect(rows[0].code).toBe('A')
    expect(rows[1].code).toBe('M')
  })
})

describe('buildCommittedRows', () => {
  it('returns nothing when committed changes are absent', () => {
    expect(buildCommittedRows(null)).toEqual([])
  })

  it('marks every committed file as committed and not staged', () => {
    const c: CommittedChanges = { baseBranch: 'main', files: [{ path: 'a.ts', code: 'M' }] }
    expect(buildCommittedRows(c)).toEqual([
      { key: 'a.ts:c', path: 'a.ts', staged: false, untracked: false, committed: true, code: 'M' }
    ])
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/renderer/changed-files.test.ts`

Expected: FAIL — `Failed to resolve import "../../src/renderer/components/changed-files"`.

- [ ] **Step 3: Add `DiffTarget` and `openDiff` to the store**

In `src/renderer/state/store.ts`, add above `interface State`:

```ts
// A file the diff modal can show. Renderer-only view state, so it stays out of
// @shared/ipc-types — it never crosses the IPC boundary.
export interface DiffTarget {
  key: string
  path: string
  staged: boolean
  untracked: boolean
  committed: boolean
}
```

Add to `interface State` (after `selected?: string`):

```ts
  openDiff: DiffTarget | null
  setOpenDiff: (t: DiffTarget | null) => void
```

Change the store's initial state line from:

```ts
  repos: [], worktrees: [], statuses: {},
```

to:

```ts
  repos: [], worktrees: [], statuses: {}, openDiff: null,
  setOpenDiff: (t) => set({ openDiff: t }),
```

- [ ] **Step 4: Write the minimal implementation**

Create `src/renderer/components/changed-files.ts`:

```ts
import { useEffect, useMemo, useState } from 'react'
import type { CommittedChanges, WorktreeStatus } from '@shared/ipc-types'
import { useStore, type DiffTarget } from '../state/store'

export interface Row extends DiffTarget {
  code: string // status letter: M A D R ? etc.
}

// Build the file list cheaply from `git status` — no diffs computed here. A file
// staged and then modified again yields two rows, one per side of the split.
export function buildWorkingRows(status?: WorktreeStatus): Row[] {
  if (!status) return []
  const out: Row[] = []
  for (const f of status.files) {
    const untracked = f.index === '?' && f.working === '?'
    if (untracked) {
      out.push({ key: f.path + ':u', path: f.path, staged: false, untracked: true, committed: false, code: '?' })
      continue
    }
    if (f.index !== ' ' && f.index !== '?') {
      out.push({ key: f.path + ':s', path: f.path, staged: true, untracked: false, committed: false, code: f.index })
    }
    if (f.working !== ' ' && f.working !== '?') {
      out.push({ key: f.path + ':w', path: f.path, staged: false, untracked: false, committed: false, code: f.working })
    }
  }
  return out
}

export function buildCommittedRows(committed: CommittedChanges | null): Row[] {
  return (committed?.files ?? []).map(f => ({
    key: f.path + ':c', path: f.path, staged: false, untracked: false, committed: true, code: f.code
  }))
}

// Shared by DiffPanel and DiffModal so the two lists can never drift apart.
export function useChangedFiles(selected?: string) {
  const refreshStatus = useStore(s => s.refreshStatus)
  const status = useStore(s => (selected ? s.statuses[selected] : undefined))
  const [committed, setCommitted] = useState<CommittedChanges | null>(null)

  useEffect(() => {
    if (!selected) return
    setCommitted(null)
    refreshStatus(selected)
  }, [selected])

  // Refetch alongside every status change: a commit empties the working tree but
  // grows the committed list, so the list would otherwise just go blank.
  useEffect(() => {
    if (!selected) return
    let cancelled = false
    window.api.getCommittedFiles(selected).then(c => { if (!cancelled) setCommitted(c) })
    return () => { cancelled = true }
  }, [selected, status])

  const rows = useMemo(() => buildWorkingRows(status), [status])
  const committedRows = useMemo(() => buildCommittedRows(committed), [committed])

  return {
    stagedRows: useMemo(() => rows.filter(r => r.staged), [rows]),
    unstagedRows: useMemo(() => rows.filter(r => !r.staged), [rows]),
    committedRows,
    committed,
    // Committed files aren't pending work — they must not inflate these counts.
    stagedCount: rows.filter(r => r.staged).length,
    total: rows.length
  }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/changed-files.test.ts`

Expected: PASS — 7 tests.

- [ ] **Step 6: Verify the whole suite and types are still green**

Run: `npm test && npx tsc --noEmit`

Expected: all existing `tests/git/*`, `tests/config`, `tests/watcher`,
`tests/pty-daemon/*` tests still pass. `tsc` clean. `DiffPanel` still compiles —
it has its own copy of this logic until Task 4.

- [ ] **Step 7: Commit**

```bash
git add tests/renderer/changed-files.test.ts src/renderer/components/changed-files.ts src/renderer/state/store.ts
git commit -m "Extract changed-file row derivation into a shared, tested module"
```

---

### Task 2: The diff modal

**Files:**
- Create: `src/renderer/components/DiffModal.tsx`
- Modify: `src/renderer/components/diff-theme.css:1-9`
- Modify: `src/renderer/App.tsx:1-8` (import), `src/renderer/App.tsx:92` (render)

**Interfaces:**
- Consumes: `useChangedFiles`, `Row` from `./changed-files`; `useStore`, `DiffTarget` from `../state/store` (Task 1).
- Produces: `DiffModal` — a zero-prop component. It reads `openDiff` from the store and returns `null` when closed, so `App.tsx` renders it unconditionally.

**Two behaviors worth understanding before writing the code:**

1. **Staging must not close the modal.** Staging flips a row's key suffix
   (`a.ts:w` → `a.ts:s`), so the open target's key stops existing. `stageRow` must
   re-point `openDiff` at the new key itself rather than letting the
   disappeared-file rule fire.
2. **The disappeared-file rule** (spec: "the open file disappears from the file
   list") covers the genuine cases — a commit, an external checkout, a revert. It
   must not fire while the list is still loading, hence the `allRows.length` guard.

- [ ] **Step 1: Widen the diff theme for the modal**

`diff-theme.css` was sized for a 460px column. Replace lines 1-9:

```css
/* Dark, compact theme for react-diff-view inside the narrow changes panel. */
.diff {
  font-family: Menlo, monospace;
  font-size: 11.5px;
  background: #1e1e1e;
  color: #d4d4d4;
  border-collapse: collapse;
  width: 100%;
}
```

with:

```css
/* Dark theme for react-diff-view. Sized for the full-screen diff modal; the
   changes panel no longer renders diffs. */
.diff {
  font-family: Menlo, monospace;
  font-size: 12.5px;
  line-height: 1.5;
  background: #1e1e1e;
  color: #d4d4d4;
  border-collapse: collapse;
  width: 100%;
}
```

Then, so long lines scroll rather than wrap into unreadable ragged blocks at full
width, replace line 19:

```css
.diff-code { padding: 0 8px; white-space: pre-wrap; word-break: break-all; }
```

with:

```css
.diff-code { padding: 0 8px; white-space: pre; }
```

- [ ] **Step 2: Write the modal**

Create `src/renderer/components/DiffModal.tsx`:

```tsx
import { useEffect, useMemo, useState } from 'react'
import { parseDiff, Diff, Hunk } from 'react-diff-view'
import 'react-diff-view/style/index.css'
import './diff-theme.css'
import { useStore } from '../state/store'
import { useChangedFiles, type Row } from './changed-files'

type ViewType = 'unified' | 'split'
type SectionId = 'staged' | 'unstaged' | 'committed'

const VIEW_KEY = 'wtm.diffView'

const codeColor = (c: string) =>
  c === 'A' || c === '?' ? '#6a9955' : c === 'D' ? '#c94a4a' : '#c9a26a'

export function DiffModal() {
  const selected = useStore(s => s.selected)
  const openDiff = useStore(s => s.openDiff)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const refreshStatus = useStore(s => s.refreshStatus)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed } = useChangedFiles(selected)
  const [patches, setPatches] = useState<Record<string, string>>({})
  // Side-by-side by default: the modal is wide enough for it. Last choice wins after that.
  const [view, setView] = useState<ViewType>(() =>
    localStorage.getItem(VIEW_KEY) === 'unified' ? 'unified' : 'split')

  const setViewPref = (v: ViewType) => { setView(v); localStorage.setItem(VIEW_KEY, v) }

  const allRows = useMemo(
    () => [...stagedRows, ...unstagedRows, ...committedRows],
    [stagedRows, unstagedRows, committedRows])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpenDiff(null) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [setOpenDiff])

  // The open file vanished (committed, reverted, checked out elsewhere) — close
  // rather than show a stale diff. The length guard keeps this from firing while
  // the list is still loading. Staging is handled in stageRow, not here.
  useEffect(() => {
    if (!openDiff || allRows.length === 0) return
    if (!allRows.some(r => r.key === openDiff.key)) setOpenDiff(null)
  }, [allRows, openDiff, setOpenDiff])

  // Fetch the open file's patch. Cached by row key; cleared on stage.
  useEffect(() => {
    if (!selected || !openDiff || patches[openDiff.key] !== undefined) return
    let cancelled = false
    window.api.getFileDiff({
      worktreePath: selected,
      path: openDiff.path,
      staged: openDiff.staged,
      untracked: openDiff.untracked,
      baseRef: openDiff.committed ? committed?.baseBranch : undefined
    }).then(p => { if (!cancelled) setPatches(m => ({ ...m, [openDiff.key]: p })) })
    return () => { cancelled = true }
  }, [selected, openDiff, patches, committed])

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    // Patch content for the old staged/unstaged split is now stale; drop cache.
    setPatches({})
    // Staging flips the row's key suffix. Follow the file to its new side so the
    // modal stays open on what the user is reading.
    if (openDiff?.key === row.key) {
      const staged = !row.staged
      setOpenDiff({ ...row, staged, untracked: false, key: row.path + (staged ? ':s' : ':w') })
    }
    await refreshStatus(selected)
  }

  if (!openDiff) return null

  const patch = patches[openDiff.key]
  let parsed: any[] = []
  if (patch) { try { parsed = parseDiff(patch, { nearbySequences: 'zip' }) } catch { parsed = [] } }

  const renderRailRow = (row: Row) => {
    const active = row.key === openDiff.key
    return (
      <div key={row.key} onClick={() => setOpenDiff(row)}
           style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                    cursor: 'pointer', fontSize: 12,
                    background: active ? '#37373d' : 'transparent',
                    color: active ? '#fff' : '#d4d4d4' }}>
        <span style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                       direction: 'rtl', textAlign: 'left' }} title={row.path}>{row.path}</span>
        {/* Staging an already-committed file is meaningless. */}
        {!row.committed && (
          <button onClick={e => { e.stopPropagation(); stageRow(row) }}
                  title={row.staged ? 'Unstage' : 'Stage'}
                  style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                           fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                  onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                  onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
            {row.staged ? '−' : '+'}
          </button>
        )}
      </div>
    )
  }

  const renderRailSection = (id: SectionId, label: string, rows: Row[]) => {
    if (rows.length === 0) return null
    return (
      <div key={id}>
        <div style={{ padding: '5px 10px', position: 'sticky', top: 0, zIndex: 1,
                      borderTop: '1px solid #333', borderBottom: '1px solid #2a2a2a',
                      background: '#2d2d2d', fontSize: 11, fontWeight: 600, letterSpacing: 0.5,
                      textTransform: 'uppercase', color: '#bbb', display: 'flex', gap: 6 }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <span style={{ color: '#888', fontWeight: 400 }}>{rows.length}</span>
        </div>
        {rows.map(renderRailRow)}
      </div>
    )
  }

  const viewBtn = (v: ViewType, label: string) => (
    <button onClick={() => setViewPref(v)}
            style={{ background: view === v ? '#0e639c' : 'transparent', color: view === v ? '#fff' : '#bbb',
                     border: 'none', borderRadius: 3, padding: '3px 10px', cursor: 'pointer', fontSize: 12 }}>
      {label}
    </button>
  )

  const activeRow = allRows.find(r => r.key === openDiff.key)

  return (
    <div onClick={() => setOpenDiff(null)}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                  display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#d4d4d4', fontFamily: 'system-ui',
                    border: '1px solid #444', borderRadius: 6, boxShadow: '0 8px 30px rgba(0,0,0,0.5)',
                    width: 'calc(100vw - 60px)', height: 'calc(100vh - 60px)',
                    display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>

        <div style={{ padding: '8px 12px', borderBottom: '1px solid #333', display: 'flex',
                      alignItems: 'center', gap: 10, fontSize: 13 }}>
          <span style={{ fontWeight: 600 }}>Changes {branch ? `· ${branch}` : ''}</span>
          <span style={{ flex: 1 }} />
          <div style={{ display: 'flex', gap: 2, background: '#252526', borderRadius: 4, padding: 2 }}>
            {viewBtn('unified', 'Inline')}
            {viewBtn('split', 'Side by side')}
          </div>
          <button onClick={() => setOpenDiff(null)} title="Close (Esc)"
                  style={{ background: 'none', border: 'none', color: '#ddd', cursor: 'pointer',
                           fontSize: 16, lineHeight: 1, padding: '0 4px' }}>✕</button>
        </div>

        <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
          <div style={{ width: 260, borderRight: '1px solid #333', overflowY: 'auto', flexShrink: 0 }}>
            {renderRailSection('staged', 'Staged', stagedRows)}
            {renderRailSection('unstaged', 'Unstaged', unstagedRows)}
            {renderRailSection('committed', `Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
          </div>

          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column' }}>
            <div style={{ padding: '6px 12px', borderBottom: '1px solid #333', fontSize: 12,
                          display: 'flex', alignItems: 'center', gap: 8, background: '#252526' }}>
              <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                             whiteSpace: 'nowrap' }} title={openDiff.path}>{openDiff.path}</span>
              {activeRow && !activeRow.committed && (
                <button onClick={() => stageRow(activeRow)}
                        style={{ background: '#3a3a3a', color: '#ddd', border: '1px solid #4a4a4a',
                                 borderRadius: 4, padding: '2px 10px', cursor: 'pointer', fontSize: 11 }}>
                  {activeRow.staged ? 'Unstage' : 'Stage'}
                </button>
              )}
            </div>
            <div style={{ flex: 1, overflow: 'auto', background: '#1e1e1e' }}>
              {patch === undefined && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Loading…</div>}
              {patch !== undefined && parsed.length === 0 &&
                <div style={{ padding: 12, color: '#888', fontSize: 12 }}>No textual diff (binary or empty).</div>}
              {parsed.map((d: any, di: number) => (
                <Diff key={di} viewType={view} diffType={d.type} hunks={d.hunks}>
                  {(hunks: any[]) => hunks.map((h, hi) => <Hunk key={hi} hunk={h} />)}
                </Diff>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Render it from App**

In `src/renderer/App.tsx`, add after the `DiffPanel` import (line 5):

```tsx
import { DiffModal } from './components/DiffModal'
```

And add before the closing `</div>` of the root element, after the `NewWorktreeModal`
line (line 92):

```tsx
      <DiffModal />
```

`DiffModal` returns `null` when `openDiff` is `null`, so it needs no conditional here.

- [ ] **Step 4: Verify types compile**

Run: `npx tsc --noEmit`

Expected: clean. No output.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/DiffModal.tsx src/renderer/components/diff-theme.css src/renderer/App.tsx
git commit -m "Add a full-app diff modal with a file rail and inline/side-by-side toggle"
```

At this point the modal exists but nothing opens it — `openDiff` is never set. Task 3
wires the panel to it. Do not manually verify yet.

---

### Task 3: Reduce the panel to a launcher

**Files:**
- Modify: `src/renderer/components/DiffPanel.tsx` (substantial removal + rewrite)

**Interfaces:**
- Consumes: `useChangedFiles` from `./changed-files`; `setOpenDiff` from the store (Task 1). Opens the modal built in Task 2.
- Produces: nothing new. `DiffPanel`'s props are unchanged: `{ collapsed: boolean; onToggle: () => void; width?: number }`.

**Removed:** the `expanded` Set, `patches` state, `fetchPatch`, `toggle`, the
`parseDiff`/`Diff`/`Hunk` imports, both `react-diff-view` CSS imports, the local
`Row` interface, the row-derivation `useMemo`s, the `committed` state and
`refreshCommitted`, the expand caret, and the inline diff block in `renderRow`.

**Kept:** section open/closed state, the commit box, the collapsed rail, header counts.

- [ ] **Step 1: Replace the file wholesale**

The removals are extensive enough that editing piecemeal invites leftovers. Replace
the entire contents of `src/renderer/components/DiffPanel.tsx` with:

```tsx
import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { useChangedFiles, type Row } from './changed-files'

type SectionId = 'staged' | 'unstaged' | 'committed'

const codeColor = (c: string) =>
  c === 'A' || c === '?' ? '#6a9955' : c === 'D' ? '#c94a4a' : '#c9a26a'

// Diffs are not rendered here — clicking a row opens DiffModal. This panel is the
// file list, the staging surface, and the commit box.
export function DiffPanel({ collapsed, onToggle, width = 460 }:
  { collapsed: boolean; onToggle: () => void; width?: number }) {
  const selected = useStore(s => s.selected)
  const refreshStatus = useStore(s => s.refreshStatus)
  const setOpenDiff = useStore(s => s.setOpenDiff)
  const worktrees = useStore(s => s.worktrees)
  const branch = worktrees.find(w => w.path === selected)?.branch

  const { stagedRows, unstagedRows, committedRows, committed, stagedCount, total } =
    useChangedFiles(selected)

  const [msg, setMsg] = useState('')
  const [committing, setCommitting] = useState(false)
  // Working changes are the panel's job, so they start open; committed files are
  // reference material and start collapsed.
  const [openSections, setOpenSections] = useState<Record<SectionId, boolean>>(
    { staged: true, unstaged: true, committed: false })

  useEffect(() => {
    setOpenSections({ staged: true, unstaged: true, committed: false })
  }, [selected])

  const stageRow = async (row: Row) => {
    if (!selected) return
    await window.api.stagePath({ worktreePath: selected, path: row.path, unstage: row.staged })
    await refreshStatus(selected)
  }

  const doCommit = async () => {
    if (!selected || !msg.trim()) return
    setCommitting(true)
    try {
      await window.api.commit({ worktreePath: selected, message: msg.trim() })
      setMsg('')
      await refreshStatus(selected)
    } finally { setCommitting(false) }
  }

  const renderRow = (row: Row) => (
    <div key={row.key} onClick={() => setOpenDiff(row)} title={row.path}
         style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px',
                  borderBottom: '1px solid #2a2a2a', background: 'rgba(37, 37, 38, 0.5)',
                  fontSize: 12, cursor: 'pointer' }}>
      <span title={row.committed ? 'committed' : row.staged ? 'staged' : 'unstaged'}
            style={{ color: codeColor(row.code), width: 12, textAlign: 'center' }}>{row.code}</span>
      <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                     direction: 'rtl', textAlign: 'left' }}>{row.path}</span>
      {/* Staging an already-committed file is meaningless. */}
      {!row.committed && (
        <button onClick={e => { e.stopPropagation(); stageRow(row) }}
                title={row.staged ? 'Unstage' : 'Stage'}
                style={{ background: 'none', border: 'none', color: '#999', cursor: 'pointer',
                         fontSize: 15, lineHeight: 1, padding: '0 2px', width: 18 }}
                onMouseEnter={e => (e.currentTarget.style.color = '#fff')}
                onMouseLeave={e => (e.currentTarget.style.color = '#999')}>
          {row.staged ? '−' : '+'}
        </button>
      )}
    </div>
  )

  const renderSection = (id: SectionId, label: string, sectionRows: Row[]) => {
    if (sectionRows.length === 0) return null
    const open = openSections[id]
    return (
      <>
        <div onClick={() => setOpenSections(s => ({ ...s, [id]: !s[id] }))}
             style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '5px 10px', cursor: 'pointer',
                      position: 'sticky', top: 0, zIndex: 1,
                      borderTop: '1px solid #333', borderBottom: '1px solid #2a2a2a',
                      background: '#2d2d2d', fontSize: 11, fontWeight: 600,
                      letterSpacing: 0.5, textTransform: 'uppercase', color: '#bbb' }}>
          <span style={{ width: 12, color: '#888' }}>{open ? '▾' : '▸'}</span>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
          <span style={{ color: '#888', fontWeight: 400 }}>{sectionRows.length}</span>
        </div>
        {open && sectionRows.map(renderRow)}
      </>
    )
  }

  if (collapsed) {
    return (
      <div onClick={onToggle} title="Show changes"
           style={{ width: 34, borderLeft: '1px solid #333', background: 'rgba(30, 30, 30, 0.55)', color: '#ddd',
                    cursor: 'pointer', display: 'flex', flexDirection: 'column', alignItems: 'center',
                    paddingTop: 10, gap: 8, flexShrink: 0, fontFamily: 'system-ui' }}>
        <span style={{ fontSize: 14 }}>‹</span>
        <span style={{ writingMode: 'vertical-rl', fontSize: 12, letterSpacing: 1 }}>
          CHANGES{total ? ` (${total})` : ''}
        </span>
      </div>
    )
  }

  return (
    <div style={{ width, borderLeft: '1px solid #333', background: 'rgba(30, 30, 30, 0.55)', color: '#d4d4d4',
                  display: 'flex', flexDirection: 'column', flexShrink: 0, fontFamily: 'system-ui' }}>
      <div style={{ padding: '6px 10px', borderBottom: '1px solid #333', display: 'flex',
                    alignItems: 'center', gap: 8, fontSize: 12 }}>
        <button onClick={onToggle} title="Collapse" style={{ background: 'none', border: 'none',
                color: '#ddd', cursor: 'pointer', fontSize: 14 }}>›</button>
        <span style={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          Changes {branch ? `· ${branch}` : ''}
        </span>
        <span style={{ color: '#888' }}>{stagedCount}/{total} staged</span>
      </div>

      <div style={{ flex: 1, overflowY: 'auto' }}>
        {!selected && <div style={{ padding: 12, color: '#888', fontSize: 12 }}>Select a worktree.</div>}
        {selected && total === 0 && (
          <div style={{ padding: 12, color: '#888', fontSize: 12 }}>
            {committedRows.length ? 'No working changes.' : 'No changes.'}
          </div>
        )}
        {renderSection('staged', 'Staged', stagedRows)}
        {renderSection('unstaged', 'Unstaged', unstagedRows)}
        {renderSection('committed', `Committed vs ${committed?.baseBranch ?? ''}`, committedRows)}
      </div>

      <div style={{ borderTop: '1px solid #333', padding: 8, display: 'flex', flexDirection: 'column', gap: 6 }}>
        <textarea placeholder="Commit message" value={msg} onChange={e => setMsg(e.target.value)}
                  rows={2} style={{ resize: 'none', background: '#2d2d2d', color: '#ddd',
                  border: '1px solid #444', borderRadius: 4, padding: 6, fontFamily: 'system-ui', fontSize: 12 }} />
        <button onClick={doCommit} disabled={committing || !msg.trim() || stagedCount === 0}
                style={{ background: stagedCount && msg.trim() ? '#0e639c' : '#3a3a3a', color: '#fff',
                         border: 'none', borderRadius: 4, padding: '6px', cursor: 'pointer', fontSize: 12 }}>
          {committing ? 'Committing…' : `Commit ${stagedCount} file${stagedCount === 1 ? '' : 's'}`}
        </button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Confirm no inline-diff remnants survive**

Run: `grep -n "react-diff-view\|parseDiff\|expanded\|fetchPatch" src/renderer/components/DiffPanel.tsx`

Expected: no output (exit code 1). Any hit means a leftover — remove it.

- [ ] **Step 3: Verify types and the suite**

Run: `npx tsc --noEmit && npm test`

Expected: `tsc` clean; all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/components/DiffPanel.tsx
git commit -m "Reduce the changes panel to a launcher for the diff modal"
```

---

### Task 4: Manual verification

The spec's Testing section, executed against the running app. No renderer test
harness exists, so this is the real gate on the feature.

**Files:** none modified unless a check fails.

- [ ] **Step 1: Launch the app**

Run: `npm run dev`

Expected: the app opens with the sidebar, terminal, and changes panel. Select a
worktree that has staged, unstaged, and committed changes. If you lack one, create
changes in a test worktree: edit a file (unstaged), edit and `git add` another
(staged), and commit a third on a branch off the trunk (committed).

- [ ] **Step 2: Walk the spec's checks**

Confirm each, and note any that fail:

1. Click a file in **each** of Staged, Unstaged, and Committed → the modal opens on that file, showing its diff.
2. The panel no longer expands a diff inline anywhere — clicking a row only opens the modal.
3. Toggle Inline / Side by side → the same diff re-renders in both modes.
4. Close and reopen the modal → the toggle choice held.
5. Quit and `npm run dev` again → the toggle choice still held.
6. Click through rail files → diffs swap in place, modal stays open.
7. Stage a file from the modal's rail button → it moves from Unstaged to Staged in the rail **and** in the panel behind it, and **the modal stays open on that file**.
8. Stage from the diff header's Stage/Unstage button → same result.
9. Commit the staged files from the panel while the modal is closed → files move to the Committed section.
10. Escape, backdrop click, and ✕ each close the modal.
11. Click a binary or empty-diff file if one exists → "No textual diff (binary or empty)."

- [ ] **Step 3: Report before fixing**

If every check passes, say so and stop — the feature is done.

If any check fails, report which one and what happened **before** changing code. Do
not claim completion on a partial pass. Fix, re-run the failed check plus
`npx tsc --noEmit && npm test`, then commit the fix separately.

---

## Notes for the implementer

- **Do not add jsdom, @testing-library/react, or any renderer test harness.** Out of scope; see Global Constraints.
- **Do not touch `src/main/` or `src/shared/`.** If you believe you need an IPC change, stop and ask — the spec asserts none is needed.
- `git.ts` / `status.ts` / `committed.ts` tests should never go red. If they do, something unintended changed.
- The `direction: 'rtl'` on path spans is deliberate: it ellipsizes long paths from the left so the filename stays visible.
