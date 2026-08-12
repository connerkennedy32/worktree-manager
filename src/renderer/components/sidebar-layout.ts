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
