import { describe, it, expect, afterEach } from 'vitest'
import { homedir } from 'os'
import { PtyManager } from '../../src/main/pty-daemon/sessionStore'

let mgr: PtyManager | undefined
afterEach(() => { mgr?.killAll(); mgr = undefined })

describe('PtyManager', () => {
  it('buffers output for replay and reports active sessions', async () => {
    mgr = new PtyManager()
    const p = homedir()
    let got = ''
    mgr.start(p, d => { got += d })
    expect(mgr.has(p)).toBe(true)
    expect(mgr.list()).toContain(p)

    mgr.write(p, 'echo wtm_marker_123\n')
    // wait until the marker echoes back
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (got.includes('wtm_marker_123')) { clearInterval(iv); resolve() }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); reject(new Error('timeout')) }
      }, 50)
    })
    // the buffer used for replay must contain what was streamed
    expect(mgr.getBuffer(p)).toContain('wtm_marker_123')
  })

  it('assigns an opaque id per session and maps it back to the worktree', async () => {
    mgr = new PtyManager()
    const p = homedir()
    mgr.start(p, () => {})

    const id = mgr.id(p)!
    expect(id).toMatch(/^[0-9a-f-]{36}$/)
    expect(mgr.pathForId(id)).toBe(p)
    expect(mgr.pathForId('not-a-real-id')).toBeUndefined()
    expect(mgr.id('/no/such/worktree')).toBeUndefined()
    expect(mgr.pid(p)).toBeGreaterThan(0)
  })

  it('injects extra env into the pty', async () => {
    mgr = new PtyManager()
    const p = homedir()
    let got = ''
    mgr.start(p, d => { got += d }, { WTM_TEST_MARKER: 'wtm_env_ok' })

    mgr.write(p, 'echo "[$WTM_TEST_MARKER]"\n')
    await new Promise<void>((resolve, reject) => {
      const t0 = Date.now()
      const iv = setInterval(() => {
        if (got.includes('[wtm_env_ok]')) { clearInterval(iv); resolve() }
        else if (Date.now() - t0 > 4000) { clearInterval(iv); reject(new Error('timeout')) }
      }, 50)
    })
    expect(got).toContain('[wtm_env_ok]')
  })
})
