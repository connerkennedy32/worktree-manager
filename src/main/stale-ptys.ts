// A worktree removed outside the app — `git worktree remove` from a terminal, or
// a script like roofworx's `delete-worktree` that moves the directory into a
// trash folder — leaves its shell alive in the daemon, still keyed by the old
// path. That matters beyond the wasted process: recreating a worktree at the
// same path finds `ptys.has(path)` already true, so the app reuses the stale
// shell, whose cwd is the directory that moved. Anything typed into it then runs
// somewhere else entirely (a `tmux new` there falls back to $HOME).
//
// Existence is the test, not absence from the worktree list: a path can drop off
// that list while its files are still on disk (a repo disconnected in the
// sidebar), and killing a live terminal for that would lose the user's session.
export function stalePtyPaths(
  known: readonly string[],
  exists: (path: string) => boolean
): string[] {
  return known.filter(path => !exists(path))
}
