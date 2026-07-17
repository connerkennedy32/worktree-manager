import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC } from '@shared/ipc-types'
import * as wt from './git/worktrees'
import { validateRepoSelection } from './git/repo'
import { getStatus } from './git/status'
import { getCommittedFiles } from './git/committed'
import { getPushState, push } from './git/push'
import * as diff from './git/diff'
import * as config from './config'
import { PtyDaemonClient } from './pty-daemon/client'
import { WatcherManager } from './watcher'

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

export async function registerIpc(w: BrowserWindow) {
  win = w
  // Sessions live in the pty-daemon process, not this window — closing (or
  // quitting) the app must not kill them. Only the file watchers, which are
  // cheap to recreate, are tied to the window's lifecycle.
  win.on('closed', () => { watchers.unwatchAll() })
  if (registered) return
  registered = true

  ptys = await PtyDaemonClient.connect((p, d) => send(IPC.termData, p, d))
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
  ipcMain.handle(IPC.listWorktrees, (_e, r: string) => wt.listWorktrees(r))
  ipcMain.handle(IPC.createWorktree, (_e, req) => wt.createWorktree(req))
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
  ipcMain.handle(IPC.getFileDiff, (_e, req) => diff.getFileDiff(req))
  ipcMain.handle(IPC.stage, (_e, req) => diff.stage(req))
  ipcMain.handle(IPC.stagePath, (_e, req) => diff.stagePath(req))
  ipcMain.handle(IPC.stageAll, (_e, p: string) => diff.stageAll(p))
  ipcMain.handle(IPC.discardPath, (_e, req) => diff.discardPath(req))
  ipcMain.handle(IPC.commit, (_e, req) => diff.commit(req))

  ipcMain.on(IPC.openLazygit, (_e, p: string) => {
    ptys.start(p)
    ptys.write(p, 'lazygit\n')
  })

  ipcMain.handle(IPC.listTerminals, () => ptys.list())

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
}
