import simpleGit, { type SimpleGit } from 'simple-git'
import { resolveTrunk } from './trunk'

// Graphite lands a stack by rebasing and squashing each branch onto trunk, so
// the commits that reach trunk have different shas than the branch's. GitHub
// sees a PR whose head was never merged and marks it *closed* — which reads as
// "abandoned" in the sidebar when the code actually shipped. So for a closed PR
// we stop trusting GitHub and ask git whether this branch's work is in trunk.

// Deliberately not `merge-base --is-ancestor`, which answers through its exit
// code: git exits 1 with an empty stderr, and simple-git resolves that rather
// than rejecting (see trunk.ts's refExists), so every branch would read as an
// ancestor. Comparing the merge base to the tip answers the same question
// through stdout, which simple-git does report faithfully.
async function mergeBase(git: SimpleGit, a: string, b: string): Promise<string> {
  return (await git.raw(['merge-base', a, b])).trim()
}

// `git cherry` compares patch-ids, so it recognizes work replayed onto trunk
// even though every sha changed: one line per commit, '-' where trunk already
// has an equivalent patch and '+' where it doesn't. Every line '-' means the
// whole range landed. An empty range is not an answer, so it reports false.
async function allPatchesInTrunk(git: SimpleGit, trunk: string, head: string): Promise<boolean> {
  const lines = (await git.raw(['cherry', trunk, head])).trim().split('\n').filter(Boolean)
  return lines.length > 0 && lines.every(l => l.startsWith('-'))
}

// Whether this worktree's branch has landed in trunk, sha changes and all.
//
// Three commits' worth of history can reach trunk as one squashed commit, whose
// patch-id matches none of them individually — so a per-commit `git cherry` says
// "not upstream" for exactly the workflow this exists to detect. The fix is to
// ask the question about a squashed version of the branch: commit-tree builds a
// throwaway single commit carrying the branch's whole tree, hung off the merge
// base, which is precisely the shape of what a squash-merge put into trunk. It's
// a dangling object git reaps on its own.
//
// Read-only and local. No fetch: a manual PR refresh shouldn't stall on the
// network, so a branch landed since the last fetch stays 'closed' until trunk
// catches up. Any git failure answers false — a wrong "merged" is worse than a
// stale "closed".
export async function isLandedInTrunk(worktreePath: string): Promise<boolean> {
  try {
    const git = simpleGit(worktreePath)
    const trunk = await resolveTrunk(worktreePath)
    if (!trunk) return false

    const head = (await git.raw(['rev-parse', 'HEAD'])).trim()
    const base = await mergeBase(git, trunk, head)
    // A plain merge leaves the branch tip in trunk's history, which makes the
    // tip its own merge base with trunk. Nothing else to check.
    if (base === head) return true

    // A rebase-and-land keeps one trunk commit per branch commit, so trunk holds
    // an equivalent patch for each of them.
    if (await allPatchesInTrunk(git, trunk, head)) return true

    const tree = (await git.raw(['rev-parse', 'HEAD^{tree}'])).trim()
    const probe = (await git.raw(['commit-tree', tree, '-p', base, '-m', 'squash probe'])).trim()
    return await allPatchesInTrunk(git, trunk, probe)
  } catch {
    return false
  }
}
