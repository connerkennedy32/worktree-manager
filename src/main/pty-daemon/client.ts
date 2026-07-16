// Main-process client for the pty-daemon. Drop-in replacement for the old
// in-process PtyManager: same method surface (start/has/getBuffer/list/write/
// resize/kill/killAll), but backed by a socket connection to a detached
// daemon process so sessions survive the Electron app quitting.

import { spawn } from 'child_process'
import { mkdirSync, readFileSync, unlinkSync } from 'fs'
import * as net from 'net'
import { join } from 'path'
import { configDir } from '../config'
import { PROTOCOL_VERSION, encodeFrame, FrameDecoder, type ClientMessage, type ServerMessage } from './protocol'

const MAX_BUFFER = 200_000

interface Manifest { pid: number; socketPath: string; version: number }

function manifestPath(): string { return join(configDir(), 'pty-daemon.json') }
function socketPath(): string { return join(configDir(), 'pty-daemon.sock') }

function readManifest(): Manifest | undefined {
  try { return JSON.parse(readFileSync(manifestPath(), 'utf8')) } catch { return undefined }
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function tryConnect(path: string, timeoutMs: number): Promise<net.Socket | undefined> {
  return new Promise(resolve => {
    const sock = net.createConnection({ path })
    const timer = setTimeout(() => { sock.destroy(); resolve(undefined) }, timeoutMs)
    sock.once('connect', () => { clearTimeout(timer); resolve(sock) })
    sock.once('error', () => { clearTimeout(timer); resolve(undefined) })
  })
}

async function waitForSocket(path: string, totalTimeoutMs: number): Promise<net.Socket | undefined> {
  const deadline = Date.now() + totalTimeoutMs
  while (Date.now() < deadline) {
    const sock = await tryConnect(path, 200)
    if (sock) return sock
    await new Promise(r => setTimeout(r, 100))
  }
  return undefined
}

function daemonScriptPath(): string {
  return join(__dirname, 'pty-daemon.js')
}

export class PtyDaemonClient {
  private socket: net.Socket
  private decoder = new FrameDecoder()
  private onData: (path: string, data: string) => void
  private knownPaths = new Set<string>()
  private buffers = new Map<string, string>()
  private nextReqId = 1
  private pendingList: ((paths: string[]) => void)[] = []
  private pendingReplay = new Map<number, (buffer: string) => void>()

  private constructor(socket: net.Socket, onData: (path: string, data: string) => void) {
    this.socket = socket
    this.onData = onData
    this.socket.on('data', chunk => {
      for (const message of this.decoder.push(chunk)) this.handleMessage(message as ServerMessage)
    })
  }

  private handleMessage(message: ServerMessage) {
    switch (message.type) {
      case 'welcome':
        return
      case 'data': {
        const existing = this.buffers.get(message.path) ?? ''
        const combined = (existing + message.chunk).slice(-MAX_BUFFER)
        this.buffers.set(message.path, combined)
        this.onData(message.path, message.chunk)
        return
      }
      case 'list': {
        this.knownPaths = new Set(message.paths)
        const resolvers = this.pendingList
        this.pendingList = []
        for (const resolve of resolvers) resolve(message.paths)
        return
      }
      case 'replayResponse': {
        const resolve = this.pendingReplay.get(message.reqId)
        if (resolve) { this.pendingReplay.delete(message.reqId); resolve(message.buffer) }
        return
      }
    }
  }

  private send(message: ClientMessage) {
    this.socket.write(encodeFrame(message))
  }

  private requestList(): Promise<string[]> {
    return new Promise(resolve => {
      this.pendingList.push(resolve)
      this.send({ type: 'list', reqId: this.nextReqId++ })
    })
  }

  private requestReplay(path: string): Promise<string> {
    return new Promise(resolve => {
      const reqId = this.nextReqId++
      this.pendingReplay.set(reqId, resolve)
      this.send({ type: 'replayRequest', reqId, path })
    })
  }

  static async connect(onData: (path: string, data: string) => void): Promise<PtyDaemonClient> {
    mkdirSync(configDir(), { recursive: true })
    const manifest = readManifest()

    let socket: net.Socket | undefined
    if (manifest && isProcessAlive(manifest.pid)) {
      socket = await tryConnect(manifest.socketPath, 500)
    }

    if (!socket) {
      try { unlinkSync(manifestPath()) } catch { /* nothing to remove */ }
      try { unlinkSync(socketPath()) } catch { /* nothing to remove */ }

      spawn(process.execPath, [daemonScriptPath()], {
        detached: true,
        stdio: 'ignore',
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', WTM_DAEMON_CONFIG_DIR: configDir() }
      }).unref()

      socket = await waitForSocket(socketPath(), 5_000)
      if (!socket) throw new Error('pty-daemon did not become ready within 5s')
    }

    const client = new PtyDaemonClient(socket, onData)
    client.send({ type: 'hello', clientVersion: PROTOCOL_VERSION })

    const knownPaths = await client.requestList()
    await Promise.all(knownPaths.map(async p => {
      const buffer = await client.requestReplay(p)
      client.buffers.set(p, buffer)
    }))

    return client
  }

  start(path: string) {
    if (this.knownPaths.has(path)) return
    this.knownPaths.add(path)
    this.send({ type: 'start', path })
  }

  has(path: string): boolean { return this.knownPaths.has(path) }
  getBuffer(path: string): string { return this.buffers.get(path) ?? '' }
  list(): string[] { return [...this.knownPaths] }

  write(path: string, data: string) { this.send({ type: 'input', path, data }) }
  resize(path: string, cols: number, rows: number) { this.send({ type: 'resize', path, cols, rows }) }

  kill(path: string) {
    this.send({ type: 'kill', path })
    this.knownPaths.delete(path)
    this.buffers.delete(path)
  }

  killAll() {
    this.send({ type: 'killAll' })
    this.knownPaths.clear()
    this.buffers.clear()
  }
}
