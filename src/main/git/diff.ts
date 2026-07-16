import simpleGit from 'simple-git'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { DiffFile, StageRequest, CommitRequest, FileDiffRequest, StagePathRequest } from '@shared/ipc-types'

// Split `git diff` output into one unified patch per file.
function splitPatches(raw: string): { path: string; oldPath: string; rawPatch: string }[] {
  if (!raw.trim()) return []
  const chunks = raw.split(/(?=^diff --git )/m).filter(c => c.startsWith('diff --git'))
  return chunks.map(rawPatch => {
    const m = rawPatch.match(/^diff --git a\/(.+?) b\/(.+?)$/m)
    const oldPath = m ? m[1] : ''
    const path = m ? m[2] : ''
    return { path, oldPath, rawPatch: rawPatch.endsWith('\n') ? rawPatch : rawPatch + '\n' }
  })
}

export async function getDiff(worktreePath: string): Promise<DiffFile[]> {
  const git = simpleGit(worktreePath)
  const unstaged = await git.raw(['diff'])
  const untracked = (await git.raw(['ls-files', '--others', '--exclude-standard']))
    .split('\n').filter(Boolean)
  let untrackedDiff = ''
  for (const f of untracked) {
    // `git diff --no-index` exits 1 when files differ; capture its stdout from the thrown error.
    untrackedDiff += await git
      .raw(['diff', '--no-index', '--', '/dev/null', f])
      .catch((e: any) => e?.stdout ?? '')
  }
  const staged = await git.raw(['diff', '--cached'])
  const files: DiffFile[] = []
  for (const p of splitPatches(unstaged + untrackedDiff)) files.push({ ...p, hunks: [], staged: false })
  for (const p of splitPatches(staged)) files.push({ ...p, hunks: [], staged: true })
  return files
}

// Fetch the unified diff for a single file, on demand (lazy — only when the user
// expands that file), so opening the changes panel never computes every patch.
export async function getFileDiff(req: FileDiffRequest): Promise<string> {
  const git = simpleGit(req.worktreePath)
  if (req.baseRef) return git.raw(['diff', `${req.baseRef}...HEAD`, '--', req.path])
  if (req.untracked) {
    return git.raw(['diff', '--no-index', '--', '/dev/null', req.path]).catch((e: any) => e?.stdout ?? '')
  }
  if (req.staged) return git.raw(['diff', '--cached', '--', req.path])
  return git.raw(['diff', '--', req.path])
}

// Stage/unstage a whole file by path — instant, no patch generation needed.
export async function stagePath(req: StagePathRequest): Promise<void> {
  const git = simpleGit(req.worktreePath)
  if (req.unstage) await git.raw(['reset', '-q', '--', req.path])
  else await git.raw(['add', '--', req.path])
}

export async function stage(req: StageRequest): Promise<void> {
  const git = simpleGit(req.worktreePath)
  const dir = mkdtempSync(join(tmpdir(), 'wtm-patch-'))
  const pf = join(dir, 'p.diff')
  writeFileSync(pf, req.patch.endsWith('\n') ? req.patch : req.patch + '\n')
  const args = ['apply', '--cached', '--whitespace=nowarn']
  if (req.reverse) args.push('--reverse')
  args.push(pf)
  try {
    await git.raw(args)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

export async function commit(req: CommitRequest): Promise<void> {
  const git = simpleGit(req.worktreePath)
  await git.commit(req.message)
}
