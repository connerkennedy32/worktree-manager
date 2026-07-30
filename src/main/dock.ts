import { app } from 'electron'
import type { AgentReport, RawStatus } from '@shared/agent-status'

// Live agent status per worktree, mirrored from the daemon's reports so the Dock
// badge can summarise every worktree at once (the in-app dots only cover the
// rows currently on screen).
const statuses = new Map<string, RawStatus>()

// Cycling the badge text is what makes "an agent is still going" read as motion,
// and it costs nothing but a timer — animating the icon image itself would mean
// pre-rendered frame assets, since the main process has no canvas to draw on.
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export const SPINNER_LENGTH = SPINNER.length

// 100ms is about the floor worth asking for: below it the Dock's own badge
// redraw becomes the limiter and the extra wakeups buy nothing visible.
export const SPINNER_INTERVAL_MS = 100

// How long the finished-turn checkmark stays up. Long enough to catch the eye
// away from the window's centre, short enough that it never reads as a live
// state the way a lingering badge would.
export const DONE_FLASH_MS = 2000

/**
 * The Dock badge text for a set of live agent statuses, at a given animation
 * frame.
 *
 * A spinner means "something is still running" — how many are running is not
 * part of that signal, and the in-app rows already say which worktrees they are.
 * Waiting-on-permission outranks everything: a blocked agent needs the user, and
 * a spinner would misread as progress, so it shows a static '?' instead. The
 * finished-turn '✓' outranks the spinner, since a turn landing is news and the
 * spinner resumes on its own once the flash expires. Nothing running, nothing
 * blocked, nothing just-finished means no badge at all — a stale badge is worse
 * than none.
 */
export function badgeText(statuses: Iterable<RawStatus>, frame = 0, flashingDone = false): string {
  let working = false
  let permission = false
  for (const s of statuses) {
    if (s === 'working') working = true
    if (s === 'permission') permission = true
  }
  if (permission) return '?'
  if (flashingDone) return '✓'
  if (!working) return ''
  return SPINNER[((frame % SPINNER.length) + SPINNER.length) % SPINNER.length]
}

export function setAgentStatus(path: string, report: AgentReport) {
  if (report.status === 'none') statuses.delete(path)
  else statuses.set(path, report.status)
  render()
}

export function seedAgentStatuses(reports: Record<string, AgentReport>) {
  statuses.clear()
  for (const [path, r] of Object.entries(reports)) {
    if (r.status !== 'none') statuses.set(path, r.status)
  }
  render()
}

/**
 * Briefly badge the Dock with a checkmark for a turn that just finished.
 *
 * The caller decides when this is warranted — an unfocused window already gets
 * a Dock bounce, so this exists for the on-screen case, where a bounce is
 * invisible and the in-app dot may be on a row the user isn't looking at.
 */
export function flashDone() {
  if (flashTimer) clearTimeout(flashTimer)
  flashTimer = setTimeout(() => { flashTimer = undefined; render() }, DONE_FLASH_MS)
  flashTimer.unref()
  render()
}

let frame = 0
let timer: NodeJS.Timeout | undefined
let flashTimer: NodeJS.Timeout | undefined

function render() {
  // setBadge is macOS-only; on other platforms it is a no-op that can still throw
  // when the Dock module is absent, so gate on the platform.
  if (process.platform !== 'darwin') return
  app.dock?.setBadge(badgeText(statuses.values(), frame, flashTimer !== undefined))
  // Only animate while a spinner is what the badge would be showing: the timer
  // wakes the main process every tick, so it must not outlive the work it
  // represents. Note this asks the question ignoring the flash — a '✓' covering
  // a still-working agent must keep the clock running so the spinner picks back
  // up mid-rotation when the flash expires.
  const animating = SPINNER.includes(badgeText(statuses.values(), frame))
  if (animating && !timer) {
    timer = setInterval(() => { frame++; render() }, SPINNER_INTERVAL_MS)
    // A badge animation is not a reason to keep the process alive at exit.
    timer.unref()
  } else if (!animating && timer) {
    clearInterval(timer)
    timer = undefined
    frame = 0
  }
}
