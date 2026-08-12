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
    // repoOrder is an ordering hint, not a membership list: order by it first
    // (skipping anything already claimed by a group or hidden, and any ghost
    // entry with no live worktree), then git order for whatever's left — a
    // worktree the user has never dragged lands at the end.
    const ordered = layout.repoOrder[repo] ?? []
    const rest = worktrees.filter(w => w.repoName === name).map(w => w.path)
    sections.push({ kind: 'repo', repo, name, worktrees: take([...ordered, ...rest]) })
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

// `members` is the repo section's currently rendered paths, in render order —
// the same array deriveSections just produced for it. moveTo needs this to
// materialize a COMPLETE order on the first drag: repoOrder starts as {} for
// every real user, and resolving an anchor against that sparse array (rather
// than the full rendered section) can never place the dragged row anywhere
// but the end, since the anchor path itself isn't in the sparse array yet.
export type DropTarget =
  | { kind: 'group'; id: string }
  | { kind: 'repo'; repo: string; members: string[] }
  | { kind: 'hidden' }

// Where within a target section a dropped path lands, expressed relative to a
// real neighbour rather than a count. A numeric index breaks in two ways: (1)
// insert() detaches the dragged path before inserting, which shifts every
// index after the detach point, so a caller handing over a pre-detach index is
// off by one on every downward move within the same section; (2) the row list
// on screen is rendered from deriveSections, which filters out "ghost" paths
// (kept in the layout, but with no live worktree) — so a rendered index and a
// raw group.paths index disagree as soon as a ghost path is in the mix.
// Anchoring on a real path sidesteps both: the anchor is always resolved
// against the raw array being mutated.
export type Anchor = { kind: 'end' } | { kind: 'before' | 'after'; path: string }

// Every mutation returns a new Layout and never touches its input: the store
// keeps layout in immutable state and writes the result straight to disk.
const without = (paths: string[], path: string) => paths.filter(p => p !== path)

const insert = (paths: string[], path: string, index?: number): string[] => {
  const rest = without(paths, path)
  const at = index === undefined ? rest.length : Math.max(0, Math.min(index, rest.length))
  return [...rest.slice(0, at), path, ...rest.slice(at)]
}

// Resolves an anchor against `paths` (the real array insert() will slice into,
// already understood to have the dragged path removed). Falls back to
// appending if the anchor names a path that isn't actually there.
const resolveAnchor = (paths: string[], anchor?: Anchor): number | undefined => {
  if (!anchor || anchor.kind === 'end') return undefined
  const i = paths.indexOf(anchor.path)
  if (i === -1) return undefined
  return anchor.kind === 'before' ? i : i + 1
}

// Detach first, then attach, so a path can never end up in two places — including
// when the source and destination are the same group (a plain reorder). Also
// strips the path from every repo's order list: repoOrder is an ordering hint
// for wherever the path currently lands ungrouped, not a second membership
// list, so a stale entry under another repo would otherwise linger unused.
function detach(layout: Layout, path: string): Layout {
  return {
    ...layout,
    groups: layout.groups.map(g => ({ ...g, paths: without(g.paths, path) })),
    hidden: without(layout.hidden, path),
    repoOrder: Object.fromEntries(
      Object.entries(layout.repoOrder).map(([repo, paths]) => [repo, without(paths, path)])
    )
  }
}

export function moveTo(layout: Layout, path: string, target: DropTarget, anchor?: Anchor): Layout {
  // A path anchored on itself (dropping a row onto its own position — HTML5
  // DnD fires `drop` on the source element too) can never be resolved: detach
  // removes it before the anchor lookup runs, so it would otherwise fall back
  // to appending and bump the row to the end instead of leaving it in place.
  if (anchor && 'path' in anchor && anchor.path === path) return layout
  if (target.kind === 'group' && !layout.groups.some(g => g.id === target.id)) return layout
  const next = detach(layout, path)
  // Dropping on a repo section means "ungrouped, in this position" — the same
  // detach-then-insert pattern as group/hidden, but first materialized into a
  // COMPLETE order: start from whatever repoOrder already has (any entry not
  // in `members` is a ghost — a worktree temporarily gone — and is kept in
  // place), then append the rest of `members` in their rendered order. Only
  // then is the anchor resolved and the drag applied, so a second drag has
  // real positions for every visible row to anchor against.
  if (target.kind === 'repo') {
    const existing = next.repoOrder[target.repo] ?? []
    const known = new Set(existing)
    // `members` is the section as rendered before the drop, so it still
    // includes the dragged path itself (unless it's arriving from elsewhere)
    // — exclude it here so `complete` is the "rest" array resolveAnchor
    // expects, the same way detach already stripped it from every other list.
    const complete = [...existing, ...target.members.filter(p => !known.has(p) && p !== path)]
    const order = insert(complete, path, resolveAnchor(complete, anchor))
    return { ...next, repoOrder: { ...next.repoOrder, [target.repo]: order } }
  }
  if (target.kind === 'hidden') return { ...next, hidden: insert(next.hidden, path, resolveAnchor(next.hidden, anchor)) }
  return {
    ...next,
    groups: next.groups.map(g => g.id === target.id
      ? { ...g, paths: insert(g.paths, path, resolveAnchor(g.paths, anchor)) }
      : g)
  }
}

// Unhiding (or ungrouping outside of a drag) removes the path from wherever
// it's filed without recording a position for it. Deliberately does not
// touch repoOrder: an unhidden worktree has no user-chosen position yet, so
// it should fall back to git order among the unlisted rows, not jump to the
// top of repoOrder just because that's index 0 of an empty/short array.
export function ungroup(layout: Layout, path: string): Layout {
  return detach(layout, path)
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

// Lands the dragged group immediately above `beforeId`, in either direction.
// Named by target id rather than a numeric index for the same reason moveTo
// takes an Anchor: an index taken before the dragged group is detached lands
// one slot too low on a downward drag, since detaching shifts everything after
// it. Resolving against `rest` (the list with the dragged group already gone)
// keeps "immediately above" true regardless of which way the drag went.
export function reorderGroup(layout: Layout, id: string, beforeId: string): Layout {
  const g = layout.groups.find(x => x.id === id)
  if (!g || id === beforeId) return layout
  const rest = layout.groups.filter(x => x.id !== id)
  const i = rest.findIndex(x => x.id === beforeId)
  const at = i === -1 ? rest.length : i
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
  const repoOrder: Record<string, string[]> = {}
  for (const [repo, order] of Object.entries(layout.repoOrder)) {
    const filtered = order.filter(p => !drop.has(p))
    // Drop the key too once it's empty: for the repo actually being
    // disconnected this really forgets it, rather than leaving a dangling
    // empty array behind forever.
    if (filtered.length > 0) repoOrder[repo] = filtered
  }
  return {
    ...layout,
    groups: layout.groups.map(g => ({ ...g, paths: g.paths.filter(p => !drop.has(p)) })),
    hidden: layout.hidden.filter(p => !drop.has(p)),
    repoOrder
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
