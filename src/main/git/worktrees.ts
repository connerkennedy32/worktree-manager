import simpleGit from 'simple-git'
import { basename, dirname, join, isAbsolute, resolve } from 'path'
import type { Worktree } from '@shared/ipc-types'

// Absolute path to a worktree's HEAD file (correct for linked worktrees, whose
// real HEAD lives under the main repo's .git/worktrees/<id>/). Watching this
// detects branch switches/renames, which never touch the working tree.
export async function headPath(worktreePath: string): Promise<string> {
  const raw = (await simpleGit(worktreePath).raw(['rev-parse', '--git-path', 'HEAD'])).trim()
  return isAbsolute(raw) ? raw : resolve(worktreePath, raw)
}

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

// Create a worktree for a new branch, in the sibling convention the app uses
// everywhere else: <repoParent>/.worktrees/<repo>/<branch>. Branched from the
// repo's current HEAD, which is what `git worktree add -b` does by default.
//
// Returns the new worktree's path rather than the list: the caller wants to
// select it, and re-listing is the renderer's job anyway.
export async function createWorktree(repoPath: string, branch: string): Promise<string> {
  const dir = worktreeDir(repoPath, branch)
  await simpleGit(repoPath).raw(['worktree', 'add', '-b', branch, dir])
  // Return the path as `git worktree list` reports it, not the one we passed:
  // git resolves symlinks (/var -> /private/var on macOS), and a task attached
  // to the unresolved spelling would never match a row in the sidebar — the
  // card would render its brand-new worktree as already gone.
  const created = (await listWorktrees(repoPath)).find(w => w.branch === branch)
  return created?.path ?? dir
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
