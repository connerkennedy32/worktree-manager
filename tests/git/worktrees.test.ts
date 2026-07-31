import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo, withOrigin, addWorktree } from '../helpers/tmpRepo'
import { listWorktrees, removeWorktree, headPath, worktreeDir } from '../../src/main/git/worktrees'
import { existsSync, writeFileSync } from 'fs'
import { join } from 'path'
import simpleGit from 'simple-git'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('worktrees', () => {
  it('lists the main worktree', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const wts = await listWorktrees(r.dir)
    expect(wts).toHaveLength(1)
    expect(wts[0].isMain).toBe(true)
    expect(wts[0].branch).toBe('main')
  })

  it('removes a worktree', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await addWorktree(r.dir, 'feat-x')
    let wts = await listWorktrees(r.dir)
    const target = wts.find(w => w.branch === 'feat-x')!
    wts = await removeWorktree(target.path, false)
    expect(wts.find(w => w.branch === 'feat-x')).toBeUndefined()
  })

  it('deletes the branch when removing its worktree', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await addWorktree(r.dir, 'feat-z')
    const branchesBefore = await r.git.branchLocal()
    expect(branchesBefore.all).toContain('feat-z')
    const target = (await listWorktrees(r.dir)).find(w => w.branch === 'feat-z')!
    await removeWorktree(target.path, false)
    const branchesAfter = await r.git.branchLocal()
    expect(branchesAfter.all).not.toContain('feat-z')
  })

  it('headPath resolves an existing HEAD file that reflects branch renames', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const hp = await headPath(r.dir)
    expect(existsSync(hp)).toBe(true)
    await r.git.raw(['branch', '-m', 'renamed-main'])
    // listing now reflects the rename, and HEAD still resolves
    const wts = await listWorktrees(r.dir)
    expect(wts[0].branch).toBe('renamed-main')
    expect(existsSync(await headPath(r.dir))).toBe(true)
  })

  it('force-removes a worktree that has uncommitted changes', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    await addWorktree(r.dir, 'feat-y')
    const target = (await listWorktrees(r.dir)).find(w => w.branch === 'feat-y')!
    writeFileSync(join(target.path, 'dirty.txt'), 'uncommitted\n')
    // a non-forced remove must refuse when the worktree is dirty
    await expect(removeWorktree(target.path, false)).rejects.toBeTruthy()
    // a forced remove must succeed
    const wts = await removeWorktree(target.path, true)
    expect(wts.find(w => w.branch === 'feat-y')).toBeUndefined()
    expect(existsSync(target.path)).toBe(false)
  })
})
