import { dirname } from 'node:path'
import simpleGit from 'simple-git'

// The main checkout, where repo-level scripts belong. A linked worktree's .git
// common dir sits inside it, so its parent is that checkout.
export async function repoRoot(worktreePath: string): Promise<string> {
  const common = (await simpleGit(worktreePath)
    .raw(['rev-parse', '--path-format=absolute', '--git-common-dir'])).trim()
  return dirname(common)
}
