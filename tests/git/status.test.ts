import { describe, it, expect, afterEach } from 'vitest'
import { makeTmpRepo } from '../helpers/tmpRepo'
import { getStatus } from '../../src/main/git/status'
import { writeFileSync } from 'fs'
import { join } from 'path'

let cleanups: (() => void)[] = []
afterEach(() => { cleanups.forEach(c => c()); cleanups = [] })

describe('status', () => {
  it('counts modified and untracked files', async () => {
    const r = await makeTmpRepo(); cleanups.push(r.cleanup)
    writeFileSync(join(r.dir, 'README.md'), '# changed\n')
    writeFileSync(join(r.dir, 'new.txt'), 'hi\n')
    const s = await getStatus(r.dir)
    expect(s.changeCount).toBe(2)
    expect(s.files.map(f => f.path).sort()).toEqual(['README.md', 'new.txt'])
  })
})
