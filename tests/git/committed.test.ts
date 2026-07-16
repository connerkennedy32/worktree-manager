import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
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

describe('getCommittedFiles', () => {
  it('lists files committed on the branch against the main worktree branch', async () => {
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

  it('returns an empty list for the main worktree itself', async () => {
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
