import { ipcMain, BrowserWindow, dialog, app, shell } from 'electron'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import type { AgentReport } from '@shared/agent-status'
import { IPC, type GtCreateRequest, type RepoCommandEntry, type RunRepoCommandRequest } from '@shared/ipc-types'
import * as wt from './git/worktrees'
import { validateRepoSelection } from './git/repo'
import { getStatus } from './git/status'
import { getCommittedFiles } from './git/committed'
import { getPushState, push } from './git/push'
import { syncWithTrunk } from './git/sync'
import { gtCreate } from './stack'
import { runRepoCommand } from './repo-commands'
import * as diff from './git/diff'
import * as files from './files'
import * as config from './config'
import { PtyDaemonClient } from './pty-daemon/client'
import { WatcherManager } from './watcher'
import { previewUrl } from './preview'
import { setAgentStatus, seedAgentStatuses, flashDone } from './dock'

// ipcMain.handle/on registrations are process-global and can only happen once,
// but createWindow() (and thus registerIpc) runs again whenever the app is
// reactivated after all windows were closed (e.g. macOS dock relaunch). So we
// register handlers only on the first call and just repoint the module-level
// `win`/`ptys`/`watchers` bindings on subsequent calls — the closures below
// read these as outer variables, so reassigning them updates all handlers.
let win: BrowserWindow
let ptys: PtyDaemonClient
let watchers: WatcherManager
let registered = false

// node-pty and chokidar callbacks are async and can still fire after the
// window that owns them has been closed (e.g. buffered pty output draining
// after proc.kill()), so every send to the renderer must check the window
// is still alive.
function send(channel: string, ...args: unknown[]) {
  if (!win.isDestroyed()) win.webContents.send(channel, ...args)
}

// Signal a finished turn on the Dock icon. Only 'done' signals
// ('working'/'permission'/'failed' are handled by the in-app row indicators and
// the Dock badge), and how it signals depends on where the user is looking:
// backgrounded gets a bounce, so a task that completed while the user was in
// another app is noticed ('informational' bounces once rather than until focus,
// matching a "task done" nudge rather than an alarm); focused gets a brief badge
// flash instead, since a bounce on the frontmost app is invisible but the
// finishing row may still be off-screen or scrolled away.
function signalDone(r: AgentReport) {
  if (process.platform !== 'darwin') return
  if (r.status !== 'done') return
  if (win && !win.isDestroyed() && win.isFocused()) flashDone()
  else app.dock?.bounce('informational')
}

export async function registerIpc(w: BrowserWindow) {
  win = w
  // Sessions live in the pty-daemon process, not this window — closing (or
  // quitting) the app must not kill them. Only the file watchers, which are
  // cheap to recreate, are tied to the window's lifecycle.
  win.on('closed', () => { watchers.unwatchAll() })
  if (registered) return
  registered = true

  ptys = await PtyDaemonClient.connect(
    (p, d) => send(IPC.termData, p, d),
    (p, r) => { send(IPC.agentStatus, p, r); signalDone(r); setAgentStatus(p, r) }
  )
  // Sessions outlive the app, so agents can already be mid-turn on connect.
  seedAgentStatuses(ptys.agentStatuses())
  watchers = new WatcherManager()

  ipcMain.handle(IPC.listRepos, () => config.listRepos())
  ipcMain.handle(IPC.addRepo, (_e, p: string) => config.addRepo(p))
  ipcMain.handle(IPC.removeRepo, (_e, p: string) => config.removeRepo(p))
  ipcMain.handle(IPC.pickRepo, async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return config.listRepos()
    const root = await validateRepoSelection(r.filePaths[0]) // throws with a clear message if invalid
    return config.addRepo(root)
  })
  ipcMain.handle(IPC.listNames, () => config.listNames())
  ipcMain.handle(IPC.setName, (_e, p: string, name: string) => config.setName(p, name))
  ipcMain.handle(IPC.getSelectedBackground, () => config.getSelectedBackground())
  ipcMain.handle(IPC.listWorktrees, (_e, r: string) => wt.listWorktrees(r))
  ipcMain.handle(IPC.removeWorktree, async (_e, p: string, f: boolean) => {
    const result = await wt.removeWorktree(p, f)
    // The worktree dir is gone; free its terminal and stop watching it.
    ptys.kill(p)
    watchers.unwatch(p)
    return result
  })
  ipcMain.handle(IPC.getStatus, (_e, p: string) => getStatus(p))
  ipcMain.handle(IPC.getDiff, (_e, p: string) => diff.getDiff(p))
  ipcMain.handle(IPC.getCommittedFiles, (_e, p: string) => getCommittedFiles(p))
  ipcMain.handle(IPC.pendingCount, (_e, p: string) => getPushState(p).then(s => s.ahead))
  ipcMain.handle(IPC.push, (_e, p: string) => push(p))
  ipcMain.handle(IPC.syncWithTrunk, (_e, p: string) =>
    syncWithTrunk(p, chunk => send(IPC.gitOutput, p, chunk)))
  ipcMain.handle(IPC.gtCreate, (_e, req: GtCreateRequest) =>
    gtCreate(req, chunk => send(IPC.gitOutput, req.worktreePath, chunk)))
  ipcMain.handle(IPC.listRepoCommands, (_e, p: string) => config.listRepoCommands(p))
  ipcMain.handle(IPC.runRepoCommand, (_e, req: RunRepoCommandRequest) =>
    runRepoCommand(req, chunk => send(IPC.gitOutput, req.worktreePath, chunk)))
  ipcMain.handle(IPC.openRepoCommandsFile, () => config.openRepoCommandsFile())
  ipcMain.handle(IPC.readAllRepoCommands, () => config.readAllRepoCommands())
  ipcMain.handle(IPC.saveRepoCommands, async (_e, repoPath: string, entries: RepoCommandEntry[]) => {
    const stored = await config.saveRepoCommands(repoPath, entries)
    send(IPC.commandsChanged)
    return stored
  })
  ipcMain.handle(IPC.getFileDiff, (_e, req) => diff.getFileDiff(req))
  ipcMain.handle(IPC.readFile, (_e, req) => files.readFile(req))
  ipcMain.handle(IPC.writeFile, (_e, req) => files.writeFile(req))
  ipcMain.handle(IPC.stage, (_e, req) => diff.stage(req))
  ipcMain.handle(IPC.stagePath, (_e, req) => diff.stagePath(req))
  ipcMain.handle(IPC.stageAll, (_e, p: string) => diff.stageAll(p))
  ipcMain.handle(IPC.discardPath, (_e, req) => diff.discardPath(req))
  ipcMain.handle(IPC.commit, (_e, req) => diff.commit(req))

  ipcMain.on(IPC.openLazygit, (_e, p: string) => {
    ptys.start(p)
    ptys.write(p, 'lazygit\n')
  })

  ipcMain.on(IPC.openInEditor, (_e, p: string, file?: string) => {
    // Passing the worktree alongside the file keeps VS Code's window rooted at
    // the worktree instead of opening a stray single-file window.
    const targets = file ? [p, join(p, file)] : [p]
    // GUI-launched apps don't inherit a login shell's PATH, so the `code` CLI
    // usually isn't resolvable directly. On macOS `open -a` finds VS Code by app
    // name regardless of PATH; elsewhere fall back to `code` on PATH.
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Visual Studio Code', ...targets], { detached: true, stdio: 'ignore' }).unref()
    } else {
      spawn('code', targets, { detached: true, stdio: 'ignore' }).unref()
    }
  })

  // Preview a file in the OS default browser. openExternal with a file:// URL
  // (rather than openPath) makes the browser the target even when the OS has a
  // different default app registered for the extension, e.g. an editor for .html.
  ipcMain.on(IPC.openInBrowser, (_e, p: string, file: string) => {
    let abs: string
    try { abs = files.resolveInWorktree(p, file) } catch { return }
    shell.openExternal(pathToFileURL(abs).href)
  })

  ipcMain.handle(IPC.previewUrl, (_e, p: string, file: string) => previewUrl(p, file))

  ipcMain.handle(IPC.listTerminals, () => ptys.list())
  ipcMain.handle(IPC.getAgentStatuses, () => ptys.agentStatuses())

  ipcMain.on(IPC.termStart, async (_e, p: string) => {
    if (ptys.has(p)) {
      // Session survived a renderer reload — replay its scrollback so the fresh
      // xterm shows the existing terminal instead of a blank pane.
      send(IPC.termData, p, ptys.getBuffer(p))
    } else {
      ptys.start(p)
    }
    const head = await wt.headPath(p).catch(() => undefined)
    watchers.watch(p, () => send(IPC.statusChanged, p), head)
  })
  ipcMain.handle(IPC.termReset, (_e, p: string) => {
    // Kill the wedged shell and spawn a fresh one for the same worktree.
    ptys.kill(p)
    ptys.start(p)
  })

  ipcMain.on(IPC.termInput, (_e, p: string, data: string) => ptys.write(p, data))
  ipcMain.on(IPC.termResize, (_e, p: string, c: number, r: number) => ptys.resize(p, c, r))

  // Bring the app forward when a file drag enters the window. This lets a drop
  // land even when Worktree Manager isn't the frontmost app, so the user can
  // drag an image straight from Finder onto a terminal without clicking first.
  ipcMain.on(IPC.focusWindow, () => {
    if (!win || win.isDestroyed()) return
    if (process.platform === 'darwin') app.focus({ steal: true })
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  })
}
