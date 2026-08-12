import { describe, it, expect } from 'vitest'
import type { Layout, Worktree } from '../../src/shared/ipc-types'
import { deriveSections, navOrder } from '../../src/renderer/components/sidebar-layout'

const wt = (path: string, repoName: string): Worktree =>
  ({ path, branch: path.slice(1), head: 'abc1234', isMain: false, repoName })

const worktrees = [wt('/r1/a', 'r1'), wt('/r1/b', 'r1'), wt('/r2/c', 'r2')]
const repos = ['/code/r1', '/code/r2']
const layout = (over: Partial<Layout> = {}): Layout =>
  ({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {}, ...over })

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

  it('orders a repo section by repoOrder before falling back to git order', () => {
    const s = deriveSections(layout({ repoOrder: { '/code/r1': ['/r1/b', '/r1/a'] } }), worktrees, repos)
    expect(paths(s[0])).toEqual(['/r1/b', '/r1/a'])
  })

  it('appends a worktree absent from repoOrder last, in git order', () => {
    const s = deriveSections(layout({ repoOrder: { '/code/r1': ['/r1/b'] } }), worktrees, repos)
    expect(paths(s[0])).toEqual(['/r1/b', '/r1/a'])
  })

  it('skips a ghost path in repoOrder that has no live worktree', () => {
    const s = deriveSections(layout({ repoOrder: { '/code/r1': ['/r1/ghost', '/r1/b', '/r1/a'] } }), worktrees, repos)
    expect(paths(s[0])).toEqual(['/r1/b', '/r1/a'])
  })

  it('never renders a grouped path in its repo section even if repoOrder still lists it', () => {
    const s = deriveSections(layout({
      groups: [{ id: 'g1', name: 'Active', collapsed: false, paths: ['/r1/a'] }],
      repoOrder: { '/code/r1': ['/r1/a', '/r1/b'] }
    }), worktrees, repos)
    expect(paths(s[1])).toEqual(['/r1/b'])
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
