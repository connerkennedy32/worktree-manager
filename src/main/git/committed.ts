import simpleGit from 'simple-git'
import type { CommittedChanges, CommittedFile } from '@shared/ipc-types'
import { refExists, resolveTrunk } from './trunk'

const EMPTY: CommittedChanges = { baseBranch: '', files: [] }

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

// Files this branch has committed relative to where it diverged from its base
// (three-dot: commits landing on the base afterward are excluded, which is what
// a PR shows). On the trunk itself there is no divergence to show, so the base
// becomes the remote tracking branch and the list means "committed but unpushed".
// Best-effort — any failure yields an empty list so the working-tree list, the
// panel's primary job, never breaks.
export async function getCommittedFiles(worktreePath: string): Promise<CommittedChanges> {
  try {
    const git = simpleGit(worktreePath)
    const trunk = await resolveTrunk(worktreePath)
    if (!trunk) return EMPTY
    const current = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()

    let base = trunk
    if (current === trunk) {
      const remote = `origin/${trunk}`
      if (!await refExists(git, remote)) return EMPTY // no remote to be ahead of
      base = remote
    }

    const raw = await git.raw(['diff', '--name-status', `${base}...HEAD`])
    return { baseBranch: base, files: parseNameStatus(raw) }
  } catch {
    return EMPTY
  }
}
