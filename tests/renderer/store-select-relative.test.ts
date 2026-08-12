import { describe, it, expect, beforeEach } from 'vitest'
import type { Layout, Worktree } from '@shared/ipc-types'

// store.ts's `select` persists to localStorage, which doesn't exist in the node
// test environment. A minimal in-memory stand-in is enough: these tests care about
// which worktree ends up selected, not about persistence.
const store: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => store[k] ?? null,
  setItem: (k: string, v: string) => { store[k] = v }
}

const { useStore } = await import('../../src/renderer/state/store')

const wt = (path: string, repoName = 'repo'): Worktree =>
  ({ path, branch: path.slice(1), head: 'abc1234', isMain: false, repoName })

const seed = (paths: string[], selected?: string, layout?: Partial<Layout>) =>
  useStore.setState({
    worktrees: paths.map(p => wt(p)),
    repos: ['/code/repo'],
    layout: { groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {}, ...layout },
    selected, modalOpen: 0, openDiff: null
  })

const selectedPath = () => useStore.getState().selected

describe('selectRelative', () => {
  beforeEach(() => seed(['/a', '/b', '/c'], '/b'))

  it('selects the next worktree', () => {
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
  })

  it('selects the previous worktree', () => {
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/a')
  })

  it('wraps forward from the last worktree to the first', () => {
    seed(['/a', '/b', '/c'], '/c')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })

  it('wraps backward from the first worktree to the last', () => {
    seed(['/a', '/b', '/c'], '/a')
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/c')
  })

  it('does nothing when there are no worktrees', () => {
    seed([], undefined)
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBeUndefined()
  })

  it('selects the first worktree when nothing is selected and moving forward', () => {
    seed(['/a', '/b', '/c'], undefined)
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })

  it('selects the last worktree when nothing is selected and moving backward', () => {
    seed(['/a', '/b', '/c'], undefined)
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/c')
  })

  it('treats a selection that is no longer in the list as no selection', () => {
    // refreshWorktreeList polls every 3s, so `selected` can briefly name a
    // worktree that has since been removed.
    seed(['/a', '/b', '/c'], '/removed')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
  })

  it('re-selects the only worktree in both directions', () => {
    seed(['/a'], '/a')
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/a')
    useStore.getState().selectRelative(-1)
    expect(selectedPath()).toBe('/a')
  })

  it('does nothing while a modal is open', () => {
    useStore.setState({ modalOpen: 1 })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })

  it('does nothing while the diff modal is open', () => {
    useStore.setState({
      openDiff: { key: '/a.ts:s', path: 'a.ts', staged: true, untracked: false, committed: false }
    })
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')
  })
})

describe('pushModal / popModal', () => {
  beforeEach(() => seed(['/a', '/b', '/c'], '/b'))

  it('keeps navigation blocked until the last of two nested modals closes', () => {
    const { pushModal, popModal } = useStore.getState()
    pushModal()
    pushModal()
    popModal()

    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/b')

    popModal()
    useStore.getState().selectRelative(1)
    expect(selectedPath()).toBe('/c')
  })
})

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
