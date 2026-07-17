// Merges our notify-hook into a Claude Code settings object.
//
// This touches the user's GLOBAL config, so the contract is strict: preserve
// everything we did not put there, identify our own entries solely by script
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

export function mergeHooks(existing: unknown, scriptPath: string): Record<string, unknown> {
  const settings: Record<string, unknown> = isObject(existing) ? { ...existing } : {}
  const existingHooks = isObject(settings.hooks) ? settings.hooks : {}

  const hooks: Record<string, unknown> = {}

  // Carry every event forward minus our entries. This both preserves the user's
  // hooks and cleans up our own stale installs from a previous script path.
  for (const [event, matchers] of Object.entries(existingHooks)) {
    const kept: unknown[] = []
    if (Array.isArray(matchers)) {
      for (const matcher of matchers) {
        if (!isObject(matcher)) { kept.push(matcher); continue }
        if (!Array.isArray(matcher.hooks)) { kept.push(matcher); continue }

        // Check if all command hooks in this matcher are ours (identified by 'notify-hook.sh')
        const commandHooks = matcher.hooks.filter(h => isObject(h) && h.type === 'command')
        const ourCommandHooks = commandHooks.filter(h =>
          typeof (h as any).command === 'string' && (h as any).command.includes('notify-hook.sh')
        )

        // If all command hooks are ours (stale from old install), skip this matcher entirely
        if (ourCommandHooks.length === commandHooks.length && commandHooks.length > 0) {
          continue
        }

        // Otherwise, filter out our current scriptPath and keep the rest
        const filteredHooks = matcher.hooks.filter(h => !(isObject(h) && (h as any).command === scriptPath))
        // A matcher whose only hook was ours is now empty — drop it rather than
        // leave an empty shell in the user's config.
        if (filteredHooks.length > 0) kept.push({ ...matcher, hooks: filteredHooks })
      }
    }
    if (kept.length > 0) hooks[event] = kept
  }

  for (const event of HOOK_EVENTS) {
    const entry: Record<string, unknown> = { hooks: [{ type: 'command', command: scriptPath }] }
    if (NEEDS_MATCHER.has(event)) entry.matcher = '*'
    hooks[event] = [...(Array.isArray(hooks[event]) ? hooks[event] as unknown[] : []), entry]
  }

  settings.hooks = hooks
  return settings
}
