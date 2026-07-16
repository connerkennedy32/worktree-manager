import simpleGit, { type SimpleGit } from 'simple-git'
import type { PushOutcome } from '@shared/ipc-types'
import { resolveTrunk } from './trunk'

export interface PushState {
  branch: string
  hasUpstream: boolean
  ahead: number
}

// simple-git's .env() *replaces* the child's environment rather than extending
// it, so anything git needs has to be named here. Deliberately minimal:
//
//   PATH          - find git and ssh
//   HOME          - read ~/.ssh/config and ~/.gitconfig
//   SSH_AUTH_SOCK - reach the ssh agent; without it an SSH push can't auth
//
// Inheriting the full environment instead would be fragile: simple-git rejects
// a whole family of env vars it considers injectable (EDITOR, PAGER, ASKPASS,
// …), so any shell exporting one would break the push with a message about
// allowUnsafeEditor rather than anything to do with pushing.
function pushEnv(): Record<string, string> {
  const keep = ['PATH', 'HOME', 'SSH_AUTH_SOCK'] as const
  const env: Record<string, string> = {}
  for (const k of keep) if (process.env[k]) env[k] = process.env[k]!

  // Without these, git blocks on a credential prompt and ssh blocks on a
  // passphrase prompt — against a terminal that isn't there, so the button
  // would spin forever. Fail fast with a readable message instead.
  env.GIT_TERMINAL_PROMPT = '0'
  env.GIT_SSH_COMMAND = 'ssh -o BatchMode=yes'
  return env
}

// simple-git blocks GIT_SSH_COMMAND by default, since an attacker-supplied value
// would run arbitrary code. Ours is the constant above, never user input, so the
// opt-in is narrow and deliberate.
const PUSH_OPTS = { unsafe: { allowUnsafeSshCommand: true } }

// A branch with no upstream needs one established; otherwise git push already
// knows where to go. The remote is always 'origin', as everywhere else here.
export function pushArgs(branch: string, hasUpstream: boolean): string[] {
  return hasUpstream ? ['push'] : ['push', '-u', 'origin', branch]
}

async function upstreamOf(git: SimpleGit): Promise<string | undefined> {
  return git.raw(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'])
    .then(r => r.trim() || undefined, () => undefined)
}

const countBetween = (git: SimpleGit, base: string) =>
  git.raw(['rev-list', '--count', `${base}..HEAD`]).then(r => parseInt(r.trim(), 10) || 0)

// How many commits this worktree has that the remote doesn't.
//
// Two cases, because a worktree-per-branch workflow means most branches have
// never been pushed and have no @{u} to compare against:
//   - upstream exists -> commits ahead of it
//   - no upstream     -> commits since the branch left trunk
//
// Local only; no fetch. The count can be stale if the remote moved, which is
// fine: the push itself reports the truth.
export async function getPushState(worktreePath: string): Promise<PushState> {
  const git = simpleGit(worktreePath)
  try {
    const branch = (await git.raw(['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    // Detached HEAD can't be pushed without naming a ref — out of scope.
    if (branch === 'HEAD') return { branch, hasUpstream: false, ahead: 0 }

    const upstream = await upstreamOf(git)
    if (upstream) return { branch, hasUpstream: true, ahead: await countBetween(git, upstream) }

    const trunk = await resolveTrunk(worktreePath)
    if (!trunk) return { branch, hasUpstream: false, ahead: 0 }
    return { branch, hasUpstream: false, ahead: await countBetween(git, trunk) }
  } catch {
    // Best-effort, as getCommittedFiles is: a broken count hides the button
    // rather than breaking the panel.
    return { branch: '', hasUpstream: false, ahead: 0 }
  }
}

// Returns an outcome rather than throwing: Electron wraps a thrown main-process
// error as "Error invoking remote method '...'", burying git's message — and
// showing git's message is the whole point when a push is rejected.
export async function push(worktreePath: string): Promise<PushOutcome> {
  try {
    const git = simpleGit(worktreePath, PUSH_OPTS).env(pushEnv())
    const { branch, hasUpstream } = await getPushState(worktreePath)
    if (!branch) return { ok: false, message: 'Could not determine the current branch.' }
    await git.raw(pushArgs(branch, hasUpstream))
    return { ok: true }
  } catch (e: any) {
    return { ok: false, message: (e?.stderr || e?.message || String(e)).trim() }
  }
}
