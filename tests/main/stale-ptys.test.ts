import { describe, it, expect } from 'vitest'
import { stalePtyPaths } from '../../src/main/stale-ptys'

describe('stalePtyPaths', () => {
  const gone = new Set(['/code/.wt-trash/old', '/code/wt-deleted'])
  const exists = (p: string): boolean => !gone.has(p)

  it('reaps a session whose directory no longer exists', () => {
    expect(stalePtyPaths(['/code/wt-live', '/code/wt-deleted'], exists)).toEqual(['/code/wt-deleted'])
  })

  it('keeps every session whose directory is still there', () => {
    expect(stalePtyPaths(['/code/wt-live', '/code/repo'], exists)).toEqual([])
  })

  it('reaps a session left behind by a worktree moved to trash', () => {
    // `pnpm delete-worktree` moves the directory rather than removing it, so the
    // shell survives with a cwd that has silently relocated.
    expect(stalePtyPaths(['/code/.wt-trash/old'], exists)).toEqual(['/code/.wt-trash/old'])
  })

  it('is empty when the daemon knows nothing', () => {
    expect(stalePtyPaths([], exists)).toEqual([])
  })
})
