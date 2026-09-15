// Owns per-worktree agent status inside the daemon.
//
// Hooks are the source of truth: Claude tells us what it is doing. The sweep is
// only a backstop for the one thing hooks cannot report — an agent killed
// without firing SessionEnd, which would otherwise leave a row stuck forever.
// It may only clear a status, never set one.

import { describeActivity, mapHookEvent, type AgentReport } from '@shared/agent-status'
import { hasAgentDescendantThroughTmux, parseProcessTable, readProcessTable } from './agentProcess'

const SWEEP_MS = 2000

export interface TrackerSessions {
  list(): string[]
  pid(worktreePath: string): number | undefined
  pathForCwd(cwd: string): string | undefined
}

export class AgentTracker {
  private reports = new Map<string, AgentReport>()
  private timer?: ReturnType<typeof setInterval>

  constructor(
    private sessions: TrackerSessions,
    private emit: (path: string, report: AgentReport) => void,
    private readTable: () => Promise<string> = readProcessTable,
    private now: () => number = Date.now
  ) {}

  /**
   * Called for each hook POST. `cwd` is the agent's working directory, and
   * `payload` is Claude Code's own hook JSON when it was small enough to
   * forward — the source of the one-line activity shown on a card.
   */
  handleHook(cwd: string, event: string, payload?: unknown): void {
    const path = this.sessions.pathForCwd(cwd)
    if (!path) return // a cwd outside any live worktree session
    const status = mapHookEvent(event)
    if (!status) return // an event we do not model; never guess

    const at = this.now()
    // A tool event describes itself; a prompt describes the whole turn, and
    // nothing after it says what the turn is about — so a described event
    // replaces the line, and one that describes nothing keeps what stands.
    // Ending the turn drops it: there is no longer anything in flight.
    const described = payload === undefined ? undefined : describeActivity(payload)
    const ends = status === 'done' || status === 'failed' || status === 'none'
    const activity = ends ? undefined : described ?? this.reports.get(path)?.activity

    if (status === 'none') {
      this.reports.delete(path)
    } else {
      this.reports.set(path, { status, at, activity })
    }
    // Always emit, even when the status is unchanged: `at` advancing is itself
    // meaningful, since the renderer gates `done` against when the user last
    // looked at that worktree.
    this.emit(path, { status, at, activity })
  }

  /**
   * Clears statuses whose agent is gone. Skips the `ps` entirely when nothing is
   * active, so an idle machine does no work.
   */
  async sweep(): Promise<void> {
    if (this.reports.size === 0) return

    let entries
    try {
      entries = parseProcessTable(await this.readTable())
    } catch {
      return // a failed ps is transient; keep what we have
    }

    const live = new Set(this.sessions.list())
    for (const path of [...this.reports.keys()]) {
      const pid = this.sessions.pid(path)
      const gone = !live.has(path) || pid === undefined || !hasAgentDescendantThroughTmux(entries, pid)
      if (!gone) continue
      this.reports.delete(path)
      this.emit(path, { status: 'none', at: this.now() })
    }
  }

  snapshot(): Record<string, AgentReport> {
    return Object.fromEntries(this.reports)
  }

  start() {
    if (this.timer) return
    this.timer = setInterval(() => { void this.sweep() }, SWEEP_MS)
    this.timer.unref?.()
  }

  stop() {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}
