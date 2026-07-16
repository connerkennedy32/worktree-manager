import simpleGit from 'simple-git'
import { basename, dirname, join, isAbsolute, resolve } from 'path'
import type { Worktree, NewWorktreeRequest } from '@shared/ipc-types'
import { resolveTrunk } from './trunk'

// Absolute path to a worktree's HEAD file (correct for linked worktrees, whose
// real HEAD lives under the main repo's .git/worktrees/<id>/). Watching this
// detects branch switches/renames, which never touch the working tree.
export async function headPath(worktreePath: string): Promise<string> {
  const raw = (await simpleGit(worktreePath).raw(['rev-parse', '--git-path', 'HEAD'])).trim()
  return isAbsolute(raw) ? raw : resolve(worktreePath, raw)
}

// Git ref names can't contain spaces; collapse whitespace runs into a single dash
// so typing "my new feature" yields branch/dir name "my-new-feature" instead of failing.
export function sanitizeBranchName(branch: string): string {
  return branch.trim().replace(/\s+/g, '-')
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

export async function createWorktree(req: NewWorktreeRequest): Promise<Worktree[]> {
  const git = simpleGit(req.repoPath)
  const branch = req.createBranch ? sanitizeBranchName(req.branch) : req.branch
  const dir = worktreeDir(req.repoPath, branch)
  const args = ['worktree', 'add']
  if (req.createBranch) {
    // Name the start-point explicitly. Left off, git silently starts the branch
    // at the invoking repo's HEAD — and the invoking repo is the main checkout,
    // which is routinely parked on some unrelated feature branch. That seeds the
    // new worktree with that branch's commits, which then show up as this
    // branch's own committed files. Trunk is the same ref getCommittedFiles
    // diffs against, so a fresh worktree starts out genuinely empty.
    //
    // --no-track because trunk is a remote-tracking ref, and git's
    // branch.autoSetupMerge default would make the new branch track origin/main.
    // getPushState reads that upstream as "already has a remote" and the push
    // button would then aim this branch's commits straight at the trunk.
    const start = await resolveTrunk(req.repoPath)
    args.push('--no-track', '-b', branch, dir)
    if (start) args.push(start)
  }
  else args.push(dir, branch)
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
