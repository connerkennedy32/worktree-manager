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
