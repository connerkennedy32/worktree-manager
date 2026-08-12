import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Layout } from '../../src/shared/ipc-types'

let dir: string
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'wtm-cfg-')); process.env.WTM_CONFIG_DIR = dir })

const sample = (): Layout => ({
  groups: [{ id: 'g1', name: 'Active', collapsed: false, paths: ['/a', '/b'] }],
  hidden: ['/c'],
  hiddenCollapsed: true
})

describe('layout config', () => {
  it('returns an empty layout when the file does not exist', async () => {
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true })
  })

  it('round-trips a layout', async () => {
    const { readLayout, writeLayout } = await import('../../src/main/config')
    expect(await writeLayout(sample())).toEqual(sample())
    expect(await readLayout()).toEqual(sample())
  })

  it('returns an empty layout when the file is corrupt', async () => {
    writeFileSync(join(dir, 'layout.json'), '{not json')
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true })
  })

  it('fills in missing fields rather than returning undefined ones', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ groups: [] }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true })
  })
})
