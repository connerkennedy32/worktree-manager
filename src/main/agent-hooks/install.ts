// Installs the Claude Code notify-hook: writes the script and registers it in
// the user's global ~/.claude/settings.json.

import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { dirname, join } from 'path'
import { configDir } from '../config'
import { mergeHooks } from './merge'

export function hookScriptPath(): string { return join(configDir(), 'notify-hook.sh') }
export function hookSocketPath(): string { return join(configDir(), 'agent-hook.sock') }

// The env override keeps tests off the developer's real Claude config, mirroring
// WTM_CONFIG_DIR in ../config.
export function claudeSettingsPath(): string {
  return process.env.WTM_CLAUDE_SETTINGS || join(homedir(), '.claude', 'settings.json')
}

// Installed in the user's GLOBAL settings, so this runs for every `claude` on the
// machine, not just ours. The env guard must therefore be the very first thing it
// does, and every path must exit 0 — a broken hook must never disturb a session.
const SCRIPT = `#!/bin/bash
# Worktree Manager agent hook. Generated — edits will be overwritten.
[ -z "$WTM_TERMINAL_ID" ] && exit 0
[ -S "$WTM_HOOK_SOCKET" ] || exit 0

EVENT=$(cat | grep -oE '"hook_event_name"[[:space:]]*:[[:space:]]*"[^"]*"' | grep -oE '"[^"]*"$' | tr -d '"')
# Never guess an event on a parse failure: a wrong "Stop" would falsely clear a
# working indicator. Dropping the event is always safer.
[ -z "$EVENT" ] && exit 0

curl -sS --unix-socket "$WTM_HOOK_SOCKET" \\
  -X POST -H 'Content-Type: application/json' \\
  -d "{\\"id\\":\\"$WTM_TERMINAL_ID\\",\\"event\\":\\"$EVENT\\"}" \\
  --connect-timeout 1 --max-time 2 \\
  http://localhost/hook >/dev/null 2>&1
exit 0
`

/**
 * Idempotent. Safe to call on every app start.
 *
 * Deliberately never throws: failing to install hooks costs the status
 * indicator, which must not be allowed to take the app down with it.
 */
export function installAgentHooks(): void {
  try {
    mkdirSync(configDir(), { recursive: true })
    writeFileSync(hookScriptPath(), SCRIPT, { mode: 0o755 })

    const settingsFile = claudeSettingsPath()
    mkdirSync(dirname(settingsFile), { recursive: true })

    let existing: unknown = {}
    if (existsSync(settingsFile)) {
      const raw = readFileSync(settingsFile, 'utf8')
      try {
        existing = JSON.parse(raw)
      } catch {
        // Someone else's malformed config. Rewriting it would destroy data we
        // cannot read, so leave it alone and go without the indicator.
        console.error('[wtm] ~/.claude/settings.json is not valid JSON; skipping hook install')
        return
      }
      const backup = `${settingsFile}.wtm-backup`
      if (!existsSync(backup)) copyFileSync(settingsFile, backup)
    }

    const merged = mergeHooks(existing, hookScriptPath())

    // Temp-and-rename: a crash mid-write must not leave the user with a
    // truncated Claude config.
    const tmp = `${settingsFile}.wtm-tmp`
    writeFileSync(tmp, `${JSON.stringify(merged, null, 2)}\n`)
    renameSync(tmp, settingsFile)
  } catch (e) {
    console.error('[wtm] failed to install agent hooks:', e)
  }
}
