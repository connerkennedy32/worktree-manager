import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

beforeEach(() => { process.env.WTM_CONFIG_DIR = mkdtempSync(join(tmpdir(), 'wtm-cfg-')) })

describe('config', () => {
  it('adds and lists repos without duplicates', async () => {
    const { addRepo, listRepos } = await import('../src/main/config')
    await addRepo('/tmp/a')
    await addRepo('/tmp/a')
    await addRepo('/tmp/b')
    expect(await listRepos()).toEqual(['/tmp/a', '/tmp/b'])
  })

  it('removes a repo', async () => {
    const { addRepo, removeRepo, listRepos } = await import('../src/main/config')
    await addRepo('/tmp/a')
    await addRepo('/tmp/b')
    const after = await removeRepo('/tmp/a')
    expect(after).toEqual(['/tmp/b'])
    expect(await listRepos()).toEqual(['/tmp/b'])
  })
})
