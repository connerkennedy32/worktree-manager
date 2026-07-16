import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { getDiff, stage, commit, getFileDiff, stagePath } from '../../src/main/git/diff'
import { getStatus } from '../../src/main/git/status'
import { writeFileSync } from 'fs'
import { join } from 'path'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('diff', () => {
  it('returns a per-file unified patch for a modified file', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# temp\nmore\n')
    const diffs = await getDiff(r.dir)
    const f = diffs.find(d => d.path === 'README.md')!
    expect(f).toBeDefined()
    expect(f.rawPatch).toContain('+more')
    expect(f.staged).toBe(false)
  })

  it('getFileDiff returns a single file patch; stagePath stages then commits', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# temp\nmore\n')
    const patch = await getFileDiff({ worktreePath: r.dir, path: 'README.md', staged: false, untracked: false })
    expect(patch).toContain('+more')
    await stagePath({ worktreePath: r.dir, path: 'README.md', unstage: false })
    let s = await getStatus(r.dir)
    expect(s.files.find(x => x.path === 'README.md')!.index).not.toBe(' ')
    // unstage works too
    await stagePath({ worktreePath: r.dir, path: 'README.md', unstage: true })
    s = await getStatus(r.dir)
    expect(s.files.find(x => x.path === 'README.md')!.index).toBe(' ')
    // restage and commit
    await stagePath({ worktreePath: r.dir, path: 'README.md', unstage: false })
    await commit({ worktreePath: r.dir, message: 'more' })
    expect((await getStatus(r.dir)).changeCount).toBe(0)
  })

  it('getFileDiff returns content for an untracked file', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'new.txt'), 'hello\n')
    const patch = await getFileDiff({ worktreePath: r.dir, path: 'new.txt', staged: false, untracked: true })
    expect(patch).toContain('+hello')
  })

  it('stages a file patch then commits', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# temp\nmore\n')
    const diffs = await getDiff(r.dir)
    const f = diffs.find(d => d.path === 'README.md')!
    await stage({ worktreePath: r.dir, patch: f.rawPatch })
    let s = await getStatus(r.dir)
    expect(s.files.find(x => x.path === 'README.md')!.index).not.toBe(' ')
    await commit({ worktreePath: r.dir, message: 'add more' })
    s = await getStatus(r.dir)
    expect(s.changeCount).toBe(0)
  })
})
