import simpleGit, { type SimpleGit } from 'simple-git'
import type { SyncOutcome } from '@shared/ipc-types'
import { pushEnv, PUSH_OPTS } from './push'
import { resolveTrunk } from './trunk'
import { runGit } from './run'

const head = (git: SimpleGit) => git.raw(['rev-parse', 'HEAD']).then(r => r.trim())

const conflictedPaths = (git: SimpleGit) =>
  git.raw(['diff', '--name-only', '--diff-filter=U']).then(r => r.split('\n').filter(Boolean))

// How many commits the merge brought in, and how many files they touched.
// Best-effort: a summary that can't be computed shouldn't turn a successful
// merge into a reported failure.
async function summarize(git: SimpleGit, before: string, trunk: string): Promise<string> {
  try {
    // Counted against trunk, not HEAD: `before..HEAD` would also count the merge
    // commit itself, reporting one more commit than actually came in.
    const commits = parseInt((await git.raw(['rev-list', '--count', `${before}..${trunk}`])).trim(), 10) || 0
    if (commits === 0) return 'Already up to date.'
    const files = (await git.raw(['diff', '--name-only', `${before}..HEAD`]))
      .split('\n').filter(Boolean).length
    return `Merged ${commits} commit${commits === 1 ? '' : 's'}, ${files} file${files === 1 ? '' : 's'} changed.`
  } catch {
    return 'Merged.'
  }
}

// Bring the worktree's branch up to date with trunk: fetch, then merge trunk in.
//
// Merge rather than rebase — a rebase rewrites commits that may already be
// pushed, and fails outright on a dirty tree, which is the normal state here.
// Like push(), this returns an outcome instead of throwing so git's own message
// (conflicts, auth, non-fast-forward) reaches the panel intact.
export async function syncWithTrunk(
  worktreePath: string,
  onOutput?: (chunk: string) => void
): Promise<SyncOutcome> {
  try {
    const trunk = await resolveTrunk(worktreePath)
    if (!trunk) return { ok: false, message: 'Could not determine the trunk branch.' }

    const git = simpleGit(worktreePath, PUSH_OPTS).env(pushEnv())
    // The two commands a person would type are run through the streaming
    // runner so the popout shows git's own progress output as it happens; the
    // read-only queries around them stay on simple-git and stay silent.
    if (trunk.startsWith('origin/')) {
      // A remote-tracking trunk is only as fresh as the last fetch, so refresh
      // it first. A local-only trunk (no remote) has nothing to fetch.
      await runGit(worktreePath, ['fetch', 'origin', trunk.slice('origin/'.length)], onOutput)
    }
    // Captured before the merge so the summary can diff against it.
    const before = await head(git)
    await runGit(worktreePath, ['merge', '--no-edit', trunk], onOutput)

    // A conflicted merge exits non-zero with an empty stderr, so the exit code
    // alone is a poor signal and simple-git wouldn't even reject on it. Ask the
    // index what actually happened instead.
    const conflicts = await conflictedPaths(git)
    if (conflicts.length) {
      return {
        ok: false,
        message: `Merge conflicts in ${conflicts.length} file${conflicts.length === 1 ? '' : 's'}:\n` +
          `${conflicts.join('\n')}\n\nResolve them, or run \`git merge --abort\` to back out.`
      }
    }
    return { ok: true, message: await summarize(git, before, trunk) }
  } catch (e: any) {
    return { ok: false, message: (e?.stderr || e?.message || String(e)).trim() }
  }
}
