import { describe, it, expect } from 'vitest'
import {
  tokenize, promptVars, placeholders, substitute, substituteShell, parseCommandsFile,
  exampleCommandsFile
} from '../../src/shared/repo-commands'
import { isCommandGroup } from '../../src/shared/ipc-types'

describe('substituteShell', () => {
  it('leaves shell operators in the script intact', () => {
    expect(substituteShell('caffeinate -d & open -a ScreenSaverEngine', {}))
      .toBe('caffeinate -d & open -a ScreenSaverEngine')
  })

  it('quotes substituted values so spaces stay one argument', () => {
    expect(substituteShell('git commit -m {{message}}', { message: 'fix the thing' }))
      .toBe("git commit -m 'fix the thing'")
  })

  it('neutralises shell metacharacters inside a value', () => {
    expect(substituteShell('echo {{message}}', { message: '$(rm -rf /); `x`' }))
      .toBe("echo '$(rm -rf /); `x`'")
  })

  it('escapes embedded single quotes', () => {
    expect(substituteShell('echo {{message}}', { message: "it's" })).toBe("echo 'it'\\''s'")
  })

  it('renders an unknown placeholder as an empty argument, not nothing', () => {
    expect(substituteShell('echo {{nope}}', {})).toBe("echo ''")
  })
})

describe('tokenize', () => {
  it('splits on whitespace', () => {
    expect(tokenize('pnpm use-worktree foo')).toEqual(['pnpm', 'use-worktree', 'foo'])
  })

  it('collapses repeated whitespace instead of emitting empty arguments', () => {
    expect(tokenize('  gt   create  ')).toEqual(['gt', 'create'])
  })

  it('keeps a quoted run as one token, quotes stripped', () => {
    expect(tokenize('gt create -m "a message here"'))
      .toEqual(['gt', 'create', '-m', 'a message here'])
  })

  it('handles single quotes and quotes inside a token', () => {
    expect(tokenize("git commit -m 'it works'")).toEqual(['git', 'commit', '-m', 'it works'])
    expect(tokenize('--flag="with space"')).toEqual(['--flag=with space'])
  })

  it('keeps a deliberately empty quoted argument', () => {
    expect(tokenize('cmd ""')).toEqual(['cmd', ''])
  })
})

describe('promptVars', () => {
  it('finds the placeholder that is not filled in from context', () => {
    expect(promptVars('pnpm use-worktree {{name}}')).toEqual(['name'])
  })

  it.each(['branch', 'worktree', 'worktreeName', 'repo', 'message'])(
    'treats {{%s}} as implicit', v => {
      expect(promptVars(`cmd {{${v}}}`)).toEqual([])
    })

  // The example create-worktree command prompts for {{name}}; {{worktreeName}}
  // being implicit must not swallow it.
  it('still prompts for {{name}}', () => {
    expect(promptVars('git worktree add -b {{name}} {{worktreeName}}')).toEqual(['name'])
  })

  it('returns nothing to ask for when the command has no placeholders', () => {
    expect(promptVars('bash tooling/ci-defense/pre-pr-gate.sh')).toEqual([])
  })

  it('returns every placeholder, in the order they appear', () => {
    expect(promptVars('cmd {{second}} {{first}}')).toEqual(['second', 'first'])
  })

  it('asks once for a placeholder used twice', () => {
    expect(promptVars('cmd {{name}} --also {{name}}')).toEqual(['name'])
  })

  it('separates the ones it asks for from the implicit ones', () => {
    expect(promptVars('deploy {{name}} {{branch}} {{name2}} {{repo}}'))
      .toEqual(['name', 'name2'])
  })

  it('tolerates inner whitespace', () => {
    expect(promptVars('cmd {{ name }}')).toEqual(['name'])
  })
})

describe('placeholders', () => {
  it('splits the ones filled in from context from the ones asked for', () => {
    expect(placeholders('deploy {{name}} --on {{branch}} --from {{repo}}'))
      .toEqual({ auto: ['branch', 'repo'], ask: ['name'] })
  })

  it('reports nothing for a command with no placeholders', () => {
    expect(placeholders('bash gate.sh')).toEqual({ auto: [], ask: [] })
  })

  it('lists each name once, in first-appearance order', () => {
    expect(placeholders('{{repo}} {{branch}} {{repo}}')).toEqual({ auto: ['repo', 'branch'], ask: [] })
  })
})

describe('substitute', () => {
  it('fills placeholders from the supplied values', () => {
    expect(substitute(['gt', 'create', '{{branch}}'], { branch: 'feat-x' }))
      .toEqual(['gt', 'create', 'feat-x'])
  })

  // The reason tokenizing happens first: a message is one argument, not five.
  it('keeps a value containing spaces as a single argument', () => {
    const tokens = tokenize('git commit -m "{{message}}"')
    expect(substitute(tokens, { message: 'fix the thing (BONES-1)' }))
      .toEqual(['git', 'commit', '-m', 'fix the thing (BONES-1)'])
  })

  it('resolves an unknown placeholder to empty rather than leaving it literal', () => {
    expect(substitute(['cmd', '{{nope}}'], {})).toEqual(['cmd', ''])
  })

  it('substitutes every occurrence', () => {
    expect(substitute(['{{a}}-{{a}}'], { a: 'x' })).toEqual(['x-x'])
  })

  it('fills several distinct placeholders across tokens', () => {
    const tokens = tokenize('deploy {{name}} --to {{name2}} --on {{branch}}')
    expect(substitute(tokens, { name: 'api', name2: 'staging', branch: 'feat-x' }))
      .toEqual(['deploy', 'api', '--to', 'staging', '--on', 'feat-x'])
  })
})

describe('parseCommandsFile', () => {
  const valid = { label: 'Gate', run: 'bash gate.sh' }

  it('reads commands keyed by repo path', () => {
    expect(parseCommandsFile({ '/repo': [valid] })).toEqual({ '/repo': [valid] })
  })

  it('keeps a shell command', () => {
    const cmd = { label: 'Screensaver', run: 'caffeinate -d & open -a X', shell: true }
    expect(parseCommandsFile({ '/repo': [cmd] })).toEqual({ '/repo': [cmd] })
  })

  it('ignores // comment keys', () => {
    const parsed = parseCommandsFile({ '// notes': ['anything'], '/repo': [valid] })
    expect(Object.keys(parsed)).toEqual(['/repo'])
  })

  it.each([
    ['a missing label', { run: 'x' }],
    ['a blank label', { label: '  ', run: 'x' }],
    ['a missing run', { label: 'x' }],
    ['an unknown cwd', { label: 'x', run: 'y', cwd: 'elsewhere' }],
    ['a non-boolean shell', { label: 'x', run: 'y', shell: 'true' }],
    ['an unknown width', { label: 'x', run: 'y', width: 'wide' }],
    ['a non-object', 'just a string']
  ])('drops an entry with %s but keeps its siblings', (_case, bad) => {
    expect(parseCommandsFile({ '/repo': [bad, valid] })).toEqual({ '/repo': [valid] })
  })

  it('keeps a full-width command', () => {
    const cmd = { label: 'Push branch', run: 'git push', width: 'full' }
    expect(parseCommandsFile({ '/repo': [cmd] })).toEqual({ '/repo': [cmd] })
  })

  it('reads a group of commands', () => {
    const group = { label: 'Deploys', commands: [valid], open: true }
    expect(parseCommandsFile({ '/repo': [group] })).toEqual({ '/repo': [group] })
  })

  it('keeps groups and loose commands in the order written', () => {
    const group = { label: 'Deploys', commands: [valid] }
    const entries = parseCommandsFile({ '/repo': [valid, group] })['/repo']
    expect(entries.map(isCommandGroup)).toEqual([false, true])
  })

  it('omits open when the group does not set it, leaving the default to the UI', () => {
    expect(parseCommandsFile({ '/repo': [{ label: 'G', commands: [valid] }] })['/repo'][0])
      .toEqual({ label: 'G', commands: [valid] })
  })

  it('drops a bad command inside a group but keeps the group', () => {
    const parsed = parseCommandsFile({ '/repo': [{ label: 'G', commands: [{ run: 'x' }, valid] }] })
    expect(parsed).toEqual({ '/repo': [{ label: 'G', commands: [valid] }] })
  })

  it.each([
    ['a group with no valid commands', { label: 'G', commands: [{ run: 'x' }] }],
    ['an empty group', { label: 'G', commands: [] }],
    ['a group with no label', { commands: [{ label: 'x', run: 'y' }] }],
    ['a non-boolean open', { label: 'G', commands: [{ label: 'x', run: 'y' }], open: 'yes' }],
    ['a non-array commands', { label: 'G', commands: 'nope' }]
  ])('drops %s but keeps its siblings', (_case, bad) => {
    expect(parseCommandsFile({ '/repo': [bad, valid] })).toEqual({ '/repo': [valid] })
  })

  it.each([[null], [[]], ['string'], [42]])('returns {} for a non-object file (%s)', raw => {
    expect(parseCommandsFile(raw)).toEqual({})
  })

  it('accepts the example file it writes, keyed by the real repos', () => {
    const parsed = parseCommandsFile(JSON.parse(exampleCommandsFile(['/a/repo', '/b/repo'])))
    expect(Object.keys(parsed)).toEqual(['/a/repo', '/b/repo'])
    expect(parsed['/a/repo']).toHaveLength(2)
  })

  it('seeds an example group, so grouping is discoverable from the file', () => {
    const entries = parseCommandsFile(JSON.parse(exampleCommandsFile(['/a/repo'])))['/a/repo']
    expect(entries.filter(isCommandGroup)).toHaveLength(1)
  })

  // The bug this guards: a sample path in the seeded file matches no repo, so
  // editing the commands under it yields no buttons and no error.
  it('never seeds a fake user path when real repos are known', () => {
    expect(exampleCommandsFile(['/Users/me/Code/thing'])).not.toContain('/Users/you')
  })
})
