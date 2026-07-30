import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit, { type SimpleGit } from 'simple-git'

// Retried: git leaves background work (auto-gc after a fetch) writing into .git,
// and a plain rmSync racing it fails with ENOTEMPTY.
const removeDir = (dir: string) =>
  rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 })

export async function makeTmpRepo(): Promise<{ dir: string; git: SimpleGit; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-'))
  const git = simpleGit(dir)
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.email', 'test@test.dev')
  await git.addConfig('user.name', 'Test')
  // Background housekeeping outlives the test that triggered it and keeps
  // writing into .git while cleanup is deleting it — an ENOTEMPTY that fails a
  // test for reasons unrelated to what it asserts. These repos live seconds; no
  // housekeeping is wanted.
  await git.addConfig('gc.auto', '0')
  await git.addConfig('maintenance.auto', 'false')
  writeFileSync(join(dir, 'README.md'), '# temp\n')
  await git.add('.')
  await git.commit('initial')
  return { dir, git, cleanup: () => removeDir(dir) }
}

// Give a repo an `origin` remote with a real main branch, so origin/main resolves.
// Returns a cleanup for the bare remote it creates.
export async function withOrigin(dir: string): Promise<() => void> {
  const remote = mkdtempSync(join(tmpdir(), 'wtm-remote-'))
  await simpleGit(remote).init(['--bare', '--initial-branch=main'])
  const git = simpleGit(dir)
  await git.addRemote('origin', remote)
  await git.push(['-u', 'origin', 'main'])
  return () => removeDir(remote)
}
