import simpleGit from 'simple-git'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { WorktreeStatus, FileChange, LineStat } from '@shared/ipc-types'
import { parseNumstat } from './numstat'

// git diff --numstat can't see untracked files, so count their lines directly.
// Every line is an addition; a read failure (binary, gone) just yields no entry.
async function untrackedStat(worktreePath: string, path: string): Promise<LineStat | undefined> {
  try {
    const text = await readFile(join(worktreePath, path), 'utf8')
    if (text.includes('\0')) return undefined // binary
    const add = text.length === 0 ? 0 : text.split('\n').length - (text.endsWith('\n') ? 1 : 0)
    return { add, del: 0 }
  } catch {
    return undefined
  }
}

export async function getStatus(worktreePath: string): Promise<WorktreeStatus> {
  // A worktree can be removed while a refresh for it is already in flight (or
  // queued behind a watcher event). simple-git throws on a missing baseDir, and
  // that rejection surfaces as an unhandled IPC error; an empty status is the
  // honest answer for a directory that is gone.
  if (!existsSync(worktreePath)) {
    return { worktreePath, files: [], changeCount: 0, staged: {}, unstaged: {} }
  }
  const git = simpleGit(worktreePath)
  const [raw, stagedRaw, unstagedRaw] = await Promise.all([
    git.raw(['status', '--porcelain=v1', '-uall']),
    git.raw(['diff', '--cached', '--numstat']),
    git.raw(['diff', '--numstat'])
  ])
  const staged = parseNumstat(stagedRaw)
  const unstaged = parseNumstat(unstagedRaw)

  const files: FileChange[] = []
  const untracked: string[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const index = line[0]
    const working = line[1]
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1] // renames
    files.push({ path, index, working })
    if (index === '?' && working === '?') untracked.push(path)
  }

  // Fold untracked line counts into the unstaged map — they render as unstaged rows.
  await Promise.all(untracked.map(async p => {
    const stat = await untrackedStat(worktreePath, p)
    if (stat) unstaged[p] = stat
  }))

  return { worktreePath, files, changeCount: files.length, staged, unstaged }
}
