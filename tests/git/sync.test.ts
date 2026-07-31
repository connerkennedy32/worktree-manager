import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { makeTmpRepo, removeDir } from '../helpers/tmpRepo'
import { syncWithTrunk } from '../../src/main/git/sync'
import { clearTrunkCache } from '../../src/main/git/trunk'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
beforeEach(() => clearTrunkCache())

async function repoWithRemote() {
  const r = await makeTmpRepo()
  cleanups.push(r.cleanup)
  const remote = mkdtempSync(join(tmpdir(), 'wtm-remote-'))
  cleanups.push(() => removeDir(remote))
  await simpleGit(remote).init(['--bare', '--initial-branch=main'])
  await r.git.addRemote('origin', remote)
  await r.git.push(['-u', 'origin', 'main'])
  return { ...r, remote }
}

const commit = async (r: { dir: string; git: any }, name: string, body = name) => {
  writeFileSync(join(r.dir, name), body)
  await r.git.add('.')
  await r.git.commit(name)
}

// A second clone that lands commits on origin/main, standing in for a teammate.
async function advanceRemoteMain(remote: string, name: string) {
  const other = mkdtempSync(join(tmpdir(), 'wtm-other-'))
  cleanups.push(() => removeDir(other))
  const git = simpleGit(other)
  await git.clone(remote, other)
  writeFileSync(join(other, name), name)
  await git.add('.')
  await git.commit(name)
  await git.push()
}

describe('syncWithTrunk', () => {
  it('merges new trunk commits into the branch', async () => {
    const r = await repoWithRemote()
    await r.git.checkoutLocalBranch('feat')
    await commit(r, 'mine.txt')
    await advanceRemoteMain(r.remote, 'theirs.txt')

    const outcome = await syncWithTrunk(r.dir)

    expect(outcome.ok).toBe(true)
    expect(outcome.message).toContain('Merged 1 commit')
    // The teammate's file is now present in this worktree.
    const files = (await r.git.raw(['ls-files'])).split('\n')
    expect(files).toContain('theirs.txt')
    expect(files).toContain('mine.txt')
  })

  it('streams the commands it runs, so the panel can show them', async () => {
    const r = await repoWithRemote()
    await r.git.checkoutLocalBranch('feat')
    await commit(r, 'mine.txt')
    const chunks: string[] = []

    await syncWithTrunk(r.dir, c => chunks.push(c))

    const out = chunks.join('')
    expect(out).toContain('$ git fetch origin main')
    expect(out).toContain('$ git merge --no-edit origin/main')
  })

  it('reports an up-to-date branch without claiming a merge', async () => {
    const r = await repoWithRemote()
    await r.git.checkoutLocalBranch('feat')
    await commit(r, 'mine.txt')

    const outcome = await syncWithTrunk(r.dir)

    expect(outcome).toEqual({ ok: true, message: 'Already up to date.' })
  })

  it("returns git's message when the merge conflicts", async () => {
    const r = await repoWithRemote()
    await commit(r, 'shared.txt', 'base')
    await r.git.push()
    await r.git.checkoutLocalBranch('feat')
    await commit(r, 'shared.txt', 'mine')

    // The same file, changed differently on trunk.
    const other = mkdtempSync(join(tmpdir(), 'wtm-other-'))
    cleanups.push(() => removeDir(other))
    const git = simpleGit(other)
    await git.clone(r.remote, other)
    writeFileSync(join(other, 'shared.txt'), 'theirs')
    await git.add('.')
    await git.commit('theirs')
    await git.push()

    const outcome = await syncWithTrunk(r.dir)

    expect(outcome.ok).toBe(false)
    expect(outcome.message).toMatch(/conflict/i)
  })

  it('fails with a readable message when trunk cannot be resolved', async () => {
    const r = await makeTmpRepo()
    cleanups.push(r.cleanup)
    await r.git.raw(['branch', '-m', 'odd-trunk'])

    const outcome = await syncWithTrunk(r.dir)

    expect(outcome).toEqual({ ok: false, message: 'Could not determine the trunk branch.' })
  })
})
