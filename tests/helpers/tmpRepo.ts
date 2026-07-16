import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import simpleGit, { type SimpleGit } from 'simple-git'

export async function makeTmpRepo(): Promise<{ dir: string; git: SimpleGit; cleanup: () => void }> {
  const dir = mkdtempSync(join(tmpdir(), 'wtm-'))
  const git = simpleGit(dir)
  await git.init(['--initial-branch=main'])
  await git.addConfig('user.email', 'test@test.dev')
  await git.addConfig('user.name', 'Test')
  writeFileSync(join(dir, 'README.md'), '# temp\n')
  await git.add('.')
  await git.commit('initial')
  return { dir, git, cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}
