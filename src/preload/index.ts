import { contextBridge, ipcRenderer } from 'electron'
import { IPC, type Api } from '@shared/ipc-types'

const api: Api = {
  listRepos: () => ipcRenderer.invoke(IPC.listRepos),
  addRepo: (p) => ipcRenderer.invoke(IPC.addRepo, p),
  removeRepo: (p) => ipcRenderer.invoke(IPC.removeRepo, p),
  pickRepo: () => ipcRenderer.invoke(IPC.pickRepo),
  listWorktrees: (r) => ipcRenderer.invoke(IPC.listWorktrees, r),
  createWorktree: (req) => ipcRenderer.invoke(IPC.createWorktree, req),
  removeWorktree: (p, f) => ipcRenderer.invoke(IPC.removeWorktree, p, f),
  getStatus: (p) => ipcRenderer.invoke(IPC.getStatus, p),
  getDiff: (p) => ipcRenderer.invoke(IPC.getDiff, p),
  getCommittedFiles: (p) => ipcRenderer.invoke(IPC.getCommittedFiles, p),
  getFileDiff: (req) => ipcRenderer.invoke(IPC.getFileDiff, req),
  readFile: (req) => ipcRenderer.invoke(IPC.readFile, req),
  writeFile: (req) => ipcRenderer.invoke(IPC.writeFile, req),
  stage: (req) => ipcRenderer.invoke(IPC.stage, req),
  stagePath: (req) => ipcRenderer.invoke(IPC.stagePath, req),
  stageAll: (p) => ipcRenderer.invoke(IPC.stageAll, p),
  discardPath: (req) => ipcRenderer.invoke(IPC.discardPath, req),
  commit: (req) => ipcRenderer.invoke(IPC.commit, req),
  getPendingCount: (p) => ipcRenderer.invoke(IPC.pendingCount, p),
  push: (p) => ipcRenderer.invoke(IPC.push, p),
  openLazygit: (p) => ipcRenderer.send(IPC.openLazygit, p),
  listTerminals: () => ipcRenderer.invoke(IPC.listTerminals),
  termStart: (p) => ipcRenderer.send(IPC.termStart, p),
  termReset: (p) => ipcRenderer.invoke(IPC.termReset, p),
  termInput: (p, d) => ipcRenderer.send(IPC.termInput, p, d),
  termResize: (p, c, r) => ipcRenderer.send(IPC.termResize, p, c, r),
  onTermData: (cb) => {
    const h = (_e: unknown, p: string, d: string) => cb(p, d)
    ipcRenderer.on(IPC.termData, h as any)
    return () => ipcRenderer.removeListener(IPC.termData, h as any)
  },
  onStatusChanged: (cb) => {
    const h = (_e: unknown, p: string) => cb(p)
    ipcRenderer.on(IPC.statusChanged, h as any)
    return () => ipcRenderer.removeListener(IPC.statusChanged, h as any)
  },
  onMenuResetTerminal: (cb) => {
    const h = () => cb()
    ipcRenderer.on(IPC.menuResetTerminal, h as any)
    return () => ipcRenderer.removeListener(IPC.menuResetTerminal, h as any)
  },
  onMenuNewWorktree: (cb) => {
    const h = () => cb()
    ipcRenderer.on(IPC.menuNewWorktree, h as any)
    return () => ipcRenderer.removeListener(IPC.menuNewWorktree, h as any)
  },
  onMenuSelectPrev: (cb) => {
    const h = () => cb()
    ipcRenderer.on(IPC.menuSelectPrev, h as any)
    return () => ipcRenderer.removeListener(IPC.menuSelectPrev, h as any)
  },
  onMenuSelectNext: (cb) => {
    const h = () => cb()
    ipcRenderer.on(IPC.menuSelectNext, h as any)
    return () => ipcRenderer.removeListener(IPC.menuSelectNext, h as any)
  }
}
contextBridge.exposeInMainWorld('api', api)
