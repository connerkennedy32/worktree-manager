import { describe, it, expect, afterEach } from 'vitest'
import { homedir } from 'os'
import { PtyManager } from '../../src/main/terminal/ptyManager'

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
})
