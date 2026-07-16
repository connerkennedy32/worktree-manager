import simpleGit, { type SimpleGit } from 'simple-git'

// Check the output, not the rejection. `--quiet` makes git exit 1 with an empty
// stderr for a missing ref, and simple-git resolves that rather than rejecting —
// so the obvious `.then(() => true, () => false)` reports every ref as existing.
export async function refExists(git: SimpleGit, ref: string): Promise<boolean> {
  return git.raw(['rev-parse', '--verify', '--quiet', ref])
    .then(out => out.trim() !== '', () => false)
}

// Resolving trunk costs a `symbolic-ref` plus up to four `rev-parse --verify`
// probes (~15ms), and getCommittedFiles re-resolves on every status change —
// which the file watcher can drive several times a second. Trunk doesn't move
// during a session, so cache it per worktree path. If someone repoints
// origin/HEAD mid-session the answer goes stale until restart; the cost of that
// is a wrong diff base, not lost work.
const cache = new Map<string, string | undefined>()

export function clearTrunkCache() { cache.clear() }

async function resolve(git: SimpleGit): Promise<string | undefined> {
  const originHead = await git
    .raw(['symbolic-ref', 'refs/remotes/origin/HEAD'])
    .then(r => r.trim().replace('refs/remotes/origin/', ''))
    .catch(() => '')
  // Prefer the remote ref. The local trunk is a personal copy that drifts — an
  // unpushed commit, a checkout nobody has pulled in a week — and every drift
  // would otherwise seed new branches and show up as their committed files.
  // origin/<trunk> is what a PR is actually diffed against. Local branches are
  // the fallback for repos with no remote.
  const candidates = [`origin/${originHead}`, originHead, 'origin/main', 'main', 'origin/master', 'master']
  for (const candidate of candidates) {
    if (candidate && candidate !== 'origin/' && await refExists(git, candidate)) return candidate
  }
  return undefined
}

// The repo's trunk branch. Deliberately *not* "whatever the main worktree has
// checked out" — people routinely check a feature branch out in the main
// worktree, which would make the trunk look like the feature branch itself and
// leave nothing to compare against. `origin/HEAD` is the remote's declared
// default; local main/master are the fallback for remote-less repos.
export async function resolveTrunk(worktreePath: string): Promise<string | undefined> {
  // has() rather than get() — undefined is a real, cacheable answer.
  if (cache.has(worktreePath)) return cache.get(worktreePath)
  const trunk = await resolve(simpleGit(worktreePath))
  cache.set(worktreePath, trunk)
  return trunk
}
