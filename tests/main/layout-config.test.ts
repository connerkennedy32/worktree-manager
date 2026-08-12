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
  hiddenCollapsed: true,
  repoOrder: { '/code/r1': ['/a', '/b'] }
})

describe('layout config', () => {
  it('returns an empty layout when the file does not exist', async () => {
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })

  it('round-trips a layout', async () => {
    const { readLayout, writeLayout } = await import('../../src/main/config')
    expect(await writeLayout(sample())).toEqual(sample())
    expect(await readLayout()).toEqual(sample())
  })

  it('returns an empty layout when the file is corrupt', async () => {
    writeFileSync(join(dir, 'layout.json'), '{not json')
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })

  it('fills in missing fields rather than returning undefined ones', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ groups: [] }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })

  // A layout.json written before repoOrder existed has no such field at all;
  // readLayout must default it to {} rather than throwing or returning undefined.
  it('defaults repoOrder to {} when absent from an old layout file', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ groups: [], hidden: [], hiddenCollapsed: true }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })

  // Malformed entries are dropped rather than crashing the sidebar, the same
  // fail-soft contract as groups.
  it('drops malformed repoOrder entries rather than throwing', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({
      groups: [], hidden: [], hiddenCollapsed: true,
      repoOrder: { '/code/r1': ['/a', '/b'], '/code/r2': 'not-an-array', '/code/r3': ['/a', 2] }
    }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({
      groups: [], hidden: [], hiddenCollapsed: true, repoOrder: { '/code/r1': ['/a', '/b'] }
    })
  })

  it('defaults repoOrder to {} when it is not an object', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: 'nope' }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })

  // A group entry missing `paths` used to reach deriveSections, where
  // `take(g.paths)` iterates `undefined` and throws — an uncaught render error
  // with no in-app recovery. readLayout must drop malformed entries instead.
  it('drops a group entry missing paths rather than letting it through', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({
      groups: [{ id: 'g1', name: 'Ok', collapsed: false, paths: ['/a'] }, { id: 'g2', name: 'Bad', collapsed: false }],
      hidden: [], hiddenCollapsed: true
    }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({
      groups: [{ id: 'g1', name: 'Ok', collapsed: false, paths: ['/a'] }], hidden: [], hiddenCollapsed: true, repoOrder: {}
    })
  })

  it('drops group entries with the wrong field types', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({
      groups: [
        { id: 1, name: 'Bad id', collapsed: false, paths: [] },
        { id: 'g2', name: 'Bad collapsed', collapsed: 'no', paths: [] },
        { id: 'g3', name: 'Bad paths', collapsed: false, paths: ['/a', 2] },
        { id: 'g4', name: 42, collapsed: false, paths: [] }
      ]
    }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })

  it('drops a group entry that is not an object', async () => {
    writeFileSync(join(dir, 'layout.json'), JSON.stringify({ groups: [null, 'nope', 5] }))
    const { readLayout } = await import('../../src/main/config')
    expect(await readLayout()).toEqual({ groups: [], hidden: [], hiddenCollapsed: true, repoOrder: {} })
  })
})
