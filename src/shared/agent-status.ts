// The agent status model. Pure: shared verbatim by the daemon (which maps
// incoming hook events) and the renderer (which decides what to draw).

export type RawStatus = 'none' | 'working' | 'permission' | 'done' | 'failed'

export interface AgentReport {
  status: RawStatus
  at: number
  // One line describing what the agent is doing right now — "Editing retry.ts",
  // or the request you typed. Derived from the hook payload (see
  // describeActivity) and held in memory only: it is the contents of your work,
  // and nothing the app writes to disk needs it.
  activity?: string
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

// Long enough for a real sentence, short enough that a card stays a card. The
// cap is applied here rather than in CSS so an enormous prompt never travels
// through the socket or sits in memory.
export const MAX_ACTIVITY = 120

// The last field of a path, for naming a file without its directory.
function base(path: string): string {
  return path.split('/').filter(Boolean).pop() ?? path
}

// First line only, collapsed and trimmed. A prompt is often several paragraphs;
// its opening line is what it is about.
function oneLine(text: string): string {
  const line = text.split('\n').map(l => l.trim()).find(l => l.length > 0) ?? ''
  const clean = line.replace(/\s+/g, ' ')
  return clean.length > MAX_ACTIVITY ? `${clean.slice(0, MAX_ACTIVITY - 1).trimEnd()}…` : clean
}

// What a hook payload says the agent is doing, or undefined for an event that
// says nothing worth showing. Pure and total: the payload comes from another
// program's format, so every field is treated as maybe-absent and maybe-wrong.
//
// Written from the agent's side ("Editing x") rather than the app's ("Edit"),
// because the card is read as a sentence about what is happening.
export function describeActivity(payload: unknown): string | undefined {
  const p = payload as Record<string, any> | null
  if (!p || typeof p !== 'object') return undefined
  const event = typeof p.hook_event_name === 'string' ? p.hook_event_name : ''

  // The turn's own subject: what you asked for. Stays on the card for the whole
  // turn, under whatever tool line is current.
  if (event === 'UserPromptSubmit') {
    return typeof p.prompt === 'string' && p.prompt.trim() ? oneLine(p.prompt) : undefined
  }
  // A finished or abandoned turn has nothing in flight to describe.
  if (event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd') return undefined

  const tool = typeof p.tool_name === 'string' ? p.tool_name : ''
  if (!tool) return undefined
  const input = (p.tool_input ?? {}) as Record<string, any>
  const str = (v: unknown): string => (typeof v === 'string' ? v : '')

  switch (tool) {
    case 'Edit':
    case 'MultiEdit':
    case 'Write':
    case 'NotebookEdit': {
      const file = str(input.file_path ?? input.notebook_path)
      return file ? oneLine(`Editing ${base(file)}`) : 'Editing a file'
    }
    case 'Read': {
      const file = str(input.file_path)
      return file ? oneLine(`Reading ${base(file)}`) : 'Reading a file'
    }
    case 'Bash': {
      const command = str(input.command)
      return command ? oneLine(`Running ${command}`) : 'Running a command'
    }
    case 'Grep': {
      const pattern = str(input.pattern)
      return pattern ? oneLine(`Searching for ${pattern}`) : 'Searching the code'
    }
    case 'Glob': {
      const pattern = str(input.pattern)
      return pattern ? oneLine(`Looking for ${pattern}`) : 'Looking through files'
    }
    case 'WebFetch': {
      const url = str(input.url)
      // Host only: a full URL is mostly query string and would fill the card.
      const host = url.replace(/^https?:\/\//, '').split('/')[0]
      return host ? oneLine(`Fetching ${host}`) : 'Fetching a page'
    }
    case 'WebSearch': {
      const query = str(input.query)
      return query ? oneLine(`Searching the web for ${query}`) : 'Searching the web'
    }
    case 'Task': return 'Running a subagent'
    case 'TodoWrite': return 'Updating its plan'
    // An unknown tool still says something true, including MCP tools, whose
    // names arrive as mcp__server__tool.
    default: return oneLine(`Running ${tool.replace(/^mcp__/, '').replace(/__/g, ' · ')}`)
  }
}

/**
 * Decides what dot to draw, or null for none.
 *
 * `done` is seen-gated: a turn that finished before the user last visited that
 * worktree is old news and draws nothing, which is what makes any visible dot
 * mean "unhandled". `permission` and `failed` are live states — visiting the
 * tab neither answers a permission prompt nor fixes an error — so they are not
 * gated and persist until the agent itself moves on.
 *
 * `unread` is the user marking a worktree "come back to this" by hand. It draws
 * the same green dot as a finished turn — same meaning, "unhandled, mine to
 * look at" — and works on a worktree no agent has ever touched. It loses to the
 * live states rather than overriding them: a worktree waiting on a permission
 * prompt has something more urgent to say than a note-to-self.
 */
export function deriveDot(
  report: AgentReport | undefined, seenAt: number | undefined, unread = false
): DotState | null {
  switch (report?.status) {
    case 'working': return 'working'
    case 'permission': return 'permission'
    case 'failed': return 'failed'
    case 'done': return report.at > (seenAt ?? 0) ? 'done' : unread ? 'done' : null
    default: return unread ? 'done' : null
  }
}
