import { describe, it, expect } from 'vitest'
import { mapHookEvent, deriveDot } from '../../src/shared/agent-status'

describe('mapHookEvent', () => {
  it('maps a submitted prompt to working', () => {
    expect(mapHookEvent('UserPromptSubmit')).toBe('working')
  })

  it('keeps a long multi-tool turn working', () => {
    expect(mapHookEvent('PostToolUse')).toBe('working')
  })

  it('treats a failed tool call as still working, since the turn continues', () => {
    expect(mapHookEvent('PostToolUseFailure')).toBe('working')
  })

  it('maps a permission prompt to permission', () => {
    expect(mapHookEvent('PermissionRequest')).toBe('permission')
  })

  it('maps a finished turn to done', () => {
    expect(mapHookEvent('Stop')).toBe('done')
  })

  it('maps an API-error turn end to failed', () => {
    expect(mapHookEvent('StopFailure')).toBe('failed')
  })

  it('maps session end to none', () => {
    expect(mapHookEvent('SessionEnd')).toBe('none')
  })

  it('ignores SessionStart, which fires while the agent is still idle', () => {
    expect(mapHookEvent('SessionStart')).toBeNull()
  })

  it('ignores unknown events rather than guessing', () => {
    expect(mapHookEvent('PreCompact')).toBeNull()
    expect(mapHookEvent('')).toBeNull()
    expect(mapHookEvent('Stop ; rm -rf /')).toBeNull()
  })
})

describe('deriveDot', () => {
  it('shows nothing when there is no report', () => {
    expect(deriveDot(undefined, undefined)).toBeNull()
  })

  it('shows nothing for none', () => {
    expect(deriveDot({ status: 'none', at: 100 }, undefined)).toBeNull()
  })

  it('shows working', () => {
    expect(deriveDot({ status: 'working', at: 100 }, undefined)).toBe('working')
  })

  it('shows permission', () => {
    expect(deriveDot({ status: 'permission', at: 100 }, undefined)).toBe('permission')
  })

  it('shows failed', () => {
    expect(deriveDot({ status: 'failed', at: 100 }, undefined)).toBe('failed')
  })

  it('shows done when the turn finished and the tab was never visited', () => {
    expect(deriveDot({ status: 'done', at: 100 }, undefined)).toBe('done')
  })

  it('shows done when the turn finished after the last visit', () => {
    expect(deriveDot({ status: 'done', at: 200 }, 100)).toBe('done')
  })

  it('clears done once the tab has been visited since it finished', () => {
    expect(deriveDot({ status: 'done', at: 100 }, 200)).toBeNull()
  })

  it('clears done when visit and finish collide, preferring the quieter result', () => {
    expect(deriveDot({ status: 'done', at: 100 }, 100)).toBeNull()
  })

  it('does not seen-gate permission: visiting does not answer the prompt', () => {
    expect(deriveDot({ status: 'permission', at: 100 }, 999)).toBe('permission')
  })

  it('does not seen-gate failed: visiting does not fix the error', () => {
    expect(deriveDot({ status: 'failed', at: 100 }, 999)).toBe('failed')
  })

  it('does not seen-gate working', () => {
    expect(deriveDot({ status: 'working', at: 100 }, 999)).toBe('working')
  })
})
