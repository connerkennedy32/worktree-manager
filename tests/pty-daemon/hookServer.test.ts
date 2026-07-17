import { describe, it, expect, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import type { Server } from 'http'
import { startHookServer } from '../../src/main/pty-daemon/hookServer'

let server: Server | undefined
afterEach(() => { server?.close(); server = undefined })

function serve(onHook: (id: string, event: string) => void) {
  const sock = join(mkdtempSync(join(tmpdir(), 'wtm-hook-')), 'agent-hook.sock')
  return new Promise<string>(resolve => {
    server = startHookServer(sock, onHook)
    server.on('listening', () => resolve(sock))
  })
}

const post = (sock: string, body: string) =>
  execFileSync('curl', [
    '-sS', '--unix-socket', sock, '-X', 'POST',
    '-H', 'Content-Type: application/json', '-d', body,
    '--max-time', '2', 'http://localhost/hook'
  ]).toString()

describe('startHookServer', () => {
  it('receives a hook posted over the unix socket', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    post(sock, JSON.stringify({ id: 'id-a', event: 'Stop' }))
    expect(got).toEqual([['id-a', 'Stop']])
  })

  it('ignores a malformed body without crashing', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    expect(() => post(sock, 'not json at all')).not.toThrow()
    expect(got).toEqual([])
  })

  it('ignores a body missing its fields', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    post(sock, JSON.stringify({ id: 'id-a' }))
    post(sock, JSON.stringify({ event: 'Stop' }))
    post(sock, JSON.stringify({ id: 5, event: [] }))
    expect(got).toEqual([])
  })

  it('rebinds over a stale socket file left by a crash', async () => {
    const got: [string, string][] = []
    const sock = await serve((id, event) => got.push([id, event]))
    server!.close()
    // The socket file still exists on disk; a fresh bind must reclaim it.
    server = startHookServer(sock, (id, event) => got.push([id, event]))
    await new Promise(r => server!.on('listening', r))
    post(sock, JSON.stringify({ id: 'id-a', event: 'Stop' }))
    expect(got).toEqual([['id-a', 'Stop']])
  })
})
