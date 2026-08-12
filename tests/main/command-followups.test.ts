import { describe, it, expect } from 'vitest'
import { resolveFollowUps } from '../../src/main/command-followups'
import type { RepoCommand } from '../../src/shared/ipc-types'

const base: RepoCommand = { label: 'New worktree', run: 'git worktree add x' }
const vars = { name: 'roo-1234-fix', repo: '/code/app', worktree: '/code/app' }

describe('resolveFollowUps', () => {
  it('is empty when the command declares neither field', () => {
    expect(resolveFollowUps(base, '/code/app', vars)).toEqual({})
  })

  it('resolves a relative select against the cwd', () => {
    const out = resolveFollowUps({ ...base, select: '../.worktrees/{{name}}' }, '/code/app', vars)
    expect(out.select).toBe('/code/.worktrees/roo-1234-fix')
  })

  it('leaves an absolute select absolute', () => {
    const out = resolveFollowUps({ ...base, select: '/tmp/{{name}}' }, '/code/app', vars)
    expect(out.select).toBe('/tmp/roo-1234-fix')
  })

  it('substitutes terminal lines literally in non-shell mode', () => {
    const out = resolveFollowUps(
      { ...base, terminal: ['tmux new -s {{name}} \\; send-keys \'cc "{{name}} solve this"\' Enter'] },
      '/code/app', vars
    )
    expect(out.terminal).toEqual([
      'tmux new -s roo-1234-fix \\; send-keys \'cc "roo-1234-fix solve this"\' Enter'
    ])
  })

  it('shell-quotes terminal lines when the command is shell mode', () => {
    const out = resolveFollowUps(
      { ...base, shell: true, terminal: ['cc {{name}}'] }, '/code/app', { name: "it's" }
    )
    expect(out.terminal).toEqual([`cc 'it'\\''s'`])
  })

  it('resolves an unknown placeholder to empty rather than leaving it literal', () => {
    const out = resolveFollowUps({ ...base, terminal: ['cc {{nope}}'] }, '/code/app', vars)
    expect(out.terminal).toEqual(['cc '])
  })
})
