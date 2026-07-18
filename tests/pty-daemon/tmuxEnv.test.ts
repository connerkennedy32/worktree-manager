import { describe, it, expect } from 'vitest'
import { parseUpdateEnvironment, mergeUpdateEnvironment } from '../../src/main/pty-daemon/tmuxEnv'

describe('parseUpdateEnvironment', () => {
  it('parses one name per indexed line', () => {
    const raw = [
      'update-environment[0] DISPLAY',
      'update-environment[1] SSH_AUTH_SOCK',
      'update-environment[2] WTM_TERMINAL_ID'
    ].join('\n')
    expect(parseUpdateEnvironment(raw)).toEqual(['DISPLAY', 'SSH_AUTH_SOCK', 'WTM_TERMINAL_ID'])
  })

  it('returns nothing for empty output', () => {
    expect(parseUpdateEnvironment('')).toEqual([])
  })

  it('ignores blank lines and unrelated output', () => {
    expect(parseUpdateEnvironment('\nupdate-environment[0] DISPLAY\n\n')).toEqual(['DISPLAY'])
  })
})

describe('mergeUpdateEnvironment', () => {
  it('appends missing names, preserving existing order', () => {
    expect(mergeUpdateEnvironment(['DISPLAY', 'SSH_AUTH_SOCK'], ['WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET']))
      .toEqual(['DISPLAY', 'SSH_AUTH_SOCK', 'WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET'])
  })

  it('is idempotent: does not duplicate names already present', () => {
    expect(mergeUpdateEnvironment(['DISPLAY', 'WTM_TERMINAL_ID'], ['WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET']))
      .toEqual(['DISPLAY', 'WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET'])
  })

  it('does not mutate its input', () => {
    const current = ['DISPLAY']
    mergeUpdateEnvironment(current, ['WTM_TERMINAL_ID'])
    expect(current).toEqual(['DISPLAY'])
  })

  it('returns the current list unchanged when there is nothing to add', () => {
    expect(mergeUpdateEnvironment(['WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET'], ['WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET']))
      .toEqual(['WTM_TERMINAL_ID', 'WTM_HOOK_SOCKET'])
  })
})
