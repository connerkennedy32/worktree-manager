import { describe, it, expect, beforeEach } from 'vitest'
import { deriveDot } from '../../src/shared/agent-status'
import { loadSeenAt, loadUnread, saveSeenAt, saveUnread } from '../../src/renderer/state/seen'

beforeEach(() => {
  const store: Record<string, string> = {}
  ;(globalThis as any).localStorage = {
    getItem: (k: string) => store[k] ?? null,
    setItem: (k: string, v: string) => { store[k] = v }
  }
})

describe('seenAt persistence', () => {
  it('round-trips through localStorage', () => {
    saveSeenAt({ '/wt/a': 123 })
    expect(loadSeenAt()).toEqual({ '/wt/a': 123 })
  })

  it('returns empty when nothing was stored', () => {
    expect(loadSeenAt()).toEqual({})
  })

  it('returns empty rather than throwing on corrupt storage', () => {
    localStorage.setItem('wtm.seenAt', '{ not json')
    expect(loadSeenAt()).toEqual({})
  })

  it('drives the dot: visiting a worktree clears its finished dot', () => {
    const report = { status: 'done' as const, at: 100 }
    expect(deriveDot(report, loadSeenAt()['/wt/a'])).toBe('done')
    saveSeenAt({ '/wt/a': 200 })
    expect(deriveDot(report, loadSeenAt()['/wt/a'])).toBeNull()
  })
})

describe('manual unread persistence', () => {
  it('round-trips through localStorage', () => {
    saveUnread({ '/wt/a': true })
    expect(loadUnread()).toEqual({ '/wt/a': true })
  })

  it('does not persist a cleared mark', () => {
    saveUnread({ '/wt/a': true, '/wt/b': false })
    expect(loadUnread()).toEqual({ '/wt/a': true })
  })

  it('returns empty when nothing was stored', () => {
    expect(loadUnread()).toEqual({})
  })

  it('returns empty rather than throwing on corrupt storage', () => {
    localStorage.setItem('wtm.unread', '{ not json')
    expect(loadUnread()).toEqual({})
    localStorage.setItem('wtm.unread', '{"not":"an array"}')
    expect(loadUnread()).toEqual({})
  })

  it('drives the dot on a worktree with no agent report at all', () => {
    saveUnread({ '/wt/a': true })
    expect(deriveDot(undefined, undefined, loadUnread()['/wt/a'])).toBe('done')
  })
})
