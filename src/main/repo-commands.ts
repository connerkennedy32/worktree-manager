import type { CommandOutcome, RunRepoCommandRequest } from '@shared/ipc-types'
import { promptVars, substitute, tokenize } from '@shared/repo-commands'
import { runCommand, lastLine } from './shell'
import { repoRoot } from './git/repo-root'

export async function runRepoCommand(
  req: RunRepoCommandRequest,
  onOutput?: (chunk: string) => void
): Promise<CommandOutcome> {
  const { command } = req
  const root = await repoRoot(req.worktreePath)
  const cwd = command.cwd === 'repo' ? root : req.worktreePath

  const vars: Record<string, string> = {
    worktree: req.worktreePath,
    repo: root,
    branch: req.branch ?? '',
    message: req.message ?? ''
  }
  for (const name of promptVars(command.run)) {
    const value = req.inputs?.[name]?.trim()
    if (!value) return { ok: false, message: `${name} is required.` }
    vars[name] = value
  }

  const [file, ...args] = substitute(tokenize(command.run), vars)
  if (!file) return { ok: false, message: 'This command is empty.' }

  const { code, output } = await runCommand(cwd, file, args, onOutput)
  if (code !== 0) return { ok: false, message: lastLine(output) || `${file} exited ${code}.` }
  return { ok: true, message: `${command.label} done` }
}
