// HTTP endpoint the notify-hook script posts to.
//
// A second socket, separate from the daemon's own: that one speaks
// length-prefixed JSON frames, and curl speaks HTTP. A unix socket rather than a
// localhost port keeps this off the network entirely and needs no port
// allocation — filesystem permissions are the access control.

import * as http from 'http'
import { unlinkSync } from 'fs'

const MAX_BODY = 64 * 1024

export function startHookServer(
  socketPath: string,
  onHook: (id: string, event: string) => void
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
        const { id, event } = JSON.parse(body)
        if (typeof id === 'string' && typeof event === 'string') onHook(id, event)
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
