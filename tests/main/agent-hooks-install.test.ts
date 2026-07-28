import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

let dir: string
let settings: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wtm-hooks-'))
  settings = join(dir, 'settings.json')
  process.env.WTM_CONFIG_DIR = dir
  process.env.WTM_CLAUDE_SETTINGS = settings
})

describe('installAgentHooks', () => {
  it('writes an executable hook script', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    expect(existsSync(hookScriptPath())).toBe(true)
    // owner-executable bit
    expect(statSync(hookScriptPath()).mode & 0o100).toBeTruthy()
  })

  it('creates settings.json when none exists', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const out = JSON.parse(readFileSync(settings, 'utf8'))
    // The command is shell-quoted so a path with spaces (macOS's "Application
    // Support") survives /bin/sh -c.
    expect(out.hooks.Stop[0].hooks[0].command).toBe(`"${hookScriptPath()}"`)
  })

  it("preserves the user's existing settings", async () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }))
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    expect(JSON.parse(readFileSync(settings, 'utf8')).model).toBe('opus')
  })

  it('backs up the original once', async () => {
    writeFileSync(settings, JSON.stringify({ model: 'opus' }))
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const backup = `${settings}.wtm-backup`
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({ model: 'opus' })

    // A second install must not overwrite the pristine backup with our own output.
    installAgentHooks()
    expect(JSON.parse(readFileSync(backup, 'utf8'))).toEqual({ model: 'opus' })
  })

  it('refuses to touch a settings file it cannot parse', async () => {
    writeFileSync(settings, '{ this is not json')
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    expect(() => installAgentHooks()).not.toThrow()
    expect(readFileSync(settings, 'utf8')).toBe('{ this is not json')
  })

  it('is idempotent across repeated installs', async () => {
    const { installAgentHooks } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const first = readFileSync(settings, 'utf8')
    installAgentHooks()
    expect(readFileSync(settings, 'utf8')).toBe(first)
  })
})

describe('the hook script', () => {
  it('exits silently when the daemon socket is absent', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const { execFileSync } = await import('child_process')
    // No env at all: the baked-in default socket path does not exist here, so
    // the script must exit 0 and emit nothing.
    const out = execFileSync('bash', [hookScriptPath()], {
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: '/wt/a' }),
      env: { PATH: process.env.PATH ?? '' }
    })
    expect(out.toString()).toBe('')
  })

  it('exits silently when $WTM_HOOK_SOCKET points at a missing socket', async () => {
    const { installAgentHooks, hookScriptPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    const { execFileSync } = await import('child_process')
    const out = execFileSync('bash', [hookScriptPath()], {
      input: JSON.stringify({ hook_event_name: 'Stop', cwd: '/wt/a' }),
      env: {
        PATH: process.env.PATH ?? '',
        WTM_HOOK_SOCKET: join(dir, 'does-not-exist.sock')
      }
    })
    expect(out.toString()).toBe('')
  })

  it('bakes the daemon socket path into the generated script', async () => {
    const { installAgentHooks, hookScriptPath, hookSocketPath } = await import('../../src/main/agent-hooks/install')
    installAgentHooks()
    expect(readFileSync(hookScriptPath(), 'utf8')).toContain(hookSocketPath())
  })
})
