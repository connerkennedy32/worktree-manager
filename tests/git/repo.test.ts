import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { validateRepoSelection } from '../../src/main/git/repo'
import { mkdirSync } from 'fs'
import { join } from 'path'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('validateRepoSelection', () => {
  it('accepts a repo root and returns its canonical path', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const root = await validateRepoSelection(r.dir)
    expect(root).toBeTruthy()
  })

  it('rejects a subfolder of a repo', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    const sub = join(r.dir, 'packages', 'app')
    mkdirSync(sub, { recursive: true })
    await expect(validateRepoSelection(sub)).rejects.toThrow(/inside a larger git repository/)
  })

  it('rejects a non-repo directory', async () => {
    const { mkdtempSync } = await import('fs')
    const { tmpdir } = await import('os')
    const dir = mkdtempSync(join(tmpdir(), 'wtm-norepo-'))
    cleanups.push(() => import('fs').then(fs => fs.rmSync(dir, { recursive: true, force: true })))
    await expect(validateRepoSelection(dir)).rejects.toThrow(/Not a git repository/)
  })
})
