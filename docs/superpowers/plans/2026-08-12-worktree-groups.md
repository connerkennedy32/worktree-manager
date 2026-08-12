# Worktree Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the user organize the worktree sidebar into named, drag-and-drop groups spanning repos, and hide worktrees into a collapsed section at the bottom.

**Architecture:** All layout logic lives in one pure, React-free module (`src/renderer/components/sidebar-layout.ts`) that derives rendered sections from `{layout, worktrees, repos}` and returns new `Layout` values from mutations. `Sidebar.tsx` renders those sections and calls those mutations; the zustand store holds `layout` and mirrors every change to `userData/layout.json` through IPC. Drag-and-drop uses native HTML5 DnD — no new dependency.

**Tech Stack:** Electron 31, React 18, zustand 4, TypeScript 5, vitest 2. Native HTML5 drag-and-drop (Chromium only, so no cross-browser concerns).

## Global Constraints

- **No new runtime dependencies.** Native HTML5 DnD only — do not add `@dnd-kit/*` or similar.
- **A worktree path appears in at most one place:** one group, or `hidden`, or neither (neither = renders under its repo section).
- **Layout is cosmetic and must fail soft.** Corrupt or unreadable `layout.json` yields an empty layout; a failed write logs and leaves in-memory state alone.
- **Persist in `userData`, not `localStorage`** — same reasoning as `names.json` (survives a renderer storage clear). Config path comes from `configDir()` in `src/main/config.ts`, which honors `WTM_CONFIG_DIR` in tests.
- **Groups never nest.** No multi-select drag, no per-group colors, no cross-machine sync.
- **Repo sections are not manually sortable** and repo section order stays `repos.json` order.
- Test command: `npx vitest run <file>` for one file, `npm run test:fast` for everything except the slow git suite.
- Code style: 2-space indent, no semicolons, single quotes, comments explain *why* (match surrounding files).

---

### Task 1: Layout types and persistence

**Files:**
- Modify: `src/shared/ipc-types.ts` (add types near the other config-shaped interfaces, e.g. after `Worktree`)
- Modify: `src/main/config.ts` (add after `setName`, around line 48)
- Test: `tests/main/layout-config.test.ts` (create)

**Interfaces:**
- Consumes: `configDir()` from `src/main/config.ts`.
- Produces: `WorktreeGroup`, `Layout`, `emptyLayout()` in `@shared/ipc-types`; `readLayout(): Promise<Layout>` and `writeLayout(l: Layout): Promise<Layout>` in `src/main/config.ts`.

- [ ] **Step 1: Add the shared types**

In `src/shared/ipc-types.ts`, after the `Worktree` interface:

```ts
// Sidebar organization: user-made groups, plus the paths tucked into the Hidden
// section. Persisted in userData/layout.json (like names.json) so it survives a
// renderer storage clear. A path appears in at most one group or in `hidden`;
// anything absent from both renders under its repo section.
export interface WorktreeGroup {
  id: string
  name: string
  collapsed: boolean
  paths: string[]
}

export interface Layout {
  groups: WorktreeGroup[]
  hidden: string[]
  hiddenCollapsed: boolean
}

export const emptyLayout = (): Layout => ({ groups: [], hidden: [], hiddenCollapsed: true })
```

- [ ] **Step 2: Write the failing tests**

Create `tests/main/layout-config.test.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Layout } from '../../src/shared/ipc-types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wtm-cfg-')); process.env.WTM_CONFIG_DIR = dir })

const sample = (): Layout => ({
  groups: [{ id: 'g1', name: 'Active', collapsed: false, paths: ['/a', '/b'] }],
  hidden: ['/c'],
  hiddenCollapsed: true
})

describe('layout config', () => {
  it('returns an empty layout when the file does not exist', async () => {
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true })
  })

  it('round-trips a layout', async () => {
    const { readLayout, writeLayout } = await import('../../src/main/config')
    expect(await writeLayout(sample())).toEqual(sample())
    expect(await readLayout()).toEqual(sample())
  })

  it('returns an empty layout when the file is corrupt', async () => {
    writeFileSync(join(dir, 'layout.json'), '{not json')
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true })
  })

  it('fills in missing fields rather than returning undefined ones', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ groups: [] }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true })
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run tests/main/layout-config.test.ts`
Expected: FAIL — `readLayout` / `writeLayout` are not exported from `src/main/config`.

- [ ] **Step 4: Implement persistence**

In `src/main/config.ts`, add near the other file-path helpers (line 15):

```ts
function layoutFile(): string { return join(configDir(), 'layout.json') }
```

And after `setName` (line 48):

```ts
// Sidebar groups / hidden worktrees. Cosmetic, so a missing or corrupt file
// degrades to "no groups" rather than throwing — the sidebar then just renders
// its repo sections, which is exactly the pre-groups behavior.
export async function readLayout(): Promise<Layout> {
  const f = layoutFile()
  if (!existsSync(f)) return emptyLayout()
  try {
    const parsed = JSON.parse(readFileSync(f, 'utf8'))
    return {
      groups: Array.isArray(parsed?.groups) ? parsed.groups : [],
      hidden: Array.isArray(parsed?.hidden) ? parsed.hidden : [],
      hiddenCollapsed: parsed?.hiddenCollapsed !== false
    }
  } catch { return emptyLayout() }
}

export async function writeLayout(layout: Layout): Promise<Layout> {
  const dir = configDir(); if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(layoutFile(), `${JSON.stringify(layout, null, 2)}\n`)
  return layout
}
```

Extend the existing type import at the top of the file:

```ts
import { emptyLayout, type Layout, type RepoCommandEntry } from '@shared/ipc-types'
```

(`RepoCommandEntry` is already imported as a type there — merge, don't duplicate the import. `emptyLayout` is a value, so it must be a plain import, not `import type`.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run tests/main/layout-config.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add src/shared/ipc-types.ts src/main/config.ts tests/main/layout-config.test.ts
git commit -m "feat: persist sidebar layout in userData/layout.json"
```

---

### Task 2: IPC wiring for layout

**Files:**
- Modify: `src/shared/ipc-types.ts` (`Api` interface ~line 136, `IPC` const ~line 226)
- Modify: `src/main/ipc.ts` (near line 83, beside the names handlers)
- Modify: `src/preload/index.ts` (near line 11, beside `setName`)

**Interfaces:**
- Consumes: `readLayout` / `writeLayout` from Task 1; `Layout` from `@shared/ipc-types`.
- Produces: `window.api.getLayout(): Promise<Layout>` and `window.api.setLayout(layout: Layout): Promise<Layout>`.

- [ ] **Step 1: Add the Api methods**

In `src/shared/ipc-types.ts`, inside `interface Api`, right after `setName`:

```ts
  // Sidebar groups / hidden worktrees. setLayout replaces the whole document and
  // echoes back what was stored, matching setName's shape.
  getLayout(): Promise<Layout>
  setLayout(layout: Layout): Promise<Layout>
```

And in the `IPC` const, on the line after `listNames`/`setName`:

```ts
  getLayout: 'layout:get', setLayout: 'layout:set',
```

- [ ] **Step 2: Add the main-process handlers**

In `src/main/ipc.ts`, directly after the `IPC.setName` handler (line 84):

```ts
  ipcMain.handle(IPC.getLayout, () => config.readLayout())
  ipcMain.handle(IPC.setLayout, (_e, layout: Layout) => config.writeLayout(layout))
```

Add `Layout` to the existing `@shared/ipc-types` type import at the top of `ipc.ts`.

- [ ] **Step 3: Add the preload bridge**

In `src/preload/index.ts`, after the `setName` line:

```ts
  getLayout: () => ipcRenderer.invoke(IPC.getLayout),
  setLayout: (layout) => ipcRenderer.invoke(IPC.setLayout, layout),
```

- [ ] **Step 4: Verify it typechecks**

Run: `npx tsc --noEmit`
Expected: no errors. (`const api: Api` in the preload is the real check here — a missing or misspelled bridge method fails compilation.)

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc-types.ts src/main/ipc.ts src/preload/index.ts
git commit -m "feat: expose layout get/set over IPC"
```

---

### Task 3: Pure section derivation

**Files:**
- Create: `src/renderer/components/sidebar-layout.ts`
- Test: `tests/renderer/sidebar-layout.test.ts` (create)

**Interfaces:**
- Consumes: `Layout`, `WorktreeGroup`, `Worktree` from `@shared/ipc-types`.
- Produces:
  - `type Section = { kind: 'group'; id: string; name: string; collapsed: boolean; worktrees: Worktree[] } | { kind: 'repo'; repo: string; name: string; worktrees: Worktree[] } | { kind: 'hidden'; collapsed: boolean; worktrees: Worktree[] }`
  - `deriveSections(layout: Layout, worktrees: Worktree[], repos: string[]): Section[]`
  - `navOrder(sections: Section[]): string[]`
  - `repoLabel(repo: string): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer/sidebar-layout.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Layout, Worktree } from '../../src/shared/ipc-types'
import { deriveSections, navOrder } from '../../src/renderer/components/sidebar-layout'

const wt = (path: string, repoName: string): Worktree =>
  ({ path, branch: path.slice(1), head: 'abc1234', isMain: false, repoName })

const worktrees = [wt('/r1/a', 'r1'), wt('/r1/b', 'r1'), wt('/r2/c', 'r2')]
const repos = ['/code/r1', '/code/r2']
const layout = (over: Partial<Layout> = {}): Layout =>
  ({ groups: [], hidden: [], hiddenCollapsed: true, ...over })

const paths = (s: any) => s.worktrees.map((w: Worktree) => w.path)

describe('deriveSections', () => {
  it('renders repo sections then hidden when there are no groups', () => {
    const s = deriveSections(layout(), worktrees, repos)
    expect(s.map(x => x.kind)).toEqual(['repo', 'repo', 'hidden'])
    expect(paths(s[0])).toEqual(['/r1/a', '/r1/b'])
    expect(paths(s[1])).toEqual(['/r2/c'])
    expect(paths(s[2])).toEqual([])
  })

  it('puts groups above repo sections, in layout order', () => {
    const s = deriveSections(layout({
      groups: [
        { id: 'g1', name: 'Active', collapsed: false, paths: ['/r2/c', '/r1/a'] },
        { id: 'g2', name: 'Later', collapsed: true, paths: [] }
      ]
    }), worktrees, repos)
    expect(s.map(x => x.kind)).toEqual(['group', 'group', 'repo', 'repo', 'hidden'])
    // Group order follows the group's own paths array, not git order.
    expect(paths(s[0])).toEqual(['/r2/c', '/r1/a'])
    // A grouped worktree leaves its repo section.
    expect(paths(s[2])).toEqual(['/r1/b'])
    expect(paths(s[3])).toEqual([])
  })

  it('renders hidden worktrees only in the hidden section', () => {
    const s = deriveSections(layout({ hidden: ['/r1/b'] }), worktrees, repos)
    expect(paths(s[0])).toEqual(['/r1/a'])
    expect(paths(s[2])).toEqual(['/r1/b'])
  })

  it('ignores paths whose worktrees no longer exist', () => {
    const s = deriveSections(layout({
      groups: [{ id: 'g1', name: 'Active', collapsed: false, paths: ['/gone', '/r1/a'] }],
      hidden: ['/also-gone']
    }), worktrees, repos)
    expect(paths(s[0])).toEqual(['/r1/a'])
    expect(paths(s[3])).toEqual([])
  })

  it('renders a path listed twice only once, in its first group', () => {
    const s = deriveSections(layout({
      groups: [
        { id: 'g1', name: 'One', collapsed: false, paths: ['/r1/a'] },
        { id: 'g2', name: 'Two', collapsed: false, paths: ['/r1/a'] }
      ]
    }), worktrees, repos)
    expect(paths(s[0])).toEqual(['/r1/a'])
    expect(paths(s[1])).toEqual([])
  })

  it('carries group name and collapsed state through', () => {
    const s = deriveSections(layout({
      groups: [{ id: 'g1', name: 'Active', collapsed: true, paths: [] }]
    }), worktrees, repos)
    expect(s[0]).toMatchObject({ kind: 'group', id: 'g1', name: 'Active', collapsed: true })
  })

  it('labels repo sections with the repo directory name', () => {
    const s = deriveSections(layout(), worktrees, repos)
    expect(s[0]).toMatchObject({ kind: 'repo', repo: '/code/r1', name: 'r1' })
  })
})

describe('navOrder', () => {
  const build = (over: Partial<Layout>) => navOrder(deriveSections(layout(over), worktrees, repos))

  it('walks sections top to bottom', () => {
    expect(build({})).toEqual(['/r1/a', '/r1/b', '/r2/c'])
  })

  it('follows group order rather than git order', () => {
    expect(build({
      groups: [{ id: 'g1', name: 'A', collapsed: false, paths: ['/r2/c', '/r1/b'] }]
    })).toEqual(['/r2/c', '/r1/b', '/r1/a'])
  })

  it('skips a collapsed group', () => {
    expect(build({
      groups: [{ id: 'g1', name: 'A', collapsed: true, paths: ['/r2/c'] }]
    })).toEqual(['/r1/a', '/r1/b'])
  })

  it('skips hidden worktrees while the hidden section is collapsed', () => {
    expect(build({ hidden: ['/r1/b'], hiddenCollapsed: true })).toEqual(['/r1/a', '/r2/c'])
  })

  it('includes hidden worktrees, last, when the hidden section is expanded', () => {
    expect(build({ hidden: ['/r1/b'], hiddenCollapsed: false }))
      .toEqual(['/r1/a', '/r2/c', '/r1/b'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/sidebar-layout.test.ts`
Expected: FAIL — cannot resolve `../../src/renderer/components/sidebar-layout`.

- [ ] **Step 3: Implement the derivation**

Create `src/renderer/components/sidebar-layout.ts`:

```ts
import type { Layout, Worktree } from '@shared/ipc-types'

// The sidebar renders a flat list of sections, top to bottom: the user's groups,
// then one section per connected repo holding everything ungrouped, then Hidden.
// Deriving this in a pure function (rather than inline in Sidebar.tsx) keeps the
// ordering rules testable and gives keyboard nav a single source of truth.
export type Section =
  | { kind: 'group'; id: string; name: string; collapsed: boolean; worktrees: Worktree[] }
  | { kind: 'repo'; repo: string; name: string; worktrees: Worktree[] }
  | { kind: 'hidden'; collapsed: boolean; worktrees: Worktree[] }

export function repoLabel(repo: string): string {
  return repo.split('/').filter(Boolean).pop() ?? repo
}

export function deriveSections(layout: Layout, worktrees: Worktree[], repos: string[]): Section[] {
  const byPath = new Map(worktrees.map(w => [w.path, w]))
  // Claimed paths are consumed as we go, which enforces the "at most one place"
  // invariant even if layout.json somehow lists a path twice: the first section
  // to claim it wins, and it never renders again.
  const claimed = new Set<string>()
  const take = (paths: string[]): Worktree[] => {
    const out: Worktree[] = []
    for (const p of paths) {
      const w = byPath.get(p)
      // A path with no worktree is skipped, not dropped from the layout: the
      // worktree may be mid-refresh, and forgetting its group would be worse.
      if (!w || claimed.has(p)) continue
      claimed.add(p)
      out.push(w)
    }
    return out
  }

  const sections: Section[] = layout.groups.map(g => ({
    kind: 'group' as const, id: g.id, name: g.name, collapsed: g.collapsed, worktrees: take(g.paths)
  }))
  const hidden = take(layout.hidden)
  for (const repo of repos) {
    const name = repoLabel(repo)
    sections.push({
      kind: 'repo', repo, name,
      worktrees: take(worktrees.filter(w => w.repoName === name).map(w => w.path))
    })
  }
  sections.push({ kind: 'hidden', collapsed: layout.hiddenCollapsed, worktrees: hidden })
  return sections
}

// Cmd+Up/Down order. A collapsed section contributes nothing, so nav matches
// what is actually on screen.
export function navOrder(sections: Section[]): string[] {
  const out: string[] = []
  for (const s of sections) {
    if (s.kind !== 'repo' && s.collapsed) continue
    out.push(...s.worktrees.map(w => w.path))
  }
  return out
}
```

Note the ordering subtlety: `hidden` is claimed *before* the repo sections are built (so a hidden worktree leaves its repo section) but the hidden Section object is pushed *last*.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/sidebar-layout.test.ts`
Expected: PASS (12 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/sidebar-layout.ts tests/renderer/sidebar-layout.test.ts
git commit -m "feat: derive sidebar sections and nav order from layout"
```

---

### Task 4: Pure layout mutations

**Files:**
- Modify: `src/renderer/components/sidebar-layout.ts`
- Test: `tests/renderer/sidebar-mutations.test.ts` (create)

**Interfaces:**
- Consumes: `Layout`, `WorktreeGroup` from `@shared/ipc-types`.
- Produces, all pure and all returning a new `Layout`:
  - `type DropTarget = { kind: 'group'; id: string } | { kind: 'repo' } | { kind: 'hidden' }`
  - `moveTo(layout: Layout, path: string, target: DropTarget, index?: number): Layout`
  - `addGroup(layout: Layout, id: string, name?: string): Layout`
  - `renameGroup(layout: Layout, id: string, name: string): Layout`
  - `deleteGroup(layout: Layout, id: string): Layout`
  - `reorderGroup(layout: Layout, id: string, index: number): Layout`
  - `toggleGroupCollapsed(layout: Layout, id: string): Layout`
  - `toggleHiddenCollapsed(layout: Layout): Layout`
  - `purgePaths(layout: Layout, paths: string[]): Layout`
  - `newGroupId(layout: Layout): string`

- [ ] **Step 1: Write the failing tests**

Create `tests/renderer/sidebar-mutations.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { Layout } from '../../src/shared/ipc-types'
import {
  addGroup, deleteGroup, moveTo, newGroupId, purgePaths, renameGroup,
  reorderGroup, toggleGroupCollapsed, toggleHiddenCollapsed
} from '../../src/renderer/components/sidebar-layout'

const base = (): Layout => ({
  groups: [
    { id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/b'] },
    { id: 'g2', name: 'Two', collapsed: false, paths: ['/c'] }
  ],
  hidden: ['/d'],
  hiddenCollapsed: true
})
const ids = (l: Layout) => l.groups.map(g => g.id)
const pathsOf = (l: Layout, id: string) => l.groups.find(g => g.id === id)!.paths

describe('moveTo', () => {
  it('inserts into a group at the given index', () => {
    const l = moveTo(base(), '/c', { kind: 'group', id: 'g1' }, 1)
    expect(pathsOf(l, 'g1')).toEqual(['/a', '/c', '/b'])
    expect(pathsOf(l, 'g2')).toEqual([])
  })

  it('appends when no index is given', () => {
    expect(pathsOf(moveTo(base(), '/c', { kind: 'group', id: 'g1' }), 'g1'))
      .toEqual(['/a', '/b', '/c'])
  })

  it('reorders within the same group', () => {
    expect(pathsOf(moveTo(base(), '/b', { kind: 'group', id: 'g1' }, 0), 'g1'))
      .toEqual(['/b', '/a'])
  })

  it('moving to a repo target removes the path from every group and from hidden', () => {
    const l = moveTo(base(), '/a', { kind: 'repo' })
    expect(pathsOf(l, 'g1')).toEqual(['/b'])
    expect(l.hidden).toEqual(['/d'])
    const h = moveTo(base(), '/d', { kind: 'repo' })
    expect(h.hidden).toEqual([])
  })

  it('moves into hidden at the given index', () => {
    const l = moveTo(base(), '/a', { kind: 'hidden' }, 0)
    expect(l.hidden).toEqual(['/a', '/d'])
    expect(pathsOf(l, 'g1')).toEqual(['/b'])
  })

  it('moves out of hidden into a group', () => {
    const l = moveTo(base(), '/d', { kind: 'group', id: 'g2' })
    expect(l.hidden).toEqual([])
    expect(pathsOf(l, 'g2')).toEqual(['/c', '/d'])
  })

  it('never lists a path twice', () => {
    const l = moveTo(base(), '/a', { kind: 'group', id: 'g2' })
    expect([...l.groups.flatMap(g => g.paths), ...l.hidden].filter(p => p === '/a')).toHaveLength(1)
  })

  it('is a no-op for an unknown group id', () => {
    expect(moveTo(base(), '/a', { kind: 'group', id: 'nope' })).toEqual(base())
  })

  it('does not mutate the input layout', () => {
    const l = base()
    moveTo(l, '/a', { kind: 'hidden' })
    expect(l).toEqual(base())
  })
})

describe('group management', () => {
  it('appends a new empty group with a default name', () => {
    const l = addGroup(base(), 'g3')
    expect(ids(l)).toEqual(['g1', 'g2', 'g3'])
    expect(l.groups[2]).toEqual({ id: 'g3', name: 'New group', collapsed: false, paths: [] })
  })

  it('renames a group', () => {
    expect(renameGroup(base(), 'g1', '  Shipping  ').groups[0].name).toBe('Shipping')
  })

  it('keeps the old name when the new one is blank', () => {
    expect(renameGroup(base(), 'g1', '   ').groups[0].name).toBe('One')
  })

  it('deletes a group without hiding its worktrees', () => {
    const l = deleteGroup(base(), 'g1')
    expect(ids(l)).toEqual(['g2'])
    // /a and /b are now in no group, so they fall back to their repo sections.
    expect(l.groups.flatMap(g => g.paths)).toEqual(['/c'])
    expect(l.hidden).toEqual(['/d'])
  })

  it('reorders groups', () => {
    expect(ids(reorderGroup(base(), 'g2', 0))).toEqual(['g2', 'g1'])
    expect(ids(reorderGroup(base(), 'g1', 1))).toEqual(['g2', 'g1'])
  })

  it('toggles collapse state', () => {
    expect(toggleGroupCollapsed(base(), 'g1').groups[0].collapsed).toBe(true)
    expect(toggleHiddenCollapsed(base()).hiddenCollapsed).toBe(false)
  })

  it('mints ids that do not collide with existing groups', () => {
    const l = base()
    const id = newGroupId(l)
    expect(ids(l)).not.toContain(id)
    expect(ids(addGroup(l, id))).toContain(id)
  })
})

describe('purgePaths', () => {
  it('drops the given paths from groups and hidden', () => {
    const l = purgePaths(base(), ['/a', '/d'])
    expect(pathsOf(l, 'g1')).toEqual(['/b'])
    expect(l.hidden).toEqual([])
  })

  it('keeps empty groups rather than deleting them', () => {
    expect(ids(purgePaths(base(), ['/c']))).toEqual(['g1', 'g2'])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/sidebar-mutations.test.ts`
Expected: FAIL — `moveTo` and friends are not exported.

- [ ] **Step 3: Implement the mutations**

Append to `src/renderer/components/sidebar-layout.ts`:

```ts
export type DropTarget = { kind: 'group'; id: string } | { kind: 'repo' } | { kind: 'hidden' }

// Every mutation returns a new Layout and never touches its input: the store
// keeps layout in immutable state and writes the result straight to disk.
const without = (paths: string[], path: string) => paths.filter(p => p !== path)

const insert = (paths: string[], path: string, index?: number): string[] => {
  const rest = without(paths, path)
  const at = index === undefined ? rest.length : Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, at), path, ...rest.slice(at)]
}

// Detach first, then attach, so a path can never end up in two places — including
// when the source and destination are the same group (a plain reorder).
function detach(layout: Layout, path: string): Layout {
  return {
    ...layout,
    groups: layout.groups.map(g => ({ ...g, paths: without(g.paths, path) })),
    hidden: without(layout.hidden, path)
  }
}

export function moveTo(layout: Layout, path: string, target: DropTarget, index?: number): Layout {
  if (target.kind === 'group' && !layout.groups.some(g => g.id === target.id)) return layout
  // Dropping on a repo section just means "ungrouped": detaching is the whole job.
  const next = detach(layout, path)
  if (target.kind === 'repo') return next
  if (target.kind === 'hidden') return { ...next, hidden: insert(next.hidden, path, index) }
  return {
    ...next,
    groups: next.groups.map(g => g.id === target.id ? { ...g, paths: insert(g.paths, path, index) } : g)
  }
}

export function addGroup(layout: Layout, id: string, name = 'New group'): Layout {
  return { ...layout, groups: [...layout.groups, { id, name, collapsed: false, paths: [] }] }
}

// A blank name keeps the old one, so committing an empty inline edit can't leave
// an unlabeled group header on screen.
export function renameGroup(layout: Layout, id: string, name: string): Layout {
  const trimmed = name.trim()
  if (!trimmed) return layout
  return { ...layout, groups: layout.groups.map(g => g.id === id ? { ...g, name: trimmed } : g) }
}

// Deleting a group only removes the grouping: its worktrees become ungrouped and
// reappear under their repo sections.
export function deleteGroup(layout: Layout, id: string): Layout {
  return { ...layout, groups: layout.groups.filter(g => g.id !== id) }
}

export function reorderGroup(layout: Layout, id: string, index: number): Layout {
  const g = layout.groups.find(x => x.id === id)
  if (!g) return layout
  const rest = layout.groups.filter(x => x.id !== id)
  const at = Math.max(0, Math.min(index, rest.length))
  return { ...layout, groups: [...rest.slice(0, at), g, ...rest.slice(at)] }
}

export function toggleGroupCollapsed(layout: Layout, id: string): Layout {
  return { ...layout, groups: layout.groups.map(g => g.id === id ? { ...g, collapsed: !g.collapsed } : g) }
}

export function toggleHiddenCollapsed(layout: Layout): Layout {
  return { ...layout, hiddenCollapsed: !layout.hiddenCollapsed }
}

// Used when a repo is disconnected. Unlike render-time filtering, this really
// forgets the paths — the worktrees are gone from the app for good. Empty groups
// are kept: the user made them, and they're still valid drop targets.
export function purgePaths(layout: Layout, paths: string[]): Layout {
  const drop = new Set(paths)
  return {
    ...layout,
    groups: layout.groups.map(g => ({ ...g, paths: g.paths.filter(p => !drop.has(p)) })),
    hidden: layout.hidden.filter(p => !drop.has(p))
  }
}

// Sequential rather than random: predictable in tests, and there is no need for
// global uniqueness — ids only have to be distinct within one layout file.
export function newGroupId(layout: Layout): string {
  let n = layout.groups.length + 1
  const taken = new Set(layout.groups.map(g => g.id))
  while (taken.has(`g${n}`)) n++
  return `g${n}`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/sidebar-mutations.test.ts`
Expected: PASS (17 tests)

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/sidebar-layout.ts tests/renderer/sidebar-mutations.test.ts
git commit -m "feat: add pure layout mutations for groups and hiding"
```

---

### Task 5: Store layout state and layout-aware keyboard nav

**Files:**
- Modify: `src/renderer/state/store.ts`
- Modify: `tests/renderer/store-select-relative.test.ts`

**Interfaces:**
- Consumes: `deriveSections`, `navOrder`, and every mutation from Tasks 3–4; `window.api.getLayout` / `setLayout` from Task 2.
- Produces on the store: `layout: Layout`, `applyLayout(next: Layout): void`, and a `selectRelative` that walks `navOrder`.

- [ ] **Step 1: Write the failing tests**

In `tests/renderer/store-select-relative.test.ts`, extend `seed` so tests can supply a layout, and add a describe block. Replace the existing `seed` helper with:

```ts
const seed = (paths: string[], selected?: string, layout?: Partial<Layout>) =>
  useStore.setState({
    worktrees: paths.map(p => wt(p)),
    repos: ['/code/repo'],
    layout: { groups: [], hidden: [], hiddenCollapsed: true, ...layout },
    selected, modalOpen: 0, openDiff: null
  })
```

Add `import type { Layout, Worktree } from '@shared/ipc-types'` — the file already imports `Worktree`, so extend that import rather than adding a second one. Note `wt()` in this file defaults `repoName` to `'repo'`, which matches the `'/code/repo'` repo path above; keep it that way.

Then append:

```ts
describe('selectRelative with a layout', () => {
  it('follows group order rather than git order', () => {
    seed(['/a', '/b', '/c'], '/c', {
      groups: [{ id: 'g1', name: 'G', collapsed: false, paths: ['/c', '/b'] }]
    })
    // Sidebar order is /c, /b (group), then /a (repo section).
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })

  it('skips a collapsed group', () => {
    seed(['/a', '/b', '/c'], '/a', {
      groups: [{ id: 'g1', name: 'G', collapsed: true, paths: ['/b'] }]
    })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
  })

  it('skips hidden worktrees while the hidden section is collapsed', () => {
    seed(['/a', '/b', '/c'], '/a', { hidden: ['/b'] })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
  })

  it('reaches hidden worktrees when the hidden section is expanded', () => {
    seed(['/a', '/b', '/c'], '/c', { hidden: ['/b'], hiddenCollapsed: false })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })

  it('keeps a hidden selection selected and steps forward from the visible list', () => {
    // Hiding the selected worktree leaves it selected (its terminal stays open),
    // but it isn't in nav order, so stepping starts from the top.
    seed(['/a', '/b', '/c'], '/b', { hidden: ['/b'] })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/renderer/store-select-relative.test.ts`
Expected: FAIL — `layout` is not a property of the store's state type, and the group-order tests still get git order.

- [ ] **Step 3: Implement the store changes**

In `src/renderer/state/store.ts`:

Add imports:

```ts
import { emptyLayout, type Layout, type Worktree, type WorktreeStatus } from '@shared/ipc-types'
import { deriveSections, navOrder } from '../components/sidebar-layout'
```

(The existing `import type { Worktree, WorktreeStatus }` line becomes the plain import above, since `emptyLayout` is a value.)

Add to `interface State`:

```ts
  // Sidebar organization. Held here rather than in Sidebar.tsx because keyboard
  // nav (selectRelative) has to walk the same order the sidebar renders.
  layout: Layout
  applyLayout: (next: Layout) => void
```

Add to the store body, next to `names`:

```ts
  layout: emptyLayout(),
```

And the action, next to `rename`:

```ts
  // Optimistic: state updates now, disk catches up. A failed write is logged and
  // left alone rather than reverted — snapping a row back under the user's cursor
  // is worse than a layout that repairs itself on the next successful write.
  applyLayout: (next) => {
    set({ layout: next })
    window.api.setLayout(next).catch(e => console.error('layout write failed', e))
  },
```

In `init`, load it alongside names:

```ts
    set({ repos, names: await window.api.listNames(), layout: await window.api.getLayout() })
```

Replace `selectRelative` with a nav-order walk:

```ts
  // Walk the sidebar exactly as rendered: groups first in layout order, then repo
  // sections, then Hidden — with collapsed sections skipped, so Cmd+Up/Down never
  // jumps to a row that isn't on screen.
  selectRelative: (delta) => {
    const { worktrees, repos, layout, selected, modalOpen, openDiff, select } = get()
    if (modalOpen > 0 || openDiff) return
    const order = navOrder(deriveSections(layout, worktrees, repos))
    const n = order.length
    if (n === 0) return
    const i = order.indexOf(selected ?? '')
    // i === -1 covers nothing selected yet, a selection that has disappeared from
    // the list (the 3s refresh can produce this), and a selection that is hidden
    // inside a collapsed section.
    if (i === -1) return select(order[delta === 1 ? 0 : n - 1])
    select(order[(i + delta + n) % n])
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/renderer/store-select-relative.test.ts`
Expected: PASS — all pre-existing tests plus the 5 new ones. (The pre-existing tests seed no layout, so nav order equals git order for them.)

- [ ] **Step 5: Typecheck and commit**

```bash
npx tsc --noEmit
git add src/renderer/state/store.ts tests/renderer/store-select-relative.test.ts
git commit -m "feat: hold layout in the store and walk it for keyboard nav"
```

---

### Task 6: Extract WorktreeRow (no behavior change)

**Files:**
- Create: `src/renderer/components/WorktreeRow.tsx`
- Modify: `src/renderer/components/Sidebar.tsx:141-187` (the row JSX) and its icon helpers at lines 9-31

**Interfaces:**
- Consumes: `Worktree`, `deriveDot` from `@shared/agent-status`, the store.
- Produces:

```ts
interface WorktreeRowProps {
  worktree: Worktree
  editing: boolean
  draft: string
  onDraftChange: (v: string) => void
  onStartEdit: () => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onRemove: () => void
  onShowTip: (e: React.MouseEvent) => void
  onHideTip: () => void
}
export function WorktreeRow(props: WorktreeRowProps): JSX.Element
```

This task is a pure refactor: no test changes, no visual change. Later tasks add hide and drag props on top of this shape.

- [ ] **Step 1: Create the component**

Create `src/renderer/components/WorktreeRow.tsx` and move, verbatim, the `MainDotIcon`, `BranchIcon`, and `WorkingSpinner` helpers out of `Sidebar.tsx` (lines 9-31) plus the row JSX (lines 145-185). The component reads `selected`, `select`, `statuses`, `agentStatuses`, `seenAt`, and `names` from `useStore` itself, so `Sidebar.tsx` no longer threads them per row:

```tsx
import { useStore } from '../state/store'
import type { Worktree } from '@shared/ipc-types'
import { deriveDot } from '@shared/agent-status'

function MainDotIcon() { /* moved verbatim from Sidebar.tsx */ }
function BranchIcon() { /* moved verbatim from Sidebar.tsx */ }
function WorkingSpinner() { return <span className="wt-row-spinner" title="Agent working" /> }

export interface WorktreeRowProps {
  worktree: Worktree
  editing: boolean
  draft: string
  onDraftChange: (v: string) => void
  onStartEdit: () => void
  onCommitEdit: () => void
  onCancelEdit: () => void
  onRemove: () => void
  onShowTip: (e: React.MouseEvent) => void
  onHideTip: () => void
}

export function WorktreeRow({
  worktree: w, editing, draft, onDraftChange, onStartEdit, onCommitEdit,
  onCancelEdit, onRemove, onShowTip, onHideTip
}: WorktreeRowProps) {
  const { statuses, agentStatuses, seenAt, names, selected, select } = useStore()
  const count = statuses[w.path]?.changeCount ?? 0
  const dot = deriveDot(agentStatuses[w.path], seenAt[w.path])
  return (
    <div className={`wt-row${selected === w.path ? ' selected' : ''}${dot ? ` ${dot}` : ''}`}
         onClick={() => select(w.path)}
         onMouseEnter={onShowTip} onMouseLeave={onHideTip}>
      {/* the two-line name/branch block and the badge/remove block, moved
          verbatim from Sidebar.tsx lines 148-184, with:
            startEdit(w)          -> onStartEdit()
            setDraft(...)         -> onDraftChange(...)
            commitEdit()          -> onCommitEdit()
            setEditingPath(null)  -> onCancelEdit()
            editingPath === w.path -> editing
            the remove onClick body -> onRemove()  (keep e.stopPropagation()) */}
    </div>
  )
}
```

- [ ] **Step 2: Use it from Sidebar**

In `Sidebar.tsx`, replace the mapped row JSX with:

```tsx
              {repoWorktrees.map(w => (
                <WorktreeRow
                  key={w.path}
                  worktree={w}
                  editing={editingPath === w.path}
                  draft={draft}
                  onDraftChange={setDraft}
                  onStartEdit={() => startEdit(w)}
                  onCommitEdit={commitEdit}
                  onCancelEdit={() => setEditingPath(null)}
                  onRemove={() => { setError(undefined); setPending(w) }}
                  onShowTip={e => showTip(e, w.path)}
                  onHideTip={hideTip}
                />
              ))}
```

Delete the now-unused icon helpers and the `deriveDot` import from `Sidebar.tsx`, and add `import { WorktreeRow } from './WorktreeRow'`.

- [ ] **Step 3: Verify nothing broke**

Run: `npx tsc --noEmit && npm run test:fast`
Expected: no type errors, all tests pass.

- [ ] **Step 4: Verify visually**

Run: `npm run dev`
Expected: the sidebar looks and behaves exactly as before — selection, double-click rename, change badge, hover ✕, and the agent-status row colors. Close the app.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/WorktreeRow.tsx src/renderer/components/Sidebar.tsx
git commit -m "refactor: extract WorktreeRow from Sidebar"
```

---

### Task 7: Render groups, repo sections, and Hidden

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/components/WorktreeRow.tsx` (add the hide/unhide action)
- Modify: `src/renderer/components/sidebar-theme.css`

**Interfaces:**
- Consumes: `deriveSections`, `repoLabel`, `addGroup`, `renameGroup`, `deleteGroup`, `toggleGroupCollapsed`, `toggleHiddenCollapsed`, `moveTo`, `newGroupId` from Task 4; `layout` and `applyLayout` from Task 5.
- Produces: two new `WorktreeRowProps` fields — `hidden: boolean` and `onToggleHidden: () => void` — consumed by Task 8 as well.

- [ ] **Step 1: Add the hide action to the row**

In `WorktreeRow.tsx`, add to `WorktreeRowProps`:

```ts
  // In the Hidden section the same control un-hides, so one prop covers both.
  hidden: boolean
  onToggleHidden: () => void
```

And in the trailing action block, before the existing remove ✕:

```tsx
      <span className="wt-row-hide" title={hidden ? 'Show in sidebar' : 'Hide'}
            onClick={e => { e.stopPropagation(); onToggleHidden() }}>
        {hidden ? '◇' : '◆'}
      </span>
```

- [ ] **Step 2: Add the CSS**

Append to `src/renderer/components/sidebar-theme.css`:

```css
.wt-group-header {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  font-size: 11px;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #9aa0a6;
  cursor: pointer;
  user-select: none;
}
.wt-group-header:hover { background: rgba(255, 255, 255, 0.04); }
.wt-group-caret { width: 10px; flex-shrink: 0; transition: transform 120ms ease; }
.wt-group-caret.open { transform: rotate(90deg); }
.wt-group-count {
  background: rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  padding: 0 5px;
  font-size: 10px;
  font-weight: 500;
}
.wt-group-delete { opacity: 0; cursor: pointer; flex-shrink: 0; }
.wt-group-header:hover .wt-group-delete { opacity: 1; }
.wt-group-delete:hover { color: #f28b82; }
.wt-row-hide { opacity: 0; cursor: pointer; font-size: 10px; color: #9aa0a6; }
.wt-row:hover .wt-row-hide, .wt-row.selected .wt-row-hide { opacity: 1; }
.wt-row-hide:hover { color: #fff; }
```

- [ ] **Step 3: Render sections in Sidebar**

Replace the `groups` `useMemo` (Sidebar.tsx:109-114) with:

```tsx
  const { layout, applyLayout } = useStore()
  const sections = useMemo(
    () => deriveSections(layout, worktrees, repos), [layout, worktrees, repos]
  )
  // Which group header is being renamed, and its draft. Kept separate from the
  // row rename state above so editing a group can't cancel a row edit.
  const [editingGroup, setEditingGroup] = useState<string | null>(null)
  const [groupDraft, setGroupDraft] = useState('')

  const createGroup = () => {
    const id = newGroupId(layout)
    applyLayout(addGroup(layout, id))
    setEditingGroup(id)
    setGroupDraft('New group')
  }
  const commitGroupEdit = () => {
    if (editingGroup) applyLayout(renameGroup(layout, editingGroup, groupDraft))
    setEditingGroup(null)
  }
```

Add `+ Group` to the header, before `+ Repo`:

```tsx
        <button className="wt-btn wt-btn-ghost" onClick={createGroup}>+ Group</button>
```

Replace the `groups.map(...)` block with a `sections.map(...)` that renders each kind. The row block is shared, so factor it into a local helper inside the component:

```tsx
  const renderRows = (list: Worktree[], isHidden: boolean) => list.map(w => (
    <WorktreeRow
      key={w.path}
      worktree={w}
      editing={editingPath === w.path}
      draft={draft}
      onDraftChange={setDraft}
      onStartEdit={() => startEdit(w)}
      onCommitEdit={commitEdit}
      onCancelEdit={() => setEditingPath(null)}
      onRemove={() => { setError(undefined); setPending(w) }}
      onShowTip={e => showTip(e, w.path)}
      onHideTip={hideTip}
      hidden={isHidden}
      onToggleHidden={() =>
        applyLayout(moveTo(layout, w.path, { kind: isHidden ? 'repo' : 'hidden' }))}
    />
  ))
```

and the section list:

```tsx
        {sections.map(section => {
          if (section.kind === 'group') {
            return (
              <div key={`g:${section.id}`}>
                <div className="wt-group-header"
                     onClick={() => applyLayout(toggleGroupCollapsed(layout, section.id))}>
                  <span className={`wt-group-caret${section.collapsed ? '' : ' open'}`}>▸</span>
                  {editingGroup === section.id ? (
                    <input className="wt-input" autoFocus value={groupDraft}
                           onChange={e => setGroupDraft(e.target.value)}
                           onClick={e => e.stopPropagation()}
                           onBlur={commitGroupEdit}
                           onKeyDown={e => {
                             e.stopPropagation()
                             if (e.key === 'Enter') commitGroupEdit()
                             else if (e.key === 'Escape') setEditingGroup(null)
                           }}
                           style={{ flex: 1, minWidth: 0 }} />
                  ) : (
                    <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                                   whiteSpace: 'nowrap' }}
                          onDoubleClick={e => {
                            e.stopPropagation()
                            setEditingGroup(section.id); setGroupDraft(section.name)
                          }}
                          title="Double-click to rename">
                      {section.name}
                    </span>
                  )}
                  <span className="wt-group-count">{section.worktrees.length}</span>
                  <span className="wt-group-delete" title="Delete group"
                        onClick={e => { e.stopPropagation(); applyLayout(deleteGroup(layout, section.id)) }}>
                    ✕
                  </span>
                </div>
                {!section.collapsed && renderRows(section.worktrees, false)}
                {!section.collapsed && section.worktrees.length === 0 && (
                  <div style={{ padding: '6px 10px 8px 24px', color: '#777', fontSize: 11 }}>
                    Drag worktrees here
                  </div>
                )}
              </div>
            )
          }
          if (section.kind === 'repo') {
            return (
              <div key={`r:${section.repo}`}>
                <div className="wt-repo-header" title={section.repo}>
                  <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis',
                                 whiteSpace: 'nowrap' }}>
                    {section.name}
                  </span>
                  <span className="wt-repo-disconnect" title="Disconnect repo"
                        onClick={() => setPendingRepo(section.repo)}>✕</span>
                </div>
                {renderRows(section.worktrees, false)}
              </div>
            )
          }
          // Hidden always renders its header, even when empty, so it's a stable
          // drop target — and collapsed by default so it stays out of the way.
          return (
            <div key="hidden">
              <div className="wt-group-header" onClick={() => applyLayout(toggleHiddenCollapsed(layout))}>
                <span className={`wt-group-caret${section.collapsed ? '' : ' open'}`}>▸</span>
                <span style={{ flex: 1 }}>Hidden</span>
                <span className="wt-group-count">{section.worktrees.length}</span>
              </div>
              {!section.collapsed && renderRows(section.worktrees, true)}
            </div>
          )
        })}
```

Add the imports:

```tsx
import {
  addGroup, deleteGroup, deriveSections, moveTo, newGroupId, renameGroup,
  toggleGroupCollapsed, toggleHiddenCollapsed
} from './sidebar-layout'
```

- [ ] **Step 4: Verify tests and types still pass**

Run: `npx tsc --noEmit && npm run test:fast`
Expected: no type errors, all tests pass.

- [ ] **Step 5: Verify in the app**

Run: `npm run dev`
Expected, checked in order:
1. Sidebar looks as before, with `+ Group` in the header and a collapsed `Hidden 0` at the bottom.
2. `+ Group` adds a group header in edit mode; typing a name and pressing Enter keeps it.
3. Double-clicking the header re-opens the rename; Escape cancels.
4. Clicking the header collapses/expands; the count badge stays visible.
5. Hovering a row shows the ◆ hide icon; clicking it moves the row into `Hidden 1`.
6. Expanding Hidden shows the row with a ◇ icon; clicking that returns it to its repo section.
7. Quit and relaunch: groups, names, collapse state, and hidden rows are all still there.
8. With a group collapsed, Cmd+Up/Down skips its rows.

Close the app.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/components/WorktreeRow.tsx src/renderer/components/sidebar-theme.css
git commit -m "feat: render worktree groups and a hidden section in the sidebar"
```

---

### Task 8: Drag and drop

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx`
- Modify: `src/renderer/components/WorktreeRow.tsx`
- Modify: `src/renderer/components/sidebar-theme.css`

**Interfaces:**
- Consumes: `moveTo`, `reorderGroup`, `DropTarget` from Task 4; `applyLayout` from Task 5.
- Produces: three more `WorktreeRowProps` fields — `dragging: boolean`, `dropEdge: 'top' | 'bottom' | null`, and the DnD handlers described below.

Native HTML5 DnD. Two payload kinds go through `dataTransfer`, distinguished by MIME type so a group header can never be dropped into a group body:

- `application/x-wtm-path` — a worktree path
- `application/x-wtm-group` — a group id

Note Chromium only exposes `dataTransfer.types` (not values) during `dragover`, which is why the kind lives in the MIME type rather than in the payload.

- [ ] **Step 1: Add drag props to the row**

In `WorktreeRow.tsx`, add to `WorktreeRowProps`:

```ts
  dragging: boolean
  // Which edge to draw the insertion line on while a drag hovers this row.
  dropEdge: 'top' | 'bottom' | null
  onDragStart: (e: React.DragEvent) => void
  onDragEnd: () => void
  onDragOver: (e: React.DragEvent) => void
  onDrop: (e: React.DragEvent) => void
```

And on the row's root `<div>`, add:

```tsx
      draggable
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      onDragOver={onDragOver}
      onDrop={onDrop}
```

extending its className with the drag state:

```tsx
      className={`wt-row${selected === w.path ? ' selected' : ''}${dot ? ` ${dot}` : ''}` +
                 `${dragging ? ' dragging' : ''}${dropEdge ? ` drop-${dropEdge}` : ''}`}
```

Inline rename must survive dragging: set `draggable={!editing}` instead of a bare `draggable`, so text selection inside the `<input>` still works.

- [ ] **Step 2: Add the drag CSS**

Append to `sidebar-theme.css`:

```css
.wt-row.dragging { opacity: 0.4; }
/* Insertion line. Inset shadow rather than a border so the row's height never
   shifts as the indicator moves between rows. */
.wt-row.drop-top { box-shadow: inset 0 2px 0 0 #0e639c; }
.wt-row.drop-bottom { box-shadow: inset 0 -2px 0 0 #0e639c; }
.wt-group-header.drop-into, .wt-repo-header.drop-into {
  background: rgba(14, 99, 156, 0.25);
}
.wt-group-header.drop-above { box-shadow: inset 0 2px 0 0 #0e639c; }
```

- [ ] **Step 3: Wire the drag state in Sidebar**

Add to `Sidebar.tsx`, next to the other state:

```tsx
  // Native HTML5 DnD. `drag` is what's being dragged; `over` is where the
  // insertion indicator currently draws. Both are cleared on drop or dragend.
  const [drag, setDrag] = useState<{ kind: 'path'; path: string } | { kind: 'group'; id: string } | null>(null)
  const [over, setOver] = useState<
    { kind: 'row'; path: string; edge: 'top' | 'bottom' } |
    { kind: 'section'; key: string } |
    { kind: 'groupHeader'; id: string } | null
  >(null)

  const clearDrag = () => { setDrag(null); setOver(null) }

  const PATH_MIME = 'application/x-wtm-path'
  const GROUP_MIME = 'application/x-wtm-group'

  // Where a row would land: the target section, plus the index within it.
  const dropRow = (path: string, target: DropTarget, index?: number) => {
    applyLayout(moveTo(layout, path, target, index))
    clearDrag()
  }
```

Row handlers, passed from `renderRows` — which now needs the section's drop target and the section's worktree list so it can compute indices. Change its signature to `renderRows(list, isHidden, target)` where `target: DropTarget`:

```tsx
  const renderRows = (list: Worktree[], isHidden: boolean, target: DropTarget) =>
    list.map((w, i) => (
      <WorktreeRow
        key={w.path}
        /* ...all props from Task 7, unchanged... */
        dragging={drag?.kind === 'path' && drag.path === w.path}
        dropEdge={over?.kind === 'row' && over.path === w.path ? over.edge : null}
        onDragStart={e => {
          e.dataTransfer.setData(PATH_MIME, w.path)
          e.dataTransfer.effectAllowed = 'move'
          setDrag({ kind: 'path', path: w.path })
        }}
        onDragEnd={clearDrag}
        onDragOver={e => {
          if (!e.dataTransfer.types.includes(PATH_MIME)) return
          e.preventDefault()
          e.dataTransfer.dropEffect = 'move'
          // Halfway down the row flips the indicator to the bottom edge, so the
          // line always sits at the boundary the drop will actually use.
          const r = e.currentTarget.getBoundingClientRect()
          const edge = e.clientY - r.top > r.height / 2 ? 'bottom' : 'top'
          setOver({ kind: 'row', path: w.path, edge })
        }}
        onDrop={e => {
          const path = e.dataTransfer.getData(PATH_MIME)
          if (!path) return
          e.preventDefault(); e.stopPropagation()
          const r = e.currentTarget.getBoundingClientRect()
          const after = e.clientY - r.top > r.height / 2
          dropRow(path, target, i + (after ? 1 : 0))
        }}
      />
    ))
```

Call sites: group sections pass `{ kind: 'group', id: section.id }`, repo sections pass `{ kind: 'repo' }`, hidden passes `{ kind: 'hidden' }`.

Section-level drop (covers dropping onto a header, onto the "Drag worktrees here" placeholder, or onto empty space below a section's rows). Add a small helper and spread it onto each section's wrapper `<div>`:

```tsx
  const sectionDropProps = (key: string, target: DropTarget) => ({
    onDragOver: (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes(PATH_MIME)) return
      e.preventDefault()
      e.dataTransfer.dropEffect = 'move'
      setOver({ kind: 'section', key })
    },
    onDrop: (e: React.DragEvent) => {
      const path = e.dataTransfer.getData(PATH_MIME)
      if (!path) return
      e.preventDefault()
      // No index: a drop on the section itself appends.
      dropRow(path, target)
    }
  })
```

Apply `drop-into` styling to a section's header when `over?.kind === 'section' && over.key === <that section's key>`, using the section keys already in use: `g:<id>`, `r:<repo>`, `hidden`.

Group header reordering — add to the group header `<div>`, alongside its existing `onClick`:

```tsx
                  draggable={editingGroup !== section.id}
                  onDragStart={e => {
                    e.dataTransfer.setData(GROUP_MIME, section.id)
                    e.dataTransfer.effectAllowed = 'move'
                    setDrag({ kind: 'group', id: section.id })
                  }}
                  onDragEnd={clearDrag}
                  onDragOver={e => {
                    if (!e.dataTransfer.types.includes(GROUP_MIME)) return
                    e.preventDefault()
                    setOver({ kind: 'groupHeader', id: section.id })
                  }}
                  onDrop={e => {
                    const id = e.dataTransfer.getData(GROUP_MIME)
                    if (!id || id === section.id) return clearDrag()
                    e.preventDefault(); e.stopPropagation()
                    // Drop lands the dragged group at the target's current index,
                    // i.e. immediately above it.
                    const index = layout.groups.findIndex(g => g.id === section.id)
                    applyLayout(reorderGroup(layout, id, index))
                    clearDrag()
                  }}
                  className={`wt-group-header${
                    over?.kind === 'groupHeader' && over.id === section.id ? ' drop-above' : ''}${
                    over?.kind === 'section' && over.key === `g:${section.id}` ? ' drop-into' : ''}`}
```

Both handler sets coexist because they gate on different MIME types: a group drag is invisible to the row/section handlers and vice versa.

`onDragOver` on group headers must not also trigger the header's `onClick` collapse — it won't, since a drag never produces a click, but do check this in Step 5.

Add `reorderGroup` and `type DropTarget` to the `./sidebar-layout` import.

- [ ] **Step 4: Verify tests and types still pass**

Run: `npx tsc --noEmit && npm run test:fast`
Expected: no type errors, all tests pass.

- [ ] **Step 5: Verify in the app**

Run: `npm run dev`, with at least two repos connected and one group created. Check in order:
1. Dragging a row shows it at 40% opacity and draws a 2px insertion line at the nearest row boundary.
2. Dropping a row into a group's body inserts it at the indicated position; the row leaves its repo section.
3. Dropping onto a group *header* (or the "Drag worktrees here" placeholder) appends it to that group.
4. Reordering within a group works in both directions, including to the first and last positions.
5. Dropping a row onto a repo section returns it to that section, ungrouped.
6. Dropping a row onto the Hidden header moves it to Hidden; dragging it back out restores it.
7. Dragging a group header onto another group header reorders the groups.
8. A group header cannot be dropped into a group body, and a row cannot be dropped "as a group" — neither shows a drop indicator.
9. Double-click rename still selects text normally (rows and group headers) rather than starting a drag.
10. Quit and relaunch: every drag result persisted.

Close the app.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/Sidebar.tsx src/renderer/components/WorktreeRow.tsx src/renderer/components/sidebar-theme.css
git commit -m "feat: drag and drop worktrees between groups and reorder groups"
```

---

### Task 9: Purge layout entries on repo disconnect

**Files:**
- Modify: `src/renderer/components/Sidebar.tsx:73-87` (`doDisconnectRepo`)
- Test: `tests/renderer/sidebar-mutations.test.ts` (already covers `purgePaths` from Task 4 — no new unit test needed; this task wires it up)

**Interfaces:**
- Consumes: `purgePaths` from Task 4, `repoLabel` from Task 3, `applyLayout` from Task 5.
- Produces: nothing new.

- [ ] **Step 1: Wire the purge**

In `doDisconnectRepo`, capture the disconnected repo's worktree paths *before* `refreshWorktrees()` drops them from state, then purge:

```tsx
  const doDisconnectRepo = async () => {
    if (!pendingRepo) return
    setBusy(true); setError(undefined)
    try {
      // Capture before the refresh: once the repo is gone its worktrees vanish
      // from state, and we'd have nothing left to match layout entries against.
      const name = repoLabel(pendingRepo)
      const gone = useStore.getState().worktrees.filter(w => w.repoName === name).map(w => w.path)
      const repos = await window.api.removeRepo(pendingRepo)
      useStore.setState({ repos })
      // These worktrees are gone from the app for good, so really forget them —
      // unlike a missing worktree, which render-time filtering handles.
      applyLayout(purgePaths(useStore.getState().layout, gone))
      await refreshWorktrees()
      const stillThere = useStore.getState().worktrees.some(w => w.path === selected)
      if (!stillThere) useStore.setState({ selected: undefined })
      setPendingRepo(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally { setBusy(false) }
  }
```

Add `purgePaths` and `repoLabel` to the `./sidebar-layout` import.

- [ ] **Step 2: Verify tests and types pass**

Run: `npx tsc --noEmit && npm run test:fast`
Expected: no type errors, all tests pass.

- [ ] **Step 3: Verify in the app**

Run: `npm run dev`
Expected: put a worktree from repo A into a group and another into Hidden, disconnect repo A, then quit and relaunch and re-add repo A. Its worktrees come back ungrouped under their repo section, and `layout.json` (in the app's userData dir) contains no paths from repo A. Groups that ended up empty still exist.

Close the app.

- [ ] **Step 4: Full verification**

Run: `npm test`
Expected: the whole suite passes, including the slow git tests.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/Sidebar.tsx
git commit -m "feat: forget layout entries for a disconnected repo"
```

---

## Spec deviation

The spec put the layout persistence tests in `tests/main/config.test.ts` and the repo-disconnect purge test there too. Actual placement:

- Persistence tests → `tests/main/layout-config.test.ts` (the existing config test file lives at `tests/config.test.ts`, and `tests/main/` already holds a sibling `repo-commands-config.test.ts`; a new file keeps this feature's tests together).
- The purge test → `tests/renderer/sidebar-mutations.test.ts`, since `purgePaths` is a pure renderer function; the main process never knows about repo→path relationships.
