import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import simpleGit from 'simple-git'
import { addWorktree, makeTmpRepo, withOrigin } from '../helpers/tmpRepo'
import { clearTrunkCache } from '../../src/main/git/trunk'
import { isLandedInTrunk } from '../../src/main/git/landed'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })
beforeEach(() => clearTrunkCache())

// A repo with an origin, plus a linked worktree on `branch` carrying `commits`
// separate commits — the shape every case here starts from.
async function repoWithBranch(branch: string, commits: number) {
  const r = await makeTmpRepo()
  cleanups.push(r.cleanup)
  cleanups.push(await withOrigin(r.dir))
  const wt = await addWorktree(r.dir, branch)
  const wtGit = simpleGit(wt)
  for (let i = 1; i <= commits; i++) {
    writeFileSync(join(wt, `feature-${i}.txt`), `feature line ${i}\n`)
    await wtGit.add('.')
    await wtGit.commit(`feature commit ${i}`)
  }
  return { ...r, wt, wtGit }
}

describe('isLandedInTrunk', () => {
  it('says no while the branch is still only local work', async () => {
    const { wt } = await repoWithBranch('feat-open', 2)
    expect(await isLandedInTrunk(wt)).toBe(false)
  })

  it('recognizes a branch merged into trunk normally', async () => {
    const { dir, git, wt } = await repoWithBranch('feat-merged', 1)
    await git.raw(['merge', '--no-ff', 'feat-merged', '-m', 'merge feat-merged'])
    await git.push('origin', 'main')
    void dir
    expect(await isLandedInTrunk(wt)).toBe(true)
  })

  // The Graphite case: trunk gets the branch's whole diff as one new commit with
  // a sha the branch has never seen.
  it('recognizes a multi-commit branch squashed onto trunk', async () => {
    const { git, wt } = await repoWithBranch('feat-squashed', 3)
    await git.raw(['merge', '--squash', 'feat-squashed'])
    await git.commit('squashed feat-squashed')
    await git.push('origin', 'main')
    expect(await isLandedInTrunk(wt)).toBe(true)
  })

  // Graphite rebases the stack before landing it, so trunk's copy of each commit
  // has a different sha but the same patch.
  it('recognizes a branch rebased onto trunk before landing', async () => {
    const { dir, git, wt } = await repoWithBranch('feat-rebased', 2)
    writeFileSync(join(dir, 'trunk-moved.txt'), 'trunk moved on\n')
    await git.add('.')
    await git.commit('unrelated trunk work')
    await git.raw(['cherry-pick', 'feat-rebased~1', 'feat-rebased'])
    await git.push('origin', 'main')
    expect(await isLandedInTrunk(wt)).toBe(true)
  })

  it('is not fooled by an unrelated branch landing', async () => {
    const { dir, git, wt } = await repoWithBranch('feat-mine', 1)
    writeFileSync(join(dir, 'somebody-else.txt'), 'other work\n')
    await git.add('.')
    await git.commit('somebody else landed')
    await git.push('origin', 'main')
    expect(await isLandedInTrunk(wt)).toBe(false)
  })

  // A branch with nothing of its own is trivially contained in trunk, and git
  // cannot tell that apart from a branch whose every commit landed. Harmless:
  // this only ever runs for a branch GitHub reports a closed PR on, and a PR
  // with no commits doesn't exist.
  it('calls a branch with no commits of its own contained in trunk', async () => {
    const { wt } = await repoWithBranch('feat-empty', 0)
    expect(await isLandedInTrunk(wt)).toBe(true)
  })

  it('says no rather than throwing when the path is not a repo', async () => {
    expect(await isLandedInTrunk('/definitely/not/a/repo')).toBe(false)
  })
})
