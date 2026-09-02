import { describe, it, expect } from 'vitest'
import type { Layout, Worktree } from '../../src/shared/ipc-types'
import {
  addGroup, deleteGroup, deriveSections, moveTo, newGroupId, purgePaths, renameGroup,
  reorderGroup, toggleGroupCollapsed, toggleHiddenCollapsed, ungroup
} from '../../src/renderer/components/sidebar-layout'

const base = (): Layout => ({
  groups: [
    { id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/b'] },
    { id: 'g2', name: 'Two', collapsed: false, paths: ['/c'] }
  ],
  hidden: ['/d'],
  hiddenCollapsed: true,
  ungroupedOrder: []
})
const ids = (l: Layout) => l.groups.map(g => g.id)
const pathsOf = (l: Layout, id: string) => l.groups.find(g => g.id === id)!.paths
const w = (path: string): Worktree => ({ path, branch: 'b', head: 'h', isMain: false, repoName: 'r' })

describe('moveTo', () => {
  it('inserts into a group before a given anchor path', () => {
    const l = moveTo(base(), '/c', { kind: 'group', id: 'g1' }, { kind: 'before', path: '/b' })
    expect(pathsOf(l, 'g1')).toEqual(['/a', '/c', '/b'])
    expect(pathsOf(l, 'g2')).toEqual([])
  })

  it('appends when no anchor is given', () => {
    expect(pathsOf(moveTo(base(), '/c', { kind: 'group', id: 'g1' }), 'g1'))
      .toEqual(['/a', '/b', '/c'])
  })

  it('reorders within the same group', () => {
    expect(pathsOf(moveTo(base(), '/b', { kind: 'group', id: 'g1' }, { kind: 'before', path: '/a' }), 'g1'))
      .toEqual(['/b', '/a'])
  })

  it('moving to the ungrouped target removes the path from every group and from hidden', () => {
    const l = moveTo(base(), '/a', { kind: 'ungrouped', members: [] })
    expect(pathsOf(l, 'g1')).toEqual(['/b'])
    expect(l.hidden).toEqual(['/d'])
    const h = moveTo(base(), '/d', { kind: 'ungrouped', members: [] })
    expect(h.hidden).toEqual([])
  })

  it('moves into hidden before a given anchor path', () => {
    const l = moveTo(base(), '/a', { kind: 'hidden' }, { kind: 'before', path: '/d' })
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

describe('moveTo with an anchor', () => {
  // Anchors name a real neighbour instead of a count, so a downward drag within
  // the same section lands exactly where the insertion line was drawn — the old
  // numeric-index API was off by one here because insert() detaches the dragged
  // path first, shifting every later index.
  it('moves after a later path in the same group (downward drag)', () => {
    const l: Layout = { groups: [{ id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/b', '/c', '/d'] }], hidden: [], hiddenCollapsed: true, ungroupedOrder: [] }
    const dropped = moveTo(l, '/a', { kind: 'group', id: 'g1' }, { kind: 'after', path: '/c' })
    expect(pathsOf(dropped, 'g1')).toEqual(['/b', '/c', '/a', '/d'])
  })

  it('moves before an earlier path in the same group (upward drag still works)', () => {
    expect(pathsOf(moveTo(base(), '/b', { kind: 'group', id: 'g1' }, { kind: 'before', path: '/a' }), 'g1'))
      .toEqual(['/b', '/a'])
  })

  it('appends when the anchor is "end"', () => {
    expect(pathsOf(moveTo(base(), '/c', { kind: 'group', id: 'g1' }, { kind: 'end' }), 'g1'))
      .toEqual(['/a', '/b', '/c'])
  })

  it('falls back to appending when the anchor path is not in the target', () => {
    expect(pathsOf(moveTo(base(), '/c', { kind: 'group', id: 'g1' }, { kind: 'before', path: '/nope' }), 'g1'))
      .toEqual(['/a', '/b', '/c'])
  })

  // A ghost path (kept in the layout, but with no live worktree) must not throw
  // off the index math: the anchor is a real path in the raw group.paths array,
  // so it resolves correctly regardless of what deriveSections filtered out.
  it('resolves correctly around a ghost path with no live worktree', () => {
    const l: Layout = { groups: [{ id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/ghost', '/b'] }], hidden: [], hiddenCollapsed: true, ungroupedOrder: [] }
    const dropped = moveTo(l, '/b', { kind: 'group', id: 'g1' }, { kind: 'after', path: '/a' })
    expect(pathsOf(dropped, 'g1')).toEqual(['/a', '/b', '/ghost'])
  })

  // HTML5 DnD fires `drop` on the source element too, so a row can be dropped
  // onto itself. Since detach() removes the path before the anchor lookup
  // runs, an anchor naming the dragged path's own position would otherwise be
  // unresolvable and silently fall back to appending, bumping the row to the
  // bottom instead of leaving it where it was.
  it('dropping a path onto itself leaves the section order unchanged', () => {
    const l = base()
    expect(moveTo(l, '/a', { kind: 'group', id: 'g1' }, { kind: 'after', path: '/a' })).toEqual(l)
    expect(moveTo(l, '/a', { kind: 'group', id: 'g1' }, { kind: 'before', path: '/a' })).toEqual(l)
  })

  it('a drop rendered onto a ghost-adjacent row still lands next to the right live worktree', () => {
    // Sidebar.tsx only ever anchors on paths it actually rendered, i.e. paths
    // with a live worktree — this simulates dragging /d onto /b (rendered after
    // the ghost) and dropping below it.
    const l: Layout = { groups: [{ id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/ghost', '/b'] }], hidden: [], hiddenCollapsed: true, ungroupedOrder: [] }
    const worktrees = [w('/a'), w('/b'), w('/d')]
    const before = deriveSections(l, worktrees)
    expect(before[0].worktrees.map(x => x.path)).toEqual(['/a', '/b'])
    const dropped = moveTo(l, '/d', { kind: 'group', id: 'g1' }, { kind: 'after', path: '/b' })
    expect(pathsOf(dropped, 'g1')).toEqual(['/a', '/ghost', '/b', '/d'])
  })
})

describe('moveTo with the ungrouped target', () => {
  // These pre-seed ungroupedOrder with the section's full membership already —
  // a state the app only reaches after a first drag. They exercise the
  // insert/anchor math on an already-complete array.
  it('reorders downward within the ungrouped section', () => {
    const l: Layout = { groups: [], hidden: [], hiddenCollapsed: true, ungroupedOrder: ['/a', '/b', '/c', '/d'] }
    const dropped = moveTo(l, '/a', { kind: 'ungrouped', members: ['/a', '/b', '/c', '/d'] },
      { kind: 'after', path: '/c' })
    expect(dropped.ungroupedOrder).toEqual(['/b', '/c', '/a', '/d'])
  })

  it('reorders upward within the ungrouped section', () => {
    const l: Layout = { groups: [], hidden: [], hiddenCollapsed: true, ungroupedOrder: ['/a', '/b', '/c', '/d'] }
    const dropped = moveTo(l, '/c', { kind: 'ungrouped', members: ['/a', '/b', '/c', '/d'] },
      { kind: 'before', path: '/a' })
    expect(dropped.ungroupedOrder).toEqual(['/c', '/a', '/b', '/d'])
  })

  it('drops a path from a group into the ungrouped section at a chosen position', () => {
    const l = { ...base(), ungroupedOrder: ['/x', '/y'] }
    const dropped = moveTo(l, '/a', { kind: 'ungrouped', members: ['/x', '/y'] },
      { kind: 'after', path: '/x' })
    expect(pathsOf(dropped, 'g1')).toEqual(['/b'])
    expect(dropped.ungroupedOrder).toEqual(['/x', '/a', '/y'])
  })

  it('resolves correctly around a ghost path with no live worktree', () => {
    const l: Layout = { groups: [], hidden: [], hiddenCollapsed: true, ungroupedOrder: ['/a', '/ghost', '/b'] }
    const dropped = moveTo(l, '/b', { kind: 'ungrouped', members: ['/a', '/b'] },
      { kind: 'after', path: '/a' })
    expect(dropped.ungroupedOrder).toEqual(['/a', '/b', '/ghost'])
  })

  // Now legal: the ungrouped section is one flat list, so a drag can move a
  // worktree from behind one repo's rows past another's — there is no longer
  // a repo boundary to stop it.
  it('moves a worktree past another repo\'s worktrees within the same flat list', () => {
    const l: Layout = { groups: [], hidden: [], hiddenCollapsed: true, ungroupedOrder: ['/r1/a', '/r1/b', '/r2/c'] }
    const dropped = moveTo(l, '/r2/c', { kind: 'ungrouped', members: ['/r1/a', '/r1/b', '/r2/c'] },
      { kind: 'before', path: '/r1/a' })
    expect(dropped.ungroupedOrder).toEqual(['/r2/c', '/r1/a', '/r1/b'])
  })
})

// The bug the review caught: every case above starts from an ungroupedOrder
// that already lists the section's full membership — a state the app only
// reaches after the user has dragged every row at least once. A brand-new
// layout has ungroupedOrder: [], and resolving an anchor against that sparse
// array can never place the drop anywhere but the end, since the anchor
// path itself isn't in the array yet. These round-trip through
// deriveSections, on the RENDERED order, starting from ungroupedOrder: [] —
// the state every real user actually starts in.
describe('moveTo with the ungrouped target, from a fresh layout (ungroupedOrder: [])', () => {
  const wts = [w('/a'), w('/b'), w('/c')]
  const fresh = (): Layout => ({ groups: [], hidden: [], hiddenCollapsed: true, ungroupedOrder: [] })
  const renderedOrder = (l: Layout) => deriveSections(l, wts)[0].worktrees.map(x => x.path)

  it('a downward drag actually reorders the section (the reported bug)', () => {
    // Sidebar.tsx anchors on the row actually rendered under the cursor —
    // dragging /a to just below /b means "after /b".
    const dropped = moveTo(fresh(), '/a', { kind: 'ungrouped', members: ['/a', '/b', '/c'] },
      { kind: 'after', path: '/b' })
    expect(renderedOrder(dropped)).toEqual(['/b', '/a', '/c'])
  })

  it('an upward drag reorders the section', () => {
    const dropped = moveTo(fresh(), '/c', { kind: 'ungrouped', members: ['/a', '/b', '/c'] },
      { kind: 'before', path: '/a' })
    expect(renderedOrder(dropped)).toEqual(['/c', '/a', '/b'])
  })

  it('a second drag lands correctly after the first materialized the order', () => {
    const first = moveTo(fresh(), '/a', { kind: 'ungrouped', members: ['/a', '/b', '/c'] },
      { kind: 'after', path: '/b' })
    expect(renderedOrder(first)).toEqual(['/b', '/a', '/c'])
    // Now drag /c (rendered last) to the top.
    const second = moveTo(first, '/c', { kind: 'ungrouped', members: renderedOrder(first) },
      { kind: 'before', path: '/b' })
    expect(renderedOrder(second)).toEqual(['/c', '/b', '/a'])
  })

  it('preserves a ghost entry in place while the visible rows reorder around it', () => {
    // /ghost has no live worktree, so it never appears in `members`, but a
    // prior drag already recorded it in ungroupedOrder.
    const l: Layout = { groups: [], hidden: [], hiddenCollapsed: true, ungroupedOrder: ['/a', '/ghost', '/b'] }
    const dropped = moveTo(l, '/c', { kind: 'ungrouped', members: ['/a', '/b'] },
      { kind: 'before', path: '/a' })
    expect(dropped.ungroupedOrder).toEqual(['/c', '/a', '/ghost', '/b'])
    expect(renderedOrder(dropped)).toEqual(['/c', '/a', '/b'])
  })
})

// Unhiding must not acquire a manual position just by leaving the hidden
// section — it should fall back to natural order among the rows
// ungroupedOrder doesn't mention, not jump to the top of an empty/short
// ungroupedOrder array.
describe('ungroup', () => {
  const wts = [w('/a'), w('/b'), w('/c')]
  const renderedOrder = (l: Layout) => deriveSections(l, wts).find(s => s.kind === 'ungrouped')!.worktrees.map(x => x.path)

  it('returns an unhidden worktree to its natural-order position, not the top', () => {
    const l: Layout = { groups: [], hidden: ['/b'], hiddenCollapsed: true, ungroupedOrder: [] }
    expect(renderedOrder(l)).toEqual(['/a', '/c'])
    expect(renderedOrder(ungroup(l, '/b'))).toEqual(['/a', '/b', '/c'])
  })

  it('lands among the unlisted tail when there is already a manual order', () => {
    const l: Layout = { groups: [], hidden: ['/b'], hiddenCollapsed: true, ungroupedOrder: ['/c', '/a'] }
    // /b isn't in ungroupedOrder, so unhiding it must not write it in at index 0.
    expect(renderedOrder(ungroup(l, '/b'))).toEqual(['/c', '/a', '/b'])
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
    // /a and /b are now in no group, so they fall back to the ungrouped section.
    expect(l.groups.flatMap(g => g.paths)).toEqual(['/c'])
    expect(l.hidden).toEqual(['/d'])
  })

  it('reorders groups: dragging one lands immediately above the target, either direction', () => {
    expect(ids(reorderGroup(base(), 'g2', 'g1'))).toEqual(['g2', 'g1'])
    expect(ids(reorderGroup(base(), 'g1', 'g2'))).toEqual(['g1', 'g2'])
  })

  it('reordering onto itself is a no-op', () => {
    expect(reorderGroup(base(), 'g1', 'g1')).toEqual(base())
  })

  it('reordering onto an unknown target appends at the end', () => {
    expect(ids(reorderGroup(base(), 'g1', 'nope'))).toEqual(['g2', 'g1'])
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

  it('clears purged paths out of ungroupedOrder', () => {
    const l = { ...base(), ungroupedOrder: ['/a', '/b', '/e'] }
    const purged = purgePaths(l, ['/a', '/b'])
    expect(purged.ungroupedOrder).toEqual(['/e'])
  })
})
