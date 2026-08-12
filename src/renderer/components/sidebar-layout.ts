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
