import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readFile, writeFile } from '../../src/main/files'

let dirs: string[] = []
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'wtm-files-')); dirs.push(d); return d }
afterEach(() => { dirs.forEach(d => rmSync(d, { recursive: true, force: true })); dirs = [] })

describe('files', () => {
  it('reads on-disk file content', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.txt'), 'hello\n')
    expect(await readFile({ worktreePath: dir, path: 'a.txt' })).toBe('hello\n')
  })

  it('writes content back to the file', async () => {
    const dir = tmp()
    writeFileSync(join(dir, 'a.txt'), 'old\n')
    await writeFile({ worktreePath: dir, path: 'a.txt', content: 'new\n' })
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('new\n')
  })

  it('reads a file in a subdirectory', async () => {
    const dir = tmp()
    const sub = join(dir, 'src')
    mkdirSync(sub, { recursive: true })
    writeFileSync(join(sub, 'b.ts'), 'x\n')
    expect(await readFile({ worktreePath: dir, path: 'src/b.ts' })).toBe('x\n')
  })

  it('rejects a path that escapes the worktree', async () => {
    const dir = tmp()
    await expect(readFile({ worktreePath: dir, path: '../secret.txt' }))
      .rejects.toThrow('path escapes worktree')
    await expect(writeFile({ worktreePath: dir, path: '../secret.txt', content: 'x' }))
      .rejects.toThrow('path escapes worktree')
  })
})
