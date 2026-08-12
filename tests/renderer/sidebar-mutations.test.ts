import { describe, it, expect } from 'vitest'
import type { Layout, Worktree } from '../../src/shared/ipc-types'
import {
  addGroup, deleteGroup, deriveSections, moveTo, newGroupId, purgePaths, renameGroup,
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

  it('moving to a repo target removes the path from every group and from hidden', () => {
    const l = moveTo(base(), '/a', { kind: 'repo' })
    expect(pathsOf(l, 'g1')).toEqual(['/b'])
    expect(l.hidden).toEqual(['/d'])
    const h = moveTo(base(), '/d', { kind: 'repo' })
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
    const l: Layout = { groups: [{ id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/b', '/c', '/d'] }], hidden: [], hiddenCollapsed: true }
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
    const l: Layout = { groups: [{ id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/ghost', '/b'] }], hidden: [], hiddenCollapsed: true }
    const dropped = moveTo(l, '/b', { kind: 'group', id: 'g1' }, { kind: 'after', path: '/a' })
    expect(pathsOf(dropped, 'g1')).toEqual(['/a', '/b', '/ghost'])
  })

  it('a drop rendered onto a ghost-adjacent row still lands next to the right live worktree', () => {
    // Sidebar.tsx only ever anchors on paths it actually rendered, i.e. paths
    // with a live worktree — this simulates dragging /d onto /b (rendered after
    // the ghost) and dropping below it.
    const l: Layout = { groups: [{ id: 'g1', name: 'One', collapsed: false, paths: ['/a', '/ghost', '/b'] }], hidden: [], hiddenCollapsed: true }
    const worktrees = [w('/a'), w('/b'), w('/d')]
    const before = deriveSections(l, worktrees, [])
    expect(before[0].worktrees.map(x => x.path)).toEqual(['/a', '/b'])
    const dropped = moveTo(l, '/d', { kind: 'group', id: 'g1' }, { kind: 'after', path: '/b' })
    expect(pathsOf(dropped, 'g1')).toEqual(['/a', '/ghost', '/b', '/d'])
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
})
