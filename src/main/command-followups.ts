import { resolve } from 'node:path'
import { realpathSync } from 'node:fs'
import type { RepoCommand } from '@shared/ipc-types'
import { substituteShell, substituteText } from '@shared/repo-commands'

// The select path is compared against `git worktree list` output, which reports
// real paths — so a symlinked parent (/tmp on macOS) would otherwise never
// match. A path that does not exist yet stays as resolved.
function realIfPossible(path: string): string {
  try { return realpathSync(path) } catch { return path }
}

// Placeholders in these fields follow the same rule as `run`: shell mode quotes
// values for you, plain mode inserts them verbatim.
export function resolveFollowUps(
  command: RepoCommand,
  cwd: string,
  vars: Record<string, string>
): { select?: string; terminal?: string[] } {
  const sub = (text: string): string =>
    command.shell ? substituteShell(text, vars) : substituteText(text, vars)

  const out: { select?: string; terminal?: string[] } = {}
  if (command.select) out.select = realIfPossible(resolve(cwd, substituteText(command.select, vars)))
  if (command.terminal?.length) out.terminal = command.terminal.map(sub)
  return out
}
