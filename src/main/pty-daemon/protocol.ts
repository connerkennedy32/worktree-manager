// Wire protocol for the pty-daemon Unix socket. Pure logic, no electron or
// node-pty imports — this file must be requireable from the daemon's plain
// Node process as well as the Electron main process.

import type { AgentReport } from '@shared/agent-status'

export const PROTOCOL_VERSION = 1

export type ClientMessage =
  | { type: 'hello'; clientVersion: number }
  | { type: 'start'; path: string }
  | { type: 'input'; path: string; data: string }
  | { type: 'resize'; path: string; cols: number; rows: number }
  | { type: 'reset'; path: string }
  | { type: 'kill'; path: string }
  | { type: 'killAll' }
  | { type: 'list'; reqId: number }
  | { type: 'replayRequest'; reqId: number; path: string }

export type ServerMessage =
  | { type: 'welcome'; version: number }
  | { type: 'data'; path: string; chunk: string }
  | { type: 'list'; reqId: number; paths: string[] }
  | { type: 'replayResponse'; reqId: number; path: string; buffer: string }
  | { type: 'agentStatus'; path: string; report: AgentReport }

const LENGTH_PREFIX_BYTES = 4

export function encodeFrame(message: unknown): Buffer {
  const payload = Buffer.from(JSON.stringify(message), 'utf8')
  const header = Buffer.alloc(LENGTH_PREFIX_BYTES)
  header.writeUInt32BE(payload.length, 0)
  return Buffer.concat([header, payload])
}

/**
 * Accumulates bytes from a socket's 'data' event and yields complete
 * length-prefixed frames as they become available, carrying any partial
 * frame forward across calls.
 */
export class FrameDecoder {
  private buffer: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): unknown[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk])
    const messages: unknown[] = []
    while (this.buffer.length >= LENGTH_PREFIX_BYTES) {
      const length = this.buffer.readUInt32BE(0)
      const frameEnd = LENGTH_PREFIX_BYTES + length
      if (this.buffer.length < frameEnd) break
      const payload = this.buffer.subarray(LENGTH_PREFIX_BYTES, frameEnd)
      messages.push(JSON.parse(payload.toString('utf8')))
      this.buffer = this.buffer.subarray(frameEnd)
    }
    return messages
  }
}
