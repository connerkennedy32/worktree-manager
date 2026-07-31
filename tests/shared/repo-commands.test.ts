import { describe, it, expect } from 'vitest'
import {
  tokenize, promptVars, substitute, parseCommandsFile,
  exampleCommandsFile
} from '../../src/shared/repo-commands'

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

  it.each(['branch', 'worktree', 'repo', 'message'])('treats {{%s}} as implicit', v => {
    expect(promptVars(`cmd {{${v}}}`)).toEqual([])
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

  it('ignores // comment keys', () => {
    const parsed = parseCommandsFile({ '// notes': ['anything'], '/repo': [valid] })
    expect(Object.keys(parsed)).toEqual(['/repo'])
  })

  it.each([
    ['a missing label', { run: 'x' }],
    ['a blank label', { label: '  ', run: 'x' }],
    ['a missing run', { label: 'x' }],
    ['an unknown cwd', { label: 'x', run: 'y', cwd: 'elsewhere' }],
    ['a non-object', 'just a string']
  ])('drops an entry with %s but keeps its siblings', (_case, bad) => {
    expect(parseCommandsFile({ '/repo': [bad, valid] })).toEqual({ '/repo': [valid] })
  })

  it.each([[null], [[]], ['string'], [42]])('returns {} for a non-object file (%s)', raw => {
    expect(parseCommandsFile(raw)).toEqual({})
  })

  it('accepts the example file it writes, keyed by the real repos', () => {
    const parsed = parseCommandsFile(JSON.parse(exampleCommandsFile(['/a/repo', '/b/repo'])))
    expect(Object.keys(parsed)).toEqual(['/a/repo', '/b/repo'])
    expect(parsed['/a/repo']).toHaveLength(1)
  })

  // The bug this guards: a sample path in the seeded file matches no repo, so
  // editing the commands under it yields no buttons and no error.
  it('never seeds a fake user path when real repos are known', () => {
    expect(exampleCommandsFile(['/Users/me/Code/thing'])).not.toContain('/Users/you')
  })
})
