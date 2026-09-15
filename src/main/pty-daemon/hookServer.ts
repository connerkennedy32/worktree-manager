// HTTP endpoint the notify-hook script posts to.
//
// A second socket, separate from the daemon's own: that one speaks
// length-prefixed JSON frames, and curl speaks HTTP. A unix socket rather than a
// localhost port keeps this off the network entirely and needs no port
// allocation — filesystem permissions are the access control.

import * as http from 'http'
import { unlinkSync } from 'fs'

// The hook posts Claude Code's own payload now, which carries tool input and
// prompt text. The script caps what it sends well below this; the ceiling is
// here so a rogue poster still can't grow the daemon's memory.
const MAX_BODY = 256 * 1024

// The body is an envelope: {cwd, event, payload?}. cwd and event sit at the top
// level so a daemon older than the script still understands it, and the agent's
// own hook payload — when small enough to forward — rides underneath.
//
// Claude Code's payload spelling (hook_event_name) is accepted too, for a
// script older than this daemon. Between them, either half can be stale.
export function readHook(
  body: unknown
): { cwd: string; event: string; payload?: unknown } | undefined {
  const b = body as Record<string, unknown> | null
  if (!b || typeof b !== 'object') return undefined
  const cwd = b.cwd
  const event = typeof b.event === 'string' ? b.event : b.hook_event_name
  if (typeof cwd !== 'string' || !cwd) return undefined
  if (typeof event !== 'string' || !event) return undefined
  // An older script posted the payload itself, with no envelope around it.
  const payload = 'payload' in b ? b.payload : ('hook_event_name' in b ? b : undefined)
  return { cwd, event, payload }
}

export function startHookServer(
  socketPath: string,
  onHook: (cwd: string, event: string, payload: unknown) => void
): http.Server {
  // A crashed daemon leaves the socket file behind and bind would fail with
  // EADDRINUSE, so clear it first.
  try { unlinkSync(socketPath) } catch { /* nothing to remove */ }

  const server = http.createServer((req, res) => {
    let body = ''
    let tooBig = false
    req.on('data', chunk => {
      body += chunk
      // The hook posts a few dozen bytes. Anything larger is not ours.
      if (body.length > MAX_BODY) { tooBig = true; req.destroy() }
    })
    req.on('end', () => {
      res.writeHead(200, { 'Content-Type': 'text/plain' })
      res.end('ok')
      if (tooBig) return
      try {
        const parsed = readHook(JSON.parse(body))
        if (parsed) onHook(parsed.cwd, parsed.event, parsed.payload)
      } catch {
        // Malformed input must never take the daemon down.
      }
    })
  })

  server.on('error', e => process.stderr.write(`[pty-daemon] hook server: ${e}\n`))
  server.listen(socketPath)
  server.setTimeout(10000)
  return server
}
