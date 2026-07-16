import * as pty from 'node-pty'
import { platform } from 'os'

type Session = { proc: pty.IPty }

export class PtyManager {
  private sessions = new Map<string, Session>()

  start(worktreePath: string, onData: (data: string) => void) {
    if (this.sessions.has(worktreePath)) return
    const shell = process.env.SHELL || (platform() === 'win32' ? 'powershell.exe' : 'bash')
    const proc = pty.spawn(shell, [], {
      name: 'xterm-color', cols: 100, rows: 30, cwd: worktreePath, env: process.env as any
    })
    proc.onData(onData)
    proc.onExit(() => this.sessions.delete(worktreePath))
    this.sessions.set(worktreePath, { proc })
  }
  write(worktreePath: string, data: string) { this.sessions.get(worktreePath)?.proc.write(data) }
  resize(worktreePath: string, cols: number, rows: number) {
    try { this.sessions.get(worktreePath)?.proc.resize(cols, rows) } catch { /* ignore */ }
  }
  kill(worktreePath: string) { this.sessions.get(worktreePath)?.proc.kill(); this.sessions.delete(worktreePath) }
  killAll() { for (const [, s] of this.sessions) s.proc.kill(); this.sessions.clear() }
}
