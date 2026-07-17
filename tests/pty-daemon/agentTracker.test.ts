import { describe, it, expect } from 'vitest'
import { AgentTracker } from '../../src/main/pty-daemon/agentTracker'
import type { AgentReport } from '../../src/shared/agent-status'

const WITH_AGENT = ['  PID  PPID COMM', '100 1 /bin/zsh', '200 100 claude'].join('\n')
const NO_AGENT = ['  PID  PPID COMM', '100 1 /bin/zsh'].join('\n')

const sessions = (paths = ['/wt/a']) => ({
  list: () => paths,
  pid: (p: string) => (paths.includes(p) ? 100 : undefined),
  pathForId: (id: string) => (id === 'id-a' ? '/wt/a' : undefined)
})

function make(table = WITH_AGENT, paths = ['/wt/a']) {
  const seen: [string, AgentReport][] = []
  let clock = 1000
  const tracker = new AgentTracker(
    sessions(paths),
    (p, r) => seen.push([p, r]),
    async () => table,
    () => clock
  )
  return { tracker, seen, tick: (ms: number) => { clock += ms } }
}

describe('handleHook', () => {
  it('maps an event onto the right worktree and emits', () => {
    const { tracker, seen } = make()
    tracker.handleHook('id-a', 'UserPromptSubmit')
    expect(seen).toEqual([['/wt/a', { status: 'working', at: 1000 }]])
  })

  it('ignores an unknown terminal id', () => {
    const { tracker, seen } = make()
    tracker.handleHook('bogus-id', 'Stop')
    expect(seen).toEqual([])
  })

  it('ignores an event that carries no status', () => {
    const { tracker, seen } = make()
    tracker.handleHook('id-a', 'SessionStart')
    expect(seen).toEqual([])
    expect(tracker.snapshot()).toEqual({})
  })

  it('re-emits Stop even though the status is unchanged, because `at` moved', () => {
    const { tracker, seen, tick } = make()
    tracker.handleHook('id-a', 'Stop')
    tick(50)
    tracker.handleHook('id-a', 'Stop')
    expect(seen).toHaveLength(2)
    expect(seen[1][1].at).toBe(1050)
  })

  it('walks a full turn: prompt -> tool -> permission -> stop', () => {
    const { tracker, seen } = make()
    tracker.handleHook('id-a', 'UserPromptSubmit')
    tracker.handleHook('id-a', 'PostToolUse')
    tracker.handleHook('id-a', 'PermissionRequest')
    tracker.handleHook('id-a', 'Stop')
    expect(seen.map(([, r]) => r.status)).toEqual(['working', 'working', 'permission', 'done'])
  })

  it('records StopFailure as failed', () => {
    const { tracker } = make()
    tracker.handleHook('id-a', 'StopFailure')
    expect(tracker.snapshot()['/wt/a'].status).toBe('failed')
  })
})

describe('sweep', () => {
  it('does not run ps when nothing is active', async () => {
    let calls = 0
    const tracker = new AgentTracker(
      sessions(), () => {}, async () => { calls++; return WITH_AGENT }, () => 1000
    )
    await tracker.sweep()
    expect(calls).toBe(0)
  })

  it('leaves a working status alone while claude is alive', async () => {
    const { tracker, seen } = make(WITH_AGENT)
    tracker.handleHook('id-a', 'UserPromptSubmit')
    await tracker.sweep()
    expect(seen).toHaveLength(1)
    expect(tracker.snapshot()['/wt/a'].status).toBe('working')
  })

  it('clears a stale working status when claude is gone', async () => {
    const { tracker, seen } = make(NO_AGENT)
    tracker.handleHook('id-a', 'UserPromptSubmit')
    await tracker.sweep()
    expect(seen[1]).toEqual(['/wt/a', { status: 'none', at: 1000 }])
    expect(tracker.snapshot()['/wt/a']).toBeUndefined()
  })

  it('never sets a positive status: a dead-to-alive flip does not emit', async () => {
    const { tracker, seen } = make(WITH_AGENT)
    await tracker.sweep()
    expect(seen).toEqual([])
  })

  it('survives a failing ps without throwing or losing state', async () => {
    const seen: [string, AgentReport][] = []
    const tracker = new AgentTracker(
      sessions(), (p, r) => seen.push([p, r]), async () => { throw new Error('ps exploded') }, () => 1000
    )
    tracker.handleHook('id-a', 'UserPromptSubmit')
    await expect(tracker.sweep()).resolves.toBeUndefined()
    expect(tracker.snapshot()['/wt/a'].status).toBe('working')
  })

  it('drops a status whose pty has exited', async () => {
    const seen: [string, AgentReport][] = []
    let paths = ['/wt/a']
    const tracker = new AgentTracker(
      { list: () => paths, pid: () => 100, pathForId: () => '/wt/a' },
      (p, r) => seen.push([p, r]),
      async () => WITH_AGENT,
      () => 1000
    )
    tracker.handleHook('id-a', 'UserPromptSubmit')
    paths = []
    await tracker.sweep()
    expect(tracker.snapshot()).toEqual({})
    expect(seen[1][1].status).toBe('none')
  })
})
