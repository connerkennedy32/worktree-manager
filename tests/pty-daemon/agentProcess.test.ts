import { describe, it, expect } from 'vitest'
import {
  parseProcessTable, isAgentComm, hasAgentDescendant
} from '../../src/main/pty-daemon/agentProcess'

const PS_SAMPLE = [
  '  PID  PPID COMM',
  '    1     0 /sbin/launchd',
  '11275 54626 -zsh',
  '15820 11275 claude',
  '22867 22772 claude bg-pty-host',
  '54405 54052 /Users/connerkennedy/.local/bin/claude',
  '77291     1 /Users/connerkennedy/.local/share/claude/versions/2.1.201'
].join('\n')

describe('parseProcessTable', () => {
  it('skips the header row', () => {
    expect(parseProcessTable(PS_SAMPLE).some(e => e.comm === 'COMM')).toBe(false)
  })

  it('parses pid and ppid as numbers', () => {
    expect(parseProcessTable(PS_SAMPLE).find(e => e.pid === 15820))
      .toEqual({ pid: 15820, ppid: 11275, comm: 'claude' })
  })

  it('keeps a comm containing spaces intact', () => {
    expect(parseProcessTable(PS_SAMPLE).find(e => e.pid === 22867)!.comm).toBe('claude bg-pty-host')
  })

  it('keeps an absolute-path comm intact', () => {
    expect(parseProcessTable(PS_SAMPLE).find(e => e.pid === 54405)!.comm)
      .toBe('/Users/connerkennedy/.local/bin/claude')
  })

  it('ignores blank lines', () => {
    expect(parseProcessTable('  PID  PPID COMM\n\n15820 11275 claude\n')).toHaveLength(1)
  })

  it('returns nothing for empty input', () => {
    expect(parseProcessTable('')).toEqual([])
  })
})

describe('isAgentComm', () => {
  it('matches a bare claude', () => {
    expect(isAgentComm('claude')).toBe(true)
  })

  it('matches an absolute path to claude', () => {
    expect(isAgentComm('/Users/connerkennedy/.local/bin/claude')).toBe(true)
  })

  it('matches claude with trailing argv words', () => {
    expect(isAgentComm('claude bg-pty-host')).toBe(true)
  })

  it('does not match the versioned daemon binary', () => {
    expect(isAgentComm('/Users/connerkennedy/.local/share/claude/versions/2.1.201')).toBe(false)
  })

  it('does not match a shell', () => {
    expect(isAgentComm('-zsh')).toBe(false)
  })

  it('does not match a command that merely contains claude', () => {
    expect(isAgentComm('claudette')).toBe(false)
    expect(isAgentComm('/usr/bin/notclaude')).toBe(false)
  })
})

describe('hasAgentDescendant', () => {
  const tree = [
    { pid: 1, ppid: 0, comm: '/sbin/launchd' },
    { pid: 100, ppid: 1, comm: '/bin/zsh' },
    { pid: 200, ppid: 100, comm: 'claude' },
    { pid: 300, ppid: 1, comm: '/bin/zsh' },
    { pid: 400, ppid: 300, comm: 'vim' }
  ]

  it('finds a direct claude child', () => {
    expect(hasAgentDescendant(tree, 100)).toBe(true)
  })

  it('finds a claude nested under an intermediate process', () => {
    expect(hasAgentDescendant([
      { pid: 100, ppid: 1, comm: '/bin/zsh' },
      { pid: 150, ppid: 100, comm: 'npm' },
      { pid: 200, ppid: 150, comm: 'claude' }
    ], 100)).toBe(true)
  })

  it('does not see claude in a sibling subtree', () => {
    expect(hasAgentDescendant(tree, 300)).toBe(false)
  })

  it('returns false for an unknown pid', () => {
    expect(hasAgentDescendant(tree, 999)).toBe(false)
  })

  it('ignores the daemon subtree reparented to launchd', () => {
    expect(hasAgentDescendant([
      { pid: 100, ppid: 1, comm: '/bin/zsh' },
      { pid: 900, ppid: 1, comm: 'claude bg-pty-host' }
    ], 100)).toBe(false)
  })

  it('terminates on a cyclic parent chain', () => {
    expect(hasAgentDescendant([
      { pid: 10, ppid: 11, comm: 'a' },
      { pid: 11, ppid: 10, comm: 'b' }
    ], 10)).toBe(false)
  })
})
