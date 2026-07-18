import { describe, it, expect } from 'vitest'
import { mergeHooks, HOOK_EVENTS } from '../../src/main/agent-hooks/merge'

const SCRIPT = '/cfg/notify-hook.sh'
const QUOTED_SCRIPT = `"${SCRIPT}"`
const OTHER = '/somewhere/user-own-hook.sh'

const entryFor = (settings: any, event: string) =>
  (settings.hooks?.[event] ?? []).flatMap((m: any) => m.hooks ?? [])

describe('mergeHooks', () => {
  it('registers every event we rely on', () => {
    const out = mergeHooks({}, SCRIPT)
    for (const event of HOOK_EVENTS) {
      expect(entryFor(out, event).map((h: any) => h.command)).toContain(QUOTED_SCRIPT)
    }
  })

  it('does not register SessionStart, which fires while the agent is idle', () => {
    expect(HOOK_EVENTS).not.toContain('SessionStart')
    expect(mergeHooks({}, SCRIPT).hooks).not.toHaveProperty('SessionStart')
  })

  it('uses a wildcard matcher for tool-scoped events only', () => {
    const out: any = mergeHooks({}, SCRIPT)
    expect(out.hooks.PostToolUse[0].matcher).toBe('*')
    expect(out.hooks.PermissionRequest[0].matcher).toBe('*')
    expect(out.hooks.Stop[0]).not.toHaveProperty('matcher')
  })

  it('builds command entries of type command, quoting the path so a space in it cannot split the shell command', () => {
    const out: any = mergeHooks({}, SCRIPT)
    expect(out.hooks.Stop[0].hooks[0]).toEqual({ type: 'command', command: QUOTED_SCRIPT })
  })

  it('preserves unrelated top-level settings', () => {
    const out: any = mergeHooks({ model: 'opus', permissions: { allow: ['Bash'] } }, SCRIPT)
    expect(out.model).toBe('opus')
    expect(out.permissions).toEqual({ allow: ['Bash'] })
  })

  it("preserves the user's own hooks on an event we also use", () => {
    const out: any = mergeHooks({
      hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER }] }] }
    }, SCRIPT)
    const commands = entryFor(out, 'Stop').map((h: any) => h.command)
    expect(commands).toContain(OTHER)
    expect(commands).toContain(QUOTED_SCRIPT)
  })

  it('preserves the user hooks on events we never touch', () => {
    const out: any = mergeHooks({
      hooks: { PreCompact: [{ hooks: [{ type: 'command', command: OTHER }] }] }
    }, SCRIPT)
    expect(entryFor(out, 'PreCompact').map((h: any) => h.command)).toEqual([OTHER])
  })

  it('is idempotent: installing twice does not duplicate our entry', () => {
    const once: any = mergeHooks({}, SCRIPT)
    const twice: any = mergeHooks(once, SCRIPT)
    expect(entryFor(twice, 'Stop').filter((h: any) => h.command === QUOTED_SCRIPT)).toHaveLength(1)
    expect(twice).toEqual(once)
  })

  it('drops a matcher husk rather than leaving it empty', () => {
    // A prior install of OURS at the same path is the only hook on an event we
    // also register: merging must collapse it to a single clean entry, never an
    // empty matcher.
    const prior: any = mergeHooks({}, SCRIPT)
    const out: any = mergeHooks(prior, SCRIPT)
    for (const matcher of out.hooks.Stop) {
      expect(Array.isArray(matcher.hooks)).toBe(true)
      expect(matcher.hooks.length).toBeGreaterThan(0)
    }
    expect(entryFor(out, 'Stop').filter((h: any) => h.command === QUOTED_SCRIPT)).toHaveLength(1)
  })

  it('cleans up a stale unquoted duplicate left by an older version of the installer', () => {
    const stale: any = {
      hooks: { Stop: [{ hooks: [{ type: 'command', command: SCRIPT }] }] }
    }
    const out: any = mergeHooks(stale, SCRIPT)
    const commands = entryFor(out, 'Stop').map((h: any) => h.command)
    expect(commands.filter((c: string) => c === SCRIPT || c === QUOTED_SCRIPT)).toEqual([QUOTED_SCRIPT])
  })

  it('tolerates a null or non-object input', () => {
    expect(() => mergeHooks(null, SCRIPT)).not.toThrow()
    expect(() => mergeHooks('garbage', SCRIPT)).not.toThrow()
    expect(entryFor(mergeHooks(null, SCRIPT), 'Stop').map((h: any) => h.command)).toContain(QUOTED_SCRIPT)
  })

  it('tolerates a malformed hooks section without throwing', () => {
    expect(() => mergeHooks({ hooks: 'nonsense' }, SCRIPT)).not.toThrow()
    expect(() => mergeHooks({ hooks: { Stop: 'nonsense' } }, SCRIPT)).not.toThrow()
    expect(() => mergeHooks({ hooks: { Stop: [{ hooks: 'nope' }] } }, SCRIPT)).not.toThrow()
  })

  it('does not mutate its input', () => {
    const input = { hooks: { Stop: [{ hooks: [{ type: 'command', command: OTHER }] }] } }
    const snapshot = JSON.parse(JSON.stringify(input))
    mergeHooks(input, SCRIPT)
    expect(input).toEqual(snapshot)
  })
})
