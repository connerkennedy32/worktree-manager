// The agent status model. Pure: shared verbatim by the daemon (which maps
// incoming hook events) and the renderer (which decides what to draw).

export type RawStatus = 'none' | 'working' | 'permission' | 'done' | 'failed'

export interface AgentReport {
  status: RawStatus
  at: number
}

export type DotState = 'working' | 'permission' | 'failed' | 'done'

// Claude Code hook event names -> our status. Events absent from this table are
// ignored rather than guessed at. SessionStart is deliberately absent: it fires
// when the agent boots and is still idle awaiting input, which is not a working
// state and gives the user nothing to act on.
const EVENTS: Record<string, RawStatus> = {
  UserPromptSubmit: 'working',
  // A turn can run many tools; each one re-asserts working so a long turn
  // never decays to done.
  PostToolUse: 'working',
  // A failed tool call does not end the turn — the agent is still going.
  PostToolUseFailure: 'working',
  PermissionRequest: 'permission',
  Stop: 'done',
  StopFailure: 'failed',
  SessionEnd: 'none'
}

export function mapHookEvent(event: string): RawStatus | null {
  return EVENTS[event] ?? null
}

/**
 * Decides what dot to draw, or null for none.
 *
 * `done` is seen-gated: a turn that finished before the user last visited that
 * worktree is old news and draws nothing, which is what makes any visible dot
 * mean "unhandled". `permission` and `failed` are live states — visiting the
 * tab neither answers a permission prompt nor fixes an error — so they are not
 * gated and persist until the agent itself moves on.
 */
export function deriveDot(report: AgentReport | undefined, seenAt: number | undefined): DotState | null {
  if (!report) return null
  switch (report.status) {
    case 'working': return 'working'
    case 'permission': return 'permission'
    case 'failed': return 'failed'
    case 'done': return report.at > (seenAt ?? 0) ? 'done' : null
    case 'none': return null
  }
}
