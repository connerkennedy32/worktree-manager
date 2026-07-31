import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, dirname, join } from 'path'
import simpleGit, { type SimpleGit } from 'simple-git'

// Best-effort, and deliberately so. Git leaves background work writing into
// .git after a fetch or push, so a recursive delete racing it throws ENOTEMPTY.
// Thrown from afterEach, that failed tests whose assertions had all passed —
// and retrying hard enough to win added tens of seconds to the suite. These
// directories live under os.tmpdir(), so the cost of abandoning one is nothing.
export const removeDir = (dir: string) => {
  try {
    rmSync(dir, { recursive: true, force: true, maxRetries: 2, retryDelay: 20 })
  } catch { /* the OS reaps tmp */ }
}

// Where createWorktree() puts this repo's linked worktrees. Every temp repo has
// a random basename, so this subdirectory is unique per repo — whereas its
// parent (`<tmpdir>/.worktrees`) is shared by every test in the run, and
// deleting that wholesale rips out worktrees belonging to tests running in
// parallel in other files.
export const worktreesRoot = (repoDir: string) =>
  join(dirname(repoDir), '.worktrees', basename(repoDir))

// Written straight into .git/config rather than set with four addConfig calls.
// Each of those is its own git process, and this helper runs ~40 times a suite.
//
// gc/maintenance are off because background housekeeping outlives the test that
// triggered it and keeps writing into .git while cleanup is deleting it.
const REPO_CONFIG = `
[user]
\temail = test@test.dev
\tname = Test
[gc]
\tauto = 0
[maintenance]
\tauto = false
`

export async function makeTmpRepo(): Promise<{ dir: string; git: SimpleGit; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-'))
  const git = simpleGit(dir)
  await git.init(['--initial-branch=main'])
  appendFileSync(join(dir, '.git', 'config'), REPO_CONFIG)
  writeFileSync(join(dir, 'README.md'), '# temp\n')
  await git.add('.')
  await git.commit('initial')
  // Linked worktrees go first: they hold references into the host .git, and
  // removing the host out from under them is what leaves .git non-empty.
  return { dir, git, cleanup: () => { removeDir(worktreesRoot(dir)); removeDir(dir) } }
}

// A linked worktree on a new branch, for tests that need one as setup rather
// than as the thing under test. `--no-track` and the explicit `main` start point
// mirror what the app's own creation used to do: without them git starts the
// branch at the invoking repo's HEAD and sets an upstream, which makes the
// worktree look like it already has commits to push.
export async function addWorktree(repoDir: string, branch: string): Promise<string> {
  const dir = join(worktreesRoot(repoDir), branch.replace(/[/\\]/g, '-'))
  await simpleGit(repoDir).raw(['worktree', 'add', '--no-track', '-b', branch, dir, 'main'])
  return dir
}

// Give a repo an `origin` remote with a real main branch, so origin/main resolves.
// Returns a cleanup for the bare remote it creates.
export async function withOrigin(dir: string): Promise<() => void> {
  const remote = mkdtempSync(join(tmpdir(), 'wtm-remote-'))
  await simpleGit(remote).init(['--bare', '--initial-branch=main'])
  appendFileSync(join(remote, 'config'), REPO_CONFIG)
  const git = simpleGit(dir)
  await git.addRemote('origin', remote)
  await git.push(['-u', 'origin', 'main'])
  return () => removeDir(remote)
}
