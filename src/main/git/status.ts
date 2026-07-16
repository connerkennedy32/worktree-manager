import simpleGit from 'simple-git'
import type { WorktreeStatus, FileChange } from '@shared/ipc-types'

export async function getStatus(worktreePath: string): Promise<WorktreeStatus> {
  const git = simpleGit(worktreePath)
  const raw = await git.raw(['status', '--porcelain=v1', '-uall'])
  const files: FileChange[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const index = line[0]
    const working = line[1]
    let path = line.slice(3)
    if (path.includes(' -> ')) path = path.split(' -> ')[1] // renames
    files.push({ path, index, working })
  }
  return { worktreePath, files, changeCount: files.length }
}
