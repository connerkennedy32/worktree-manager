import { describe, it, expect } from 'vitest'
import { problems, duplicateLabels, clean, move } from '../../src/renderer/components/commands-editor-model'

const gate = { label: 'Gate', run: 'bash gate.sh' }

describe('problems', () => {
  it('is silent about a valid draft', () => {
    expect(problems([gate, { label: 'G', commands: [gate] }])).toEqual([])
  })

  it.each([
    ['a command with no label', [{ label: '', run: 'x' }]],
    ['a command with no run', [{ label: 'x', run: '  ' }]],
    ['a group with no name', [{ label: '', commands: [gate] }]],
    ['a group with no commands', [{ label: 'G', commands: [] }]]
  ])('reports %s, which the parser would drop', (_case, entries) => {
    expect(problems(entries)).not.toEqual([])
  })

  it('reaches commands nested in a group', () => {
    expect(problems([{ label: 'G', commands: [{ label: 'x', run: '' }] }]))
      .toEqual(['"x" has no command to run.'])
  })
})

describe('duplicateLabels', () => {
  // The bug this guards: these were treated as fatal, which left Save disabled
  // for any repo that already had a command copied into a group — including
  // when the edit being saved was deleting one of them.
  it('finds a label used both loose and inside a group', () => {
    expect(duplicateLabels([gate, { label: 'G', commands: [gate] }])).toEqual(['Gate'])
  })

  it('is silent when every label is distinct', () => {
    expect(duplicateLabels([gate, { label: 'Ship', run: 'x' }])).toEqual([])
  })

  it('reports a repeated label once, however many times it appears', () => {
    expect(duplicateLabels([gate, gate, gate])).toEqual(['Gate'])
  })

  it('ignores blank labels, which problems() already covers', () => {
    expect(duplicateLabels([{ label: '', run: 'a' }, { label: '', run: 'b' }])).toEqual([])
  })
})

describe('clean', () => {
  it('omits the defaults rather than writing them out', () => {
    expect(clean([{ label: ' Gate ', run: ' x ', cwd: 'worktree', shell: false }]))
      .toEqual([{ label: 'Gate', run: 'x' }])
  })

  it('keeps the non-default flags', () => {
    expect(clean([{ label: 'a', run: 'b', cwd: 'repo', shell: true, width: 'full' }]))
      .toEqual([{ label: 'a', run: 'b', cwd: 'repo', shell: true, width: 'full' }])
  })

  it('drops width when it is the default half', () => {
    expect(clean([{ label: 'a', run: 'b', width: 'half' }])).toEqual([{ label: 'a', run: 'b' }])
  })

  it('trims a group and its commands, dropping open when false', () => {
    expect(clean([{ label: ' G ', commands: [{ label: ' a ', run: ' b ' }], open: false }]))
      .toEqual([{ label: 'G', commands: [{ label: 'a', run: 'b' }] }])
  })
})

describe('move', () => {
  it('moves an item one step in either direction', () => {
    expect(move(['a', 'b', 'c'], 1, -1)).toEqual(['b', 'a', 'c'])
    expect(move(['a', 'b', 'c'], 1, 1)).toEqual(['a', 'c', 'b'])
  })

  it('leaves the list alone at either end', () => {
    expect(move(['a', 'b'], 0, -1)).toEqual(['a', 'b'])
    expect(move(['a', 'b'], 1, 1)).toEqual(['a', 'b'])
  })
})
