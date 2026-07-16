import { describe, it, expect } from 'vitest'
import { buildWorkingRows, buildCommittedRows, codeColor } from '../../src/renderer/components/changed-files'
import type { WorktreeStatus, CommittedChanges } from '@shared/ipc-types'

const status = (files: WorktreeStatus['files']): WorktreeStatus =>
  ({ worktreePath: '/wt', files, changeCount: files.length })

describe('buildWorkingRows', () => {
  it('returns nothing when status is missing', () => {
    expect(buildWorkingRows(undefined)).toEqual([])
  })

  it('maps an untracked file to a single untracked row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: '?', working: '?' }]))
    expect(rows).toEqual([
      { key: 'a.ts:u', path: 'a.ts', staged: false, untracked: true, committed: false, code: '?' }
    ])
  })

  it('maps a staged-only file to a single staged row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: 'M', working: ' ' }]))
    expect(rows).toEqual([
      { key: 'a.ts:s', path: 'a.ts', staged: true, untracked: false, committed: false, code: 'M' }
    ])
  })

  it('maps an unstaged-only file to a single unstaged row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: ' ', working: 'M' }]))
    expect(rows).toEqual([
      { key: 'a.ts:w', path: 'a.ts', staged: false, untracked: false, committed: false, code: 'M' }
    ])
  })

  it('splits a partially staged file into both a staged and an unstaged row', () => {
    const rows = buildWorkingRows(status([{ path: 'a.ts', index: 'A', working: 'M' }]))
    expect(rows.map(r => r.key)).toEqual(['a.ts:s', 'a.ts:w'])
    expect(rows[0].code).toBe('A')
    expect(rows[1].code).toBe('M')
  })
})

describe('codeColor', () => {
  it('colors additions and untracked files green', () => {
    expect(codeColor('A')).toBe('#6a9955')
    expect(codeColor('?')).toBe('#6a9955')
  })

  it('colors deletions red', () => {
    expect(codeColor('D')).toBe('#c94a4a')
  })

  it('colors every other status amber', () => {
    expect(codeColor('M')).toBe('#c9a26a')
    expect(codeColor('R')).toBe('#c9a26a')
  })
})

describe('buildCommittedRows', () => {
  it('returns nothing when committed changes are absent', () => {
    expect(buildCommittedRows(null)).toEqual([])
  })

  it('marks every committed file as committed and not staged', () => {
    const c: CommittedChanges = { baseBranch: 'main', files: [{ path: 'a.ts', code: 'M' }] }
    expect(buildCommittedRows(c)).toEqual([
      { key: 'a.ts:c', path: 'a.ts', staged: false, untracked: false, committed: true, code: 'M' }
    ])
  })
})
