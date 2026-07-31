import type { CommandOutcome, GtCreateRequest } from '@shared/ipc-types'
import { runCommand, lastLine } from './shell'

export async function gtCreate(
  req: GtCreateRequest,
  onOutput?: (chunk: string) => void
): Promise<CommandOutcome> {
  const branch = req.branch.trim().replace(/\s+/g, '-')
  if (!branch) return { ok: false, message: 'A branch name is required.' }
  if (!req.message.trim()) return { ok: false, message: 'A commit message is required.' }

  const args = ['create', branch]
  // With nothing staged, gt create would make an empty branch and silently leave
  // the changes behind, so stage everything in that case.
  if (req.stageAll) args.push('-a')
  args.push('-m', req.message.trim())

  const { code, output } = await runCommand(req.worktreePath, 'gt', args, onOutput)

  if (code !== 0) return { ok: false, message: lastLine(output) || `gt create exited ${code}.` }
  return { ok: true, message: `Created ${branch}` }
}
