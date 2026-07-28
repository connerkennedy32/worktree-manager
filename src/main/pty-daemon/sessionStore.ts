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
    // The daemon runs under `ELECTRON_RUN_AS_NODE=1`; if it leaks into a shell,
    // launching Electron from that shell (e.g. `npm start`) boots the app as
    // plain Node and crashes. Strip it so shells get a clean environment.
    const { ELECTRON_RUN_AS_NODE, ...baseEnv } = process.env
    const proc = pty.spawn(shell, args, {
      name: 'xterm-256color', cols: 100, rows: 30, cwd: worktreePath,
      env: { ...baseEnv, COLORTERM: 'truecolor', ...extraEnv, WTM_TERMINAL_ID: id } as any
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

  // Resolve a hook's reported cwd to the worktree that owns it. The agent may
  // run in a subdirectory of the worktree, so match by longest path prefix
  // rather than exact equality. Identifying by cwd (from the hook payload)
  // instead of an inherited env var is what makes status survive tmux, which
  // does not propagate per-pane env into the agent's process.
  pathForCwd(cwd: string) {
    let best: string | undefined
    for (const path of this.sessions.keys()) {
      if (cwd === path || cwd.startsWith(`${path}/`)) {
        if (!best || path.length > best.length) best = path
      }
    }
    return best
  }

  write(worktreePath: string, data: string) { this.sessions.get(worktreePath)?.proc.write(data) }
  resize(worktreePath: string, cols: number, rows: number) {
    try { this.sessions.get(worktreePath)?.proc.resize(cols, rows) } catch { /* ignore */ }
  }
  kill(worktreePath: string) { this.sessions.get(worktreePath)?.proc.kill(); this.sessions.delete(worktreePath) }
  killAll() { for (const [, s] of this.sessions) s.proc.kill(); this.sessions.clear() }
}
