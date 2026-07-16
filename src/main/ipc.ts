import { ipcMain, BrowserWindow, dialog } from 'electron'
import { IPC } from '@shared/ipc-types'
import * as wt from './git/worktrees'
import { getStatus } from './git/status'
import * as diff from './git/diff'
import * as config from './config'
import { PtyManager } from './terminal/ptyManager'
import { WatcherManager } from './watcher'

export function registerIpc(win: BrowserWindow) {
  const ptys = new PtyManager()
  const watchers = new WatcherManager()

  ipcMain.handle(IPC.listRepos, () => config.listRepos())
  ipcMain.handle(IPC.addRepo, (_e, p: string) => config.addRepo(p))
  ipcMain.handle(IPC.removeRepo, (_e, p: string) => config.removeRepo(p))
  ipcMain.handle(IPC.pickRepo, async () => {
    const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
    if (r.canceled || !r.filePaths[0]) return config.listRepos()
    return config.addRepo(r.filePaths[0])
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
  ipcMain.handle(IPC.getFileDiff, (_e, req) => diff.getFileDiff(req))
  ipcMain.handle(IPC.stage, (_e, req) => diff.stage(req))
  ipcMain.handle(IPC.stagePath, (_e, req) => diff.stagePath(req))
  ipcMain.handle(IPC.commit, (_e, req) => diff.commit(req))

  ipcMain.on(IPC.openLazygit, (_e, p: string) => {
    ptys.start(p, d => win.webContents.send(IPC.termData, p, d))
    ptys.write(p, 'lazygit\n')
  })

  ipcMain.on(IPC.termStart, (_e, p: string) => {
    ptys.start(p, d => win.webContents.send(IPC.termData, p, d))
    watchers.watch(p, () => win.webContents.send(IPC.statusChanged, p))
  })
  ipcMain.on(IPC.termInput, (_e, p: string, data: string) => ptys.write(p, data))
  ipcMain.on(IPC.termResize, (_e, p: string, c: number, r: number) => ptys.resize(p, c, r))

  win.on('closed', () => { ptys.killAll(); watchers.unwatchAll() })
}
