import simpleGit from 'simple-git'
import { basename, dirname, join } from 'path'
import type { Worktree, NewWorktreeRequest } from '@shared/ipc-types'

export function worktreeDir(repoPath: string, branch: string): string {
  const repoName = basename(repoPath)
  const safe = branch.replace(/[/\\]/g, '-')
  return join(dirname(repoPath), '.worktrees', repoName, safe)
}

export async function listWorktrees(repoPath: string): Promise<Worktree[]> {
  const git = simpleGit(repoPath)
  const raw = await git.raw(['worktree', 'list', '--porcelain'])
  const repoName = basename(repoPath)
  const out: Worktree[] = []
  let cur: Partial<Worktree> = {}
  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) cur = { path: line.slice(9).trim(), repoName }
    else if (line.startsWith('HEAD ')) cur.head = line.slice(5, 12)
    else if (line.startsWith('branch ')) cur.branch = line.slice(7).replace('refs/heads/', '').trim()
    else if (line === 'detached') cur.branch = '(detached)'
    else if (line.trim() === '') {
      if (cur.path) { cur.isMain = out.length === 0; out.push(cur as Worktree) }
      cur = {}
    }
  }
  if (cur.path) { cur.isMain = out.length === 0; out.push(cur as Worktree) }
  return out
}

export async function createWorktree(req: NewWorktreeRequest): Promise<Worktree[]> {
  const git = simpleGit(req.repoPath)
  const dir = worktreeDir(req.repoPath, req.branch)
  const args = ['worktree', 'add']
  if (req.createBranch) args.push('-b', req.branch, dir)
  else args.push(dir, req.branch)
  await git.raw(args)
  return listWorktrees(req.repoPath)
}

export async function removeWorktree(worktreePath: string, force: boolean): Promise<Worktree[]> {
  const git = simpleGit(worktreePath)
  const commonDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const repoPath = dirname(commonDir) // .git common dir's parent is the main worktree

  // Capture the branch this worktree is on before removing it, so we can delete it too.
  const before = await listWorktrees(repoPath)
  const wt = before.find(w => w.path === worktreePath)
  const branch = wt && !wt.isMain && wt.branch !== '(detached)' ? wt.branch : undefined

  const args = ['worktree', 'remove', worktreePath]
  if (force) args.push('--force')
  await git.raw(args)

  // Delete the now-unused branch. Force (-D) because the user confirmed removal
  // and the branch may hold unmerged commits. Best-effort: never fail the whole
  // removal just because the branch is gone or protected.
  if (branch) {
    await simpleGit(repoPath).raw(['branch', '-D', branch]).catch(() => { /* ignore */ })
  }

  return listWorktrees(repoPath)
}
