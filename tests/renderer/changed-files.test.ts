import { describe, it, expect } from 'vitest'
import { buildWorkingRows, buildCommittedRows, codeColor, reconcileTarget, type Row } from '../../src/renderer/components/changed-files'
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

describe('reconcileTarget', () => {
  const row = (over: Partial<Row>): Row =>
    ({ key: 'a.ts:w', path: 'a.ts', staged: false, untracked: false, committed: false, code: 'M', ...over })

  it('returns the same object when the key is still present', () => {
    const open = row({})
    const rows = [open, row({ key: 'b.ts:w', path: 'b.ts' })]
    expect(reconcileTarget(open, rows)).toBe(open)
  })

  it('returns the caller\'s own object, not the matching row, when the key is still present', () => {
    // The caller identity-compares the result to decide whether to setState, and
    // useMemo rebuilds these rows on every status refresh — returning the equal-but-
    // distinct row object would re-render forever.
    const open = row({})
    const rows = [row({ ...open, code: 'M' })]  // same key, different object
    expect(reconcileTarget(open, rows)).toBe(open)
  })

  it('returns null when rows are empty (file genuinely gone)', () => {
    const open = row({})
    expect(reconcileTarget(open, [])).toBeNull()
  })

  it('follows the path to its new key when staged (:w -> :s)', () => {
    const open = row({ key: 'a.ts:w', staged: false })
    const staged = row({ key: 'a.ts:s', staged: true, code: 'M' })
    expect(reconcileTarget(open, [staged])).toBe(staged)
  })

  it('follows the path when unstaging a formerly untracked file (:s -> :u)', () => {
    const open = row({ key: 'a.ts:s', staged: true })
    const untracked = row({ key: 'a.ts:u', staged: false, untracked: true, code: '?' })
    expect(reconcileTarget(open, [untracked])).toBe(untracked)
  })

  it('returns null when the path is gone entirely', () => {
    const open = row({})
    const rows = [row({ key: 'b.ts:w', path: 'b.ts' })]
    expect(reconcileTarget(open, rows)).toBeNull()
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
