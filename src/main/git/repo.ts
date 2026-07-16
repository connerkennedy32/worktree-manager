import simpleGit from 'simple-git'
import { realpathSync } from 'fs'

// Ensure a picked directory is the ROOT of a git repository — not a subfolder of
// a larger repo (which would make git status/worktree report the parent repo and
// all its siblings) and not a non-repo. Returns the canonical repo root path.
export async function validateRepoSelection(dir: string): Promise<string> {
  let top: string
  try {
    top = (await simpleGit(dir).raw(['rev-parse', '--show-toplevel'])).trim()
  } catch {
    throw new Error(`Not a git repository:\n${dir}\n\nRun "git init" there first, or pick a folder that is a git repo.`)
  }
  const real = realpathSync(dir)
  const realTop = realpathSync(top)
  if (real !== realTop) {
    throw new Error(
      `That folder is inside a larger git repository.\n\nIts repo root is:\n${realTop}\n\n` +
      `Pick the repo root instead, or make this folder its own repo with "git init".`
    )
  }
  return realTop
}
