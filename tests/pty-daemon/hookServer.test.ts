import { describe, it, expect, afterEach } from 'vitest'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Server } from 'http'
import { startHookServer } from '../../src/main/pty-daemon/hookServer'

const execFileAsync = promisify(execFile)

let server: Server | undefined
afterEach(() => { server?.close(); server = undefined })

function serve(onHook: (id: string, event: string) => void) {
  const sock = join(mkdtempSync(join(tmpdir(), 'wtm-hook-')), 'agent-hook.sock')
  return new Promise<string>(resolve => {
    server = startHookServer(sock, onHook)
    server.on('listening', () => resolve(sock))
  })
}

// Must run async: execFileSync blocks this process's event loop while curl
// runs, but the server under test lives in this same process/event loop, so a
// sync call would deadlock the server against its own request.
const post = (sock: string, body: string) =>
  execFileAsync('curl', [
    '-sS', '--unix-socket', sock, '-X', 'POST',
    '-H', 'Content-Type: application/json', '-d', body,
    '--max-time', '2', 'http://localhost/hook'
  ]).then(r => r.stdout)

describe('startHookServer', () => {
  it('receives a hook posted over the unix socket', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    await post(sock, JSON.stringify({ id: 'id-a', event: 'Stop' }))
    expect(got).toEqual([['id-a', 'Stop']])
  })

  it('ignores a malformed body without crashing', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    await expect(post(sock, 'not json at all')).resolves.toBeDefined()
    expect(got).toEqual([])
  })

  it('ignores a body missing its fields', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    await post(sock, JSON.stringify({ id: 'id-a' }))
    await post(sock, JSON.stringify({ event: 'Stop' }))
    await post(sock, JSON.stringify({ id: 5, event: [] }))
    expect(got).toEqual([])
  })

  it('rebinds over a stale socket file left by a crash', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    server!.close()
    // The socket file still exists on disk; a fresh bind must reclaim it.
    server = startHookServer(sock, (id, event) => got.push([id, event]))
    await new Promise(r => server!.on('listening', r))
    await post(sock, JSON.stringify({ id: 'id-a', event: 'Stop' }))
    expect(got).toEqual([['id-a', 'Stop']])
  })
})
