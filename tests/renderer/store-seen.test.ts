import { describe, it, expect, beforeEach } from 'vitest'
import { deriveDot } from '../../src/shared/agent-status'
import { loadSeenAt, saveSeenAt } from '../../src/renderer/state/seen'

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
