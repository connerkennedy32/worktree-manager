// Owns per-worktree agent status inside the daemon.
//
// Hooks are the source of truth: Claude tells us what it is doing. The sweep is
// only a backstop for the one thing hooks cannot report — an agent killed
// without firing SessionEnd, which would otherwise leave a row stuck forever.
// It may only clear a status, never set one.

import { mapHookEvent, type AgentReport } from '@shared/agent-status'
import { hasAgentDescendantThroughTmux, parseProcessTable, readProcessTable } from './agentProcess'

const SWEEP_MS = 2000

export interface TrackerSessions {
  list(): string[]
  pid(worktreePath: string): number | undefined
  pathForId(id: string): string | undefined
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

  /** Called for each hook POST. `id` is the pty's opaque WTM_TERMINAL_ID. */
  handleHook(id: string, event: string): void {
    const path = this.sessions.pathForId(id)
    if (!path) return // a stale id from a pty that has since exited
    const status = mapHookEvent(event)
    if (!status) return // an event we do not model; never guess

    const at = this.now()
    if (status === 'none') {
      this.reports.delete(path)
    } else {
      this.reports.set(path, { status, at })
    }
    // Always emit, even when the status is unchanged: `at` advancing is itself
    // meaningful, since the renderer gates `done` against when the user last
    // looked at that worktree.
    this.emit(path, { status, at })
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
