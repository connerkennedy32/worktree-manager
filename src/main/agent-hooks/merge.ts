// Merges our notify-hook into a Claude Code settings object.
//
// This touches the user's GLOBAL config, so the contract is strict: preserve
// everything we did not put there, identify our own entries by EXACT script
// path, and never throw on malformed input. Pure — the caller owns all fs.

// Events we register. Order mirrors a turn's lifecycle. SessionStart is
// deliberately absent: it fires when the agent boots and is still idle awaiting
// input, so registering it would light up rows with nothing to act on.
export const HOOK_EVENTS = [
  'UserPromptSubmit',
  'PostToolUse',
  'PostToolUseFailure',
  'PermissionRequest',
  'Stop',
  'StopFailure',
  'SessionEnd'
] as const

// Tool-scoped events take a matcher; the rest have nothing to match on.
const NEEDS_MATCHER = new Set<string>(['PostToolUse', 'PostToolUseFailure', 'PermissionRequest'])

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

// The command runs through /bin/sh -c, so a scriptPath containing spaces
// (e.g. macOS's "Application Support") must be quoted or the shell splits it.
function quoteCommand(scriptPath: string): string {
  return `"${scriptPath}"`
}

/**
 * Strips every command entry that is ours, dropping husks left behind.
 * Matches both the quoted form we now write and the bare, unquoted form
 * older versions wrote — otherwise a stale unquoted duplicate never gets
 * cleaned up because it no longer string-equals the quoted command we emit.
 */
function withoutOurs(matchers: unknown, scriptPath: string): unknown[] {
  if (!Array.isArray(matchers)) return []
  const kept: unknown[] = []
  const ours = new Set([scriptPath, quoteCommand(scriptPath)])
  for (const matcher of matchers) {
    if (!isObject(matcher)) { kept.push(matcher); continue }
    if (!Array.isArray(matcher.hooks)) { kept.push(matcher); continue }
    const hooks = matcher.hooks.filter(h => !(isObject(h) && typeof h.command === 'string' && ours.has(h.command)))
    // A matcher whose only hook was ours is now empty — drop it rather than
    // leave an empty shell in the user's config.
    if (hooks.length > 0) kept.push({ ...matcher, hooks })
  }
  return kept
}

export function mergeHooks(existing: unknown, scriptPath: string): Record<string, unknown> {
  const settings: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  const existingHooks = isObject(settings.hooks) ? settings.hooks : {}

  const hooks: Record<string, unknown> = {}

  // Carry every event forward minus our exact entry. This preserves the user's
  // hooks and collapses a duplicate of ours before we re-add a single clean one.
  for (const [event, matchers] of Object.entries(existingHooks)) {
    const kept = withoutOurs(matchers, scriptPath)
    if (kept.length > 0) hooks[event] = kept
  }

  for (const event of HOOK_EVENTS) {
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command: quoteCommand(scriptPath) }] }
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*'
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), entry]
  }

  settings.hooks = hooks
  return settings
}
