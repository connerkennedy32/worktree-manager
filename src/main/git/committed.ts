import simpleGit from 'simple-git'
import { dirname } from 'path'
import { listWorktrees } from './worktrees'
import type { CommittedChanges, CommittedFile } from '@shared/ipc-types'

const EMPTY: CommittedChanges = { baseBranch: '', files: [] }

// The base to compare a branch against is whatever branch the repo's *main*
// worktree has checked out — not a hardcoded main/master, which is wrong for
// repos using another trunk name.
async function resolveBaseBranch(worktreePath: string): Promise<string | undefined> {
  const git = simpleGit(worktreePath)
  const commonDir = (await git.raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  const repoPath = dirname(commonDir) // .git common dir's parent is the main worktree
  const main = (await listWorktrees(repoPath)).find(w => w.isMain)
  if (!main || main.branch === '(detached)') return undefined
  return main.branch
}

// `--name-status` lines are "<code>\t<path>", except renames/copies which are
// "R100\told\tnew". Take the last field so renames report their new path, the
// same way getStatus() resolves "old -> new".
function parseNameStatus(raw: string): CommittedFile[] {
  const out: CommittedFile[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const parts = line.split('\t')
    if (parts.length < 2) continue
    out.push({ code: parts[0][0], path: parts[parts.length - 1] })
  }
  return out
}

// Files this branch has committed relative to where it diverged from the base
// branch (three-dot: commits landing on the base afterward are excluded, which
// is what a PR shows). Best-effort — any failure yields an empty list so the
// working-tree list, the panel's primary job, never breaks.
export async function getCommittedFiles(worktreePath: string): Promise<CommittedChanges> {
  try {
    const git = simpleGit(worktreePath)
    const base = await resolveBaseBranch(worktreePath)
    if (!base) return EMPTY
    const current = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    if (current === base) return EMPTY // the main worktree itself — nothing to compare
    const raw = await git.raw(['diff', '--name-status', `${base}...HEAD`])
    return { baseBranch: base, files: parseNameStatus(raw) }
  } catch {
    return EMPTY
  }
}
