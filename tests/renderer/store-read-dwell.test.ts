import { describe, it, expect, beforeEach, vi } from 'vitest'
import type { Worktree } from '@shared/ipc-types'

const stored: Record<string, string> = {}
;(globalThis as any).localStorage = {
  getItem: (k: string) => stored[k] ?? null,
  setItem: (k: string, v: string) => { stored[k] = v }
}

const { useStore, READ_DWELL_MS } = await import('../../src/renderer/state/store')

const wt = (path: string): Worktree =>
  ({ path, branch: path.slice(1), head: 'abc1234', isMain: false, repoName: 'repo' })

beforeEach(() => {
  vi.useFakeTimers()
  useStore.setState({
    worktrees: ['/a', '/b'].map(wt), seenAt: {}, unread: { '/a': true }, selected: undefined
  })
})

const state = () => useStore.getState()

describe('a worktree is only marked read after dwelling on it', () => {
  it('selects immediately, so the UI never lags behind the keypress', () => {
    state().select('/a')
    expect(state().selected).toBe('/a')
    expect(state().unread['/a']).toBe(true)
    expect(state().seenAt['/a']).toBeUndefined()
  })

  it('clears the unread mark once the dwell elapses', () => {
    state().select('/a')
    vi.advanceTimersByTime(READ_DWELL_MS)
    expect(state().unread['/a']).toBeUndefined()
    expect(state().seenAt['/a']).toBeGreaterThan(0)
  })

  it('leaves it unread when passed through on the way somewhere else', () => {
    state().select('/a')
    vi.advanceTimersByTime(READ_DWELL_MS - 1)
    state().select('/b')
    vi.advanceTimersByTime(READ_DWELL_MS)
    // /a was never dwelt on, so its mark survives; /b, landed on, is read.
    expect(state().unread['/a']).toBe(true)
    expect(state().seenAt['/a']).toBeUndefined()
    expect(state().seenAt['/b']).toBeGreaterThan(0)
  })

  it('restarts the clock on a switch away and back', () => {
    state().select('/a')
    vi.advanceTimersByTime(READ_DWELL_MS - 1)
    state().select('/b')
    state().select('/a')
    vi.advanceTimersByTime(READ_DWELL_MS - 1)
    expect(state().unread['/a']).toBe(true)
    vi.advanceTimersByTime(1)
    expect(state().unread['/a']).toBeUndefined()
  })

  it('does not mark a worktree read from a stale timer after moving on', () => {
    state().select('/a')
    state().select('/b')
    vi.advanceTimersByTime(READ_DWELL_MS * 2)
    expect(state().seenAt['/a']).toBeUndefined()
  })
})
