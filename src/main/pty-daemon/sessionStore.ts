import * as pty from 'node-pty'
import { platform } from 'os'
import { randomUUID } from 'crypto'

type Session = { proc: pty.IPty; buffer: string; id: string }

// Cap on how much scrollback we retain per terminal for replay after a reload.
const MAX_BUFFER = 200_000

export class PtyManager {
  private sessions = new Map<string, Session>()

  start(worktreePath: string, onData: (data: string) => void, extraEnv: Record<string, string> = {}) {
    if (this.sessions.has(worktreePath)) return
    const shell = process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : 'bash')
    const args = platform() === 'win32' ? [] : ['-l']
    const id = randomUUID()
    const proc = pty.spawn(shell, args, {
      name: 'xterm-color', cols: 100, rows: 30, cwd: worktreePath,
      env: { ...process.env, ...extraEnv } as any
    })
    const session: Session = { proc, buffer: '', id }
    proc.onData(d => {
      session.buffer += d
      if (session.buffer.length > MAX_BUFFER) session.buffer = session.buffer.slice(-MAX_BUFFER)
      onData(d)
    })
    proc.onExit(() => this.sessions.delete(worktreePath))
    this.sessions.set(worktreePath, session)
  }

  has(worktreePath: string) { return this.sessions.has(worktreePath) }
  getBuffer(worktreePath: string) { return this.sessions.get(worktreePath)?.buffer ?? '' }
  list() { return [...this.sessions.keys()] }

  id(worktreePath: string) { return this.sessions.get(worktreePath)?.id }
  pid(worktreePath: string) { return this.sessions.get(worktreePath)?.proc.pid }
  pathForId(id: string) {
    for (const [path, s] of this.sessions) if (s.id === id) return path
    return undefined
  }

  write(worktreePath: string, data: string) { this.sessions.get(worktreePath)?.proc.write(data) }
  resize(worktreePath: string, cols: number, rows: number) {
    try { this.sessions.get(worktreePath)?.proc.resize(cols, rows) } catch { /* ignore */ }
  }
  kill(worktreePath: string) { this.sessions.get(worktreePath)?.proc.kill(); this.sessions.delete(worktreePath) }
  killAll() { for (const [, s] of this.sessions) s.proc.kill(); this.sessions.clear() }
}
