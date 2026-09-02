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

// A newline inside a substituted value would end the typed command at the tty
// and run the rest as the next one, so line breaks in a value collapse to a
// space — in the value only, never in the author's own template text. Quoting is
// left alone: shell mode quotes values, plain mode inserts them as written.
function withoutLineBreaks(vars: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(vars).map(([k, v]) => [k, v.replace(/[\r\n]+/g, ' ')]))
}

export function resolveFollowUps(
  command: RepoCommand,
  cwd: string,
  vars: Record<string, string>
): { select?: string; terminal?: string[] } {
  const lineVars = withoutLineBreaks(vars)
  const sub = (text: string): string =>
    command.shell ? substituteShell(text, lineVars) : substituteText(text, lineVars)

  const out: { select?: string; terminal?: string[] } = {}
  if (command.select) out.select = realIfPossible(resolve(cwd, substituteText(command.select, vars)))
  if (command.terminal?.length) out.terminal = command.terminal.map(sub)
  return out
}
