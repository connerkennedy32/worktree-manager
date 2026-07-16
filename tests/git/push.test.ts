import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { pushArgs, getPushState, push } from '../../src/main/git/push'
import { clearTrunkCache } from '../../src/main/git/trunk'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
beforeEach(() => clearTrunkCache())

// A repo wired to a real bare remote, with main already pushed and tracking.
async function repoWithRemote() {
  const r = await makeTmpRepo()
  cleanups.push(r.cleanup)
  const remote = mkdtempSync(join(tmpdir(), 'wtm-remote-'))
  cleanups.push(() => rmSync(remote, { recursive: true, force: true }))
  await simpleGit(remote).init(['--bare', '--initial-branch=main'])
  await r.git.addRemote('origin', remote)
  await r.git.push(['-u', 'origin', 'main'])
  return { ...r, remote }
}

const commit = async (r: { dir: string; git: any }, name: string) => {
  writeFileSync(join(r.dir, name), name)
  await r.git.add('.')
  await r.git.commit(name)
}

describe('pushArgs', () => {
  it('pushes plainly when the branch already tracks an upstream', () => {
    expect(pushArgs('feat-x', true)).toEqual(['push'])
  })

  it('sets upstream on the first push of a new branch', () => {
    expect(pushArgs('feat-x', false)).toEqual(['push', '-u', 'origin', 'feat-x'])
  })
})

describe('getPushState', () => {
  it('counts commits ahead of an existing upstream', async () => {
    const r = await repoWithRemote()
    await commit(r, 'a.txt')
    await commit(r, 'b.txt')

    const s = await getPushState(r.dir)
    expect(s).toMatchObject({ branch: 'main', hasUpstream: true, ahead: 2 })
  })

  it('reports nothing ahead when the upstream is current', async () => {
    const r = await repoWithRemote()
    const s = await getPushState(r.dir)
    expect(s).toMatchObject({ hasUpstream: true, ahead: 0 })
  })

  it('counts commits against trunk when the branch has no upstream', async () => {
    const r = await repoWithRemote()
    await r.git.checkoutLocalBranch('feat')
    await commit(r, 'a.txt')
    await commit(r, 'b.txt')

    const s = await getPushState(r.dir)
    expect(s).toMatchObject({ branch: 'feat', hasUpstream: false, ahead: 2 })
  })

  it('reports nothing ahead for a fresh branch with no commits of its own', async () => {
    const r = await repoWithRemote()
    await r.git.checkoutLocalBranch('feat')
    const s = await getPushState(r.dir)
    expect(s.ahead).toBe(0)
  })

  it('reports nothing ahead on a detached HEAD', async () => {
    const r = await repoWithRemote()
    await commit(r, 'a.txt')
    const sha = (await r.git.revparse(['HEAD'])).trim()
    await r.git.checkout([sha])

    const s = await getPushState(r.dir)
    expect(s.ahead).toBe(0)
  })

  it('reports nothing ahead when there is no upstream and no trunk', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    await r.git.branch(['-m', 'main', 'something-else'])
    await commit(r, 'a.txt')

    const s = await getPushState(r.dir)
    expect(s.ahead).toBe(0)
  })
})

describe('push', () => {
  it('lands commits on the remote when tracking already exists', async () => {
    const r = await repoWithRemote()
    await commit(r, 'a.txt')

    expect(await push(r.dir)).toEqual({ ok: true })
    const remoteLog = await simpleGit(r.remote).raw(['log', '--oneline', 'main'])
    expect(remoteLog).toContain('a.txt')
    expect((await getPushState(r.dir)).ahead).toBe(0)
  })

  it('establishes tracking on the first push of a new branch', async () => {
    const r = await repoWithRemote()
    await r.git.checkoutLocalBranch('feat')
    await commit(r, 'a.txt')

    expect(await push(r.dir)).toEqual({ ok: true })

    // The branch now exists on the remote and is tracked locally.
    const remoteLog = await simpleGit(r.remote).raw(['log', '--oneline', 'feat'])
    expect(remoteLog).toContain('a.txt')
    expect((await getPushState(r.dir)).hasUpstream).toBe(true)
  })

  it('returns git\'s message when the push is rejected', async () => {
    const r = await repoWithRemote()
    // Put a commit on the remote that the local branch doesn't have, so the
    // local push is a non-fast-forward.
    const other = mkdtempSync(join(tmpdir(), 'wtm-other-'))
    cleanups.push(() => rmSync(other, { recursive: true, force: true }))
    await simpleGit().clone(r.remote, other)
    const otherGit = simpleGit(other)
    await otherGit.addConfig('user.email', 'other@test.dev')
    await otherGit.addConfig('user.name', 'Other')
    writeFileSync(join(other, 'theirs.txt'), 'theirs')
    await otherGit.add('.')
    await otherGit.commit('theirs')
    await otherGit.push()

    await commit(r, 'mine.txt')

    const result = await push(r.dir)
    expect(result.ok).toBe(false)
    // Assert on the shape of git's rejection rather than exact text, which
    // varies across git versions.
    if (!result.ok) expect(result.message.toLowerCase()).toContain('reject')
  })
})
