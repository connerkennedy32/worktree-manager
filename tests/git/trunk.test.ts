import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { resolveTrunk, clearTrunkCache, refExists } from '../../src/main/git/trunk'
import simpleGit from 'simple-git'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
beforeEach(() => clearTrunkCache())

describe('resolveTrunk', () => {
  it('resolves a local main branch', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    expect(await resolveTrunk(r.dir)).toBe('main')
  })

  it('falls back to master when there is no main', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    await r.git.branch(['-m', 'main', 'master'])
    expect(await resolveTrunk(r.dir)).toBe('master')
  })

  it('returns undefined when no trunk candidate exists', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    await r.git.branch(['-m', 'main', 'something-else'])
    expect(await resolveTrunk(r.dir)).toBeUndefined()
  })
})

describe('resolveTrunk caching', () => {
  it('does not re-resolve for the same worktree path', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    expect(await resolveTrunk(r.dir)).toBe('main')

    // Rename the branch out from under it. An uncached implementation would now
    // resolve to 'something-else'/undefined; a cached one still answers 'main'.
    await r.git.branch(['-m', 'main', 'something-else'])
    expect(await resolveTrunk(r.dir)).toBe('main')
  })

  it('re-resolves after the cache is cleared', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    expect(await resolveTrunk(r.dir)).toBe('main')
    await r.git.branch(['-m', 'main', 'master'])

    clearTrunkCache()
    expect(await resolveTrunk(r.dir)).toBe('master')
  })

  it('caches a negative result rather than re-resolving it', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    await r.git.branch(['-m', 'main', 'something-else'])
    expect(await resolveTrunk(r.dir)).toBeUndefined()

    // Creating main afterwards must not change the cached answer.
    await r.git.branch(['main'])
    expect(await resolveTrunk(r.dir)).toBeUndefined()
  })

  it('caches per worktree path, not globally', async () => {
    const a = await makeTmpRepo()
    const b = await makeTmpRepo()
    cleanups.push(a.cleanup, b.cleanup)
    await b.git.branch(['-m', 'main', 'master'])

    expect(await resolveTrunk(a.dir)).toBe('main')
    expect(await resolveTrunk(b.dir)).toBe('master')
  })
})

describe('refExists', () => {
  it('is true for an existing ref and false for a missing one', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    const git = simpleGit(r.dir)
    expect(await refExists(git, 'main')).toBe(true)
    expect(await refExists(git, 'nope')).toBe(false)
  })
})
