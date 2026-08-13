import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-pr-'))
  process.env.WTM_CONFIG_DIR = dir
})
afterEach(() => {
  delete process.env.WTM_CONFIG_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('pr status cache', () => {
  it('returns {} when nothing has been written yet', async () => {
    const { readPrStatuses } = await import('../../src/main/config')
    expect(await readPrStatuses()).toEqual({})
  })

  it('round-trips statuses for worktrees that still exist', async () => {
    const { readPrStatuses, writePrStatuses } = await import('../../src/main/config')
    const live = join(dir, 'wt-live')
    mkdirSync(live)
    await writePrStatuses({ [live]: { state: 'approved', number: 7, url: 'u' } })
    expect(await readPrStatuses()).toEqual({ [live]: { state: 'approved', number: 7, url: 'u' } })
  })

  it('prunes entries whose worktree directory is gone', async () => {
    const { readPrStatuses, writePrStatuses } = await import('../../src/main/config')
    const live = join(dir, 'wt-live')
    mkdirSync(live)
    await writePrStatuses({
      [live]: { state: 'draft' },
      [join(dir, 'wt-gone')]: { state: 'merged' }
    })
    expect(await readPrStatuses()).toEqual({ [live]: { state: 'draft' } })
  })

  it('degrades to {} on a corrupt file', async () => {
    const { readPrStatuses } = await import('../../src/main/config')
    writeFileSync(join(dir, 'pr-status.json'), '{ not json')
    expect(await readPrStatuses()).toEqual({})
  })
})
