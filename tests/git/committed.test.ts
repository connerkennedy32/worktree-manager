import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo, withOrigin } from '../helpers/tmpRepo'
import { getCommittedFiles } from '../../src/main/git/committed'
import { getFileDiff } from '../../src/main/git/diff'
import { createWorktree, worktreeDir } from '../../src/main/git/worktrees'
import { writeFileSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit from 'simple-git'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

// Build a repo plus a linked worktree on branch `feat` with one commit on it.
async function repoWithBranchWorktree() {
  const r = await makeTmpRepo()
  cleanups.push(r.cleanup)
  cleanups.push(() => rmSync(join(r.dir, '..', '.worktrees'), { recursive: true, force: true }))
  await createWorktree({ repoPath: r.dir, branch: 'feat', createBranch: true })
  const wtPath = worktreeDir(r.dir, 'feat')
  const wtGit = simpleGit(wtPath)
  await wtGit.addConfig('user.email', 'test@test.dev')
  await wtGit.addConfig('user.name', 'Test')
  return { ...r, wtPath, wtGit }
}

// A repo whose *main* worktree is checked out on a feature branch — the common
// case when you don't use linked worktrees at all.
async function repoOnFeatureBranch() {
  const r = await makeTmpRepo()
  cleanups.push(r.cleanup)
  await r.git.checkoutLocalBranch('feat')
  return r
}

// Registers the bare remote's cleanup, so callers can ignore the return value.
async function addOrigin(dir: string) {
  cleanups.push(await withOrigin(dir))
}

describe('getCommittedFiles', () => {
  it('uses the trunk as base even when the main worktree is on a feature branch', async () => {
    const r = await repoOnFeatureBranch()
    writeFileSync(join(r.dir, 'feature.txt'), 'hello\n')
    await r.git.add('.')
    await r.git.commit('add feature')

    const res = await getCommittedFiles(r.dir)
    expect(res.baseBranch).toBe('main')
    expect(res.files).toEqual([{ code: 'A', path: 'feature.txt' }])
  })

  it('uses origin/HEAD, not a local branch, as the base when a remote exists', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await addOrigin(r.dir)
    await r.git.raw(['remote', 'set-head', 'origin', 'main'])
    await r.git.checkoutLocalBranch('feat')
    writeFileSync(join(r.dir, 'feature.txt'), 'hello\n')
    await r.git.add('.')
    await r.git.commit('add feature')

    const res = await getCommittedFiles(r.dir)
    expect(res.baseBranch).toBe('origin/main')
    expect(res.files.map(f => f.path)).toEqual(['feature.txt'])
  })

  it('on the trunk itself, lists unpushed commits against origin/<trunk>', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await addOrigin(r.dir)
    writeFileSync(join(r.dir, 'unpushed.txt'), 'local only\n')
    await r.git.add('.')
    await r.git.commit('not pushed yet')

    const res = await getCommittedFiles(r.dir)
    expect(res.baseBranch).toBe('origin/main')
    expect(res.files).toEqual([{ code: 'A', path: 'unpushed.txt' }])
  })

  it('on the trunk with everything pushed, lists nothing', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await addOrigin(r.dir)
    const res = await getCommittedFiles(r.dir)
    expect(res.files).toEqual([])
  })

  it('lists files committed on a linked worktree branch against the trunk', async () => {
    const { wtPath, wtGit } = await repoWithBranchWorktree()
    writeFileSync(join(wtPath, 'feature.txt'), 'hello\n')
    await wtGit.add('.')
    await wtGit.commit('add feature')

    const res = await getCommittedFiles(wtPath)
    expect(res.baseBranch).toBe('main')
    expect(res.files).toEqual([{ code: 'A', path: 'feature.txt' }])
  })

  it('excludes commits made on the base branch after divergence (three-dot)', async () => {
    const { dir, git, wtPath, wtGit } = await repoWithBranchWorktree()
    writeFileSync(join(wtPath, 'feature.txt'), 'hello\n')
    await wtGit.add('.')
    await wtGit.commit('add feature')

    // Land an unrelated commit on main *after* feat diverged.
    writeFileSync(join(dir, 'on-main.txt'), 'main only\n')
    await git.add('.')
    await git.commit('main moves on')

    const res = await getCommittedFiles(wtPath)
    expect(res.files.map(f => f.path)).toEqual(['feature.txt'])
  })

  it('reports the new path for a rename', async () => {
    const { wtPath, wtGit } = await repoWithBranchWorktree()
    await wtGit.raw(['mv', 'README.md', 'DOCS.md'])
    await wtGit.commit('rename readme')

    const res = await getCommittedFiles(wtPath)
    expect(res.files.map(f => f.path)).toContain('DOCS.md')
  })

  it('returns an empty list on the trunk with no remote', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const res = await getCommittedFiles(r.dir)
    expect(res.files).toEqual([])
  })

  it('returns an empty list rather than throwing outside a repo', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wtm-norepo-'))
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
    const res = await getCommittedFiles(dir)
    expect(res.files).toEqual([])
  })
})

describe('getFileDiff with baseRef', () => {
  it('returns the committed patch for a single file', async () => {
    const { wtPath, wtGit } = await repoWithBranchWorktree()
    writeFileSync(join(wtPath, 'feature.txt'), 'hello\n')
    await wtGit.add('.')
    await wtGit.commit('add feature')

    const patch = await getFileDiff({
      worktreePath: wtPath, path: 'feature.txt', staged: false, untracked: false, baseRef: 'main'
    })
    expect(patch).toContain('+hello')
  })
})
