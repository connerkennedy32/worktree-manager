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

  // A newline in a value would end the typed command at the tty and run the
  // rest of it as the next command.
  it('collapses a newline in a value in non-shell mode', () => {
    const out = resolveFollowUps(
      { ...base, terminal: ['cc "{{message}}"'] }, '/code/app', { message: 'fix\nrm -rf /' }
    )
    expect(out.terminal).toEqual(['cc "fix rm -rf /"'])
  })

  it('collapses a CRLF in a value in non-shell mode', () => {
    const out = resolveFollowUps(
      { ...base, terminal: ['cc "{{message}}"'] }, '/code/app', { message: 'fix\r\nrm -rf /' }
    )
    expect(out.terminal).toEqual(['cc "fix rm -rf /"'])
  })

  it('collapses a newline in a value in shell mode', () => {
    const out = resolveFollowUps(
      { ...base, shell: true, terminal: ['cc {{message}}'] }, '/code/app', { message: 'fix\nrm -rf /' }
    )
    expect(out.terminal).toEqual(["cc 'fix rm -rf /'"])
  })

  it('collapses a CRLF in a value in shell mode', () => {
    const out = resolveFollowUps(
      { ...base, shell: true, terminal: ['cc {{message}}'] }, '/code/app', { message: 'fix\r\nrm -rf /' }
    )
    expect(out.terminal).toEqual(["cc 'fix rm -rf /'"])
  })

  it('resolves an unknown placeholder to empty rather than leaving it literal', () => {
    const out = resolveFollowUps({ ...base, terminal: ['cc {{nope}}'] }, '/code/app', vars)
    expect(out.terminal).toEqual(['cc '])
  })
})

describe('the kickoff prompt', () => {
  it('reaches a terminal line quoted, so a sentence stays one argument', () => {
    const command = {
      label: 'Create worktree (task)',
      run: 'pnpm use-worktree {{branch}}',
      shell: true,
      terminal: ['tmux new -c ~/Code/wt-{{branch}} \; send-keys \'cc -- "{{prompt}}"\' Enter']
    }
    const out = resolveFollowUps(command, '/repo', {
      branch: 'ck/retry', prompt: "look at the retry limits; don't change the API"
    })
    // Adjacent quoted strings concatenate in sh, so the template's own quotes
    // and the quoting applied to the value compose rather than nest.
    expect(out.terminal?.[0]).toBe(
      String.raw`tmux new -c ~/Code/wt-'ck/retry' ; send-keys 'cc -- "'look at the retry limits; don'\''t change the API'"' Enter`
    )
  })

  it('leaves empty quotes when no kickoff was typed', () => {
    const out = resolveFollowUps(
      { label: 'x', run: 'y', shell: true, terminal: ['send-keys \'cc -- "{{prompt}}"\' Enter'] },
      '/repo', { prompt: '' })
    // Nothing between the quotes, which is what `cc -- ""` amounts to.
    expect(out.terminal?.[0]).toBe(String.raw`send-keys 'cc -- "''"' Enter`)
  })
})
