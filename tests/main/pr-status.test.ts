import { describe, it, expect } from 'vitest'
import { fetchPrStatus, refreshAll } from '../../src/main/github/pr-status'
import { ghMissing, ghUnauthenticated, type GhResult } from '../../src/main/github/gh'

const ok = (json: unknown): GhResult => ({ ok: true, stdout: JSON.stringify(json), stderr: '' })
const fail = (stderr: string): GhResult => ({ ok: false, stdout: '', stderr })

describe('fetchPrStatus', () => {
  it('maps a gh payload onto a PrStatus', async () => {
    const run = async () => ok({
      number: 42, url: 'https://gh/pr/42', isDraft: false,
      state: 'OPEN', reviewDecision: 'APPROVED'
    })
    expect(await fetchPrStatus('/wt/a', run)).toEqual({
      state: 'approved', number: 42, url: 'https://gh/pr/42'
    })
  })

  it('treats "no pull requests found" as a definite absence of a PR', async () => {
    const run = async () => fail('no pull requests found for branch "feat-x"')
    expect(await fetchPrStatus('/wt/a', run)).toEqual({ state: 'none' })
  })

  it('returns null on any other failure so the cached value survives', async () => {
    const run = async () => fail('fatal: could not resolve host github.com')
    expect(await fetchPrStatus('/wt/a', run)).toBeNull()
  })

  it('returns null on unparseable stdout', async () => {
    const run = async (): Promise<GhResult> => ({ ok: true, stdout: 'not json', stderr: '' })
    expect(await fetchPrStatus('/wt/a', run)).toBeNull()
  })

  it('runs gh in the worktree directory', async () => {
    const seen: Array<{ args: string[]; cwd: string }> = []
    const run = async (args: string[], cwd: string) => { seen.push({ args, cwd }); return fail('no pull requests found') }
    await fetchPrStatus('/wt/a', run)
    expect(seen[0].cwd).toBe('/wt/a')
    expect(seen[0].args).toEqual(['pr', 'view', '--json', 'number,url,isDraft,state,reviewDecision'])
  })

  // Graphite rebases a stack before landing it, so the commits that reach trunk
  // have new shas and GitHub marks the PR closed rather than merged.
  it('reports a closed PR whose work reached trunk as merged', async () => {
    const run = async () => ok({ number: 9, url: 'u', isDraft: false, state: 'CLOSED', reviewDecision: '' })
    expect(await fetchPrStatus('/wt/a', run, async () => true))
      .toEqual({ state: 'merged', number: 9, url: 'u' })
  })

  it('leaves a genuinely abandoned PR closed', async () => {
    const run = async () => ok({ number: 9, url: 'u', isDraft: false, state: 'CLOSED', reviewDecision: '' })
    expect(await fetchPrStatus('/wt/a', run, async () => false))
      .toEqual({ state: 'closed', number: 9, url: 'u' })
  })

  it('never consults git for a PR GitHub has not closed', async () => {
    let asked = false
    const landed = async () => { asked = true; return true }
    for (const state of ['OPEN', 'MERGED']) {
      const run = async () => ok({ number: 9, url: 'u', isDraft: false, state, reviewDecision: '' })
      await fetchPrStatus('/wt/a', run, landed)
    }
    expect(asked).toBe(false)
  })
})

describe('refreshAll', () => {
  it('keys results by worktree path and skips the ones that failed', async () => {
    const run = async (_args: string[], cwd: string): Promise<GhResult> => {
      if (cwd === '/wt/a') return ok({ number: 1, url: 'u1', isDraft: true, state: 'OPEN', reviewDecision: '' })
      if (cwd === '/wt/b') return fail('no pull requests found')
      return fail('boom')
    }
    const res = await refreshAll(['/wt/a', '/wt/b', '/wt/c'], run)
    expect(res.statuses).toEqual({
      '/wt/a': { state: 'draft', number: 1, url: 'u1' },
      '/wt/b': { state: 'none' }
    })
    expect(res.error).toBeUndefined()
  })

  it('reports a gh installation problem once instead of per worktree', async () => {
    const run = async (_args: string[], cwd: string): Promise<GhResult> =>
      cwd === '/wt/a'
        ? ok({ number: 1, url: 'u1', isDraft: false, state: 'OPEN', reviewDecision: '' })
        : fail('gh: command not found')
    const res = await refreshAll(['/wt/a', '/wt/b'], run)
    expect(res.statuses).toEqual({ '/wt/a': { state: 'review', number: 1, url: 'u1' } })
    expect(res.error).toMatch(/gh/i)
  })

  it('reports an authentication problem', async () => {
    const run = async (_args: string[], cwd: string): Promise<GhResult> =>
      cwd === '/wt/a'
        ? fail('To get started with GitHub CLI, please run: gh auth login')
        : ok({ number: 2, url: 'u2', isDraft: true, state: 'OPEN', reviewDecision: '' })
    const res = await refreshAll(['/wt/a', '/wt/b'], run)
    expect(res.statuses).toEqual({ '/wt/b': { state: 'draft', number: 2, url: 'u2' } })
    expect(res.error).toMatch(/auth/i)
  })

  it('keeps a sibling worktree\'s status when one repo fails authentication', async () => {
    const run = async (_args: string[], cwd: string): Promise<GhResult> =>
      cwd === '/wt/private'
        ? fail('error: SAML enforcement failed, not logged in to this organization')
        : ok({ number: 9, url: 'u9', isDraft: false, state: 'MERGED', reviewDecision: '' })
    const res = await refreshAll(['/wt/private', '/wt/ok'], run)
    expect(res.statuses['/wt/ok']).toEqual({ state: 'merged', number: 9, url: 'u9' })
    expect(res.error).toMatch(/auth/i)
  })
})

describe('gh stderr predicates', () => {
  const cases: Array<[string, boolean, boolean]> = [
    ['spawn gh ENOENT', true, false],
    ['zsh: command not found: gh', true, false],
    ['To get started with GitHub CLI, please run: gh auth login', false, true],
    ['error: not logged in to any GitHub hosts', false, true],
    ['no pull requests found for branch "feat-x"', false, false],
    ['fatal: could not resolve host github.com', false, false]
  ]
  it.each(cases)('classifies %j', (stderr, missing, unauth) => {
    expect(ghMissing(stderr)).toBe(missing)
    expect(ghUnauthenticated(stderr)).toBe(unauth)
  })
})
