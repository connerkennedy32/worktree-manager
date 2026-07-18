// Standalone entry point for the pty-daemon: a long-lived, detached process
// that owns all node-pty sessions behind a Unix domain socket, so terminal
// sessions survive the Electron app quitting. Run under Node (ELECTRON_RUN_AS_NODE=1
// when spawned via the Electron binary) — must not import electron.

import * as fs from 'fs'
import * as net from 'net'
import * as path from 'path'
import { PtyManager } from './sessionStore'
import { PROTOCOL_VERSION, encodeFrame, FrameDecoder, type ClientMessage, type ServerMessage } from './protocol'
import { AgentTracker } from './agentTracker'
import { startHookServer } from './hookServer'
import { ensureTmuxUpdateEnvironment } from './tmuxEnv'

function configDir(): string {
  const dir = process.env.WTM_DAEMON_CONFIG_DIR || process.env.WTM_CONFIG_DIR
  if (!dir) throw new Error('WTM_DAEMON_CONFIG_DIR (or WTM_CONFIG_DIR) must be set')
  return dir
}

const socketPath = path.join(configDir(), 'pty-daemon.sock')
const manifestPath = path.join(configDir(), 'pty-daemon.json')
const hookSocketPath = path.join(configDir(), 'agent-hook.sock')

const sessions = new PtyManager()
const clients = new Set<net.Socket>()

function broadcast(message: ServerMessage) {
  const frame = encodeFrame(message)
  for (const sock of clients) sock.write(frame)
}

// Hooks report what the agent is doing; the tracker's sweep only clears status
// when an agent dies without firing SessionEnd.
const agents = new AgentTracker(sessions, (p, report) => broadcast({ type: 'agentStatus', path: p, report }))
agents.start()
startHookServer(hookSocketPath, (id, event) => agents.handleHook(id, event))

// The notify-hook script reads WTM_HOOK_SOCKET (here) and WTM_TERMINAL_ID (set
// by PtyManager) out of its inherited environment to report which terminal it
// belongs to.
function startSession(worktreePath: string) {
  sessions.start(worktreePath, chunk => broadcast({ type: 'data', path: worktreePath, chunk }), {
    WTM_HOOK_SOCKET: hookSocketPath
  })
  // Best-effort: if the user already runs a tmux server, let sessions/panes
  // created inside this pty pick up these two vars too. No-op if tmux isn't
  // installed or no server is running yet.
  void ensureTmuxUpdateEnvironment()
}

function handleMessage(sock: net.Socket, message: ClientMessage) {
  switch (message.type) {
    case 'hello':
      sock.write(encodeFrame({ type: 'welcome', version: PROTOCOL_VERSION } satisfies ServerMessage))
      for (const [p, report] of Object.entries(agents.snapshot())) {
        sock.write(encodeFrame({ type: 'agentStatus', path: p, report } satisfies ServerMessage))
      }
      return
    case 'start':
      if (!sessions.has(message.path)) startSession(message.path)
      return
    case 'input':
      sessions.write(message.path, message.data)
      return
    case 'resize':
      sessions.resize(message.path, message.cols, message.rows)
      return
    case 'reset':
      sessions.kill(message.path)
      startSession(message.path)
      return
    case 'kill':
      sessions.kill(message.path)
      return
    case 'killAll':
      sessions.killAll()
      return
    case 'list':
      sock.write(encodeFrame({ type: 'list', reqId: message.reqId, paths: sessions.list() } satisfies ServerMessage))
      return
    case 'replayRequest':
      sock.write(encodeFrame({
        type: 'replayResponse', reqId: message.reqId, path: message.path, buffer: sessions.getBuffer(message.path)
      } satisfies ServerMessage))
      return
  }
}

fs.mkdirSync(configDir(), { recursive: true })
try { fs.unlinkSync(socketPath) } catch { /* no stale socket to remove */ }

const server = net.createServer(sock => {
  clients.add(sock)
  const decoder = new FrameDecoder()
  sock.on('data', chunk => {
    for (const message of decoder.push(chunk)) handleMessage(sock, message as ClientMessage)
  })
  sock.on('close', () => clients.delete(sock))
  sock.on('error', () => clients.delete(sock))
})

server.listen(socketPath, () => {
  fs.writeFileSync(manifestPath, JSON.stringify({
    pid: process.pid, socketPath, version: PROTOCOL_VERSION
  }))
  process.stderr.write(`[pty-daemon] listening on ${socketPath} (pid=${process.pid})\n`)
})
