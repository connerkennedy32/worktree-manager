import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { runGit } from '../../src/main/git/run'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('runGit', () => {
  it('echoes the command before running it, so the output reads like a session', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    const chunks: string[] = []

    await runGit(r.dir, ['log', '--oneline'], c => chunks.push(c))

    expect(chunks[0]).toBe('$ git log --oneline\n')
    expect(chunks.join('')).toContain('initial')
  })

  it('returns the exit code and git\'s message instead of throwing', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)

    const run = await runGit(r.dir, ['merge', 'no-such-branch'])

    expect(run.code).not.toBe(0)
    expect(run.output).toMatch(/no-such-branch/)
  })

  it('captures stderr as well as stdout', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)

    // `git status` writes to stdout; a bad revision writes to stderr. Both must
    // land in the same stream, as a terminal would show them.
    const run = await runGit(r.dir, ['rev-parse', 'definitely-not-a-ref'])

    expect(run.output.trim()).not.toBe('')
  })

  it('reports a failure to spawn rather than rejecting', async () => {
    const run = await runGit('/no/such/directory', ['status'])

    expect(run.code).not.toBe(0)
  })
})
