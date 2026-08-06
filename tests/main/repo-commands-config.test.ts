import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-cfg-'))
  process.env.WTM_CONFIG_DIR = dir
})

const commandsFile = () => join(dir, 'commands.json')
const readRaw = () => JSON.parse(readFileSync(commandsFile(), 'utf8'))
const writeRaw = (o: unknown) => writeFileSync(commandsFile(), JSON.stringify(o, null, 2))

const gate = { label: 'Gate', run: 'bash gate.sh' }

describe('saveRepoCommands', () => {
  it('writes a repo the file did not have yet', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    expect(await saveRepoCommands('/repo/a', [gate])).toEqual([gate])
    expect(readRaw()).toEqual({ '/repo/a': [gate] })
  })

  // The editor only ever holds one repo's entries; saving must not be a
  // whole-file overwrite or it would wipe every other repo's buttons.
  it('leaves other repos untouched', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    writeRaw({ '/repo/a': [gate], '/repo/b': [{ label: 'Other', run: 'x' }] })
    await saveRepoCommands('/repo/a', [{ label: 'New', run: 'y' }])
    expect(readRaw()).toEqual({
      '/repo/a': [{ label: 'New', run: 'y' }],
      '/repo/b': [{ label: 'Other', run: 'x' }]
    })
  })

  // The seeded file's `// how this works` key documents the format. The parser
  // drops it, so saving must merge into the raw JSON rather than the parsed form.
  it('preserves the // comment keys the parser ignores', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    writeRaw({ '// how this works': ['docs'], '/repo/a': [] })
    await saveRepoCommands('/repo/a', [gate])
    expect(readRaw()['// how this works']).toEqual(['docs'])
  })

  it('removes the key rather than writing an empty array', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    writeRaw({ '/repo/a': [gate], '/repo/b': [gate] })
    expect(await saveRepoCommands('/repo/a', [])).toEqual([])
    expect(readRaw()).toEqual({ '/repo/b': [gate] })
  })

  it('round-trips a group', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    const group = { label: 'Deploys', commands: [gate], open: true }
    expect(await saveRepoCommands('/repo/a', [group])).toEqual([group])
  })

  // What it returns is what a later read will produce, not what it was handed:
  // an entry the parser rejects must not linger in the editor as if it saved.
  it('returns the entries as re-parsed, dropping what would not survive', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    const bad = { label: 'Broken' } as never
    expect(await saveRepoCommands('/repo/a', [gate, bad])).toEqual([gate])
  })

  it('starts from scratch when the file is unreadable rather than throwing', async () => {
    const { saveRepoCommands } = await import('../../src/main/config')
    writeFileSync(commandsFile(), '{ not json')
    await saveRepoCommands('/repo/a', [gate])
    expect(readRaw()).toEqual({ '/repo/a': [gate] })
  })
})

describe('readAllRepoCommands', () => {
  it('keys every connected repo, with [] for one that has no commands', async () => {
    const { addRepo, saveRepoCommands, readAllRepoCommands } = await import('../../src/main/config')
    await addRepo('/repo/a')
    await addRepo('/repo/b')
    await saveRepoCommands('/repo/a', [gate])
    expect(await readAllRepoCommands()).toEqual({ '/repo/a': [gate], '/repo/b': [] })
  })

  // A repo in the file but no longer connected has no panel to show buttons on,
  // so the editor must not offer it — its entries stay in the file untouched.
  it('omits a repo that is in the file but not connected', async () => {
    const { addRepo, saveRepoCommands, readAllRepoCommands } = await import('../../src/main/config')
    await addRepo('/repo/a')
    await saveRepoCommands('/repo/gone', [gate])
    expect(Object.keys(await readAllRepoCommands())).toEqual(['/repo/a'])
  })

  it('returns empty arrays rather than failing on a corrupt file', async () => {
    const { addRepo, readAllRepoCommands } = await import('../../src/main/config')
    await addRepo('/repo/a')
    writeFileSync(commandsFile(), 'nonsense')
    expect(await readAllRepoCommands()).toEqual({ '/repo/a': [] })
  })
})
