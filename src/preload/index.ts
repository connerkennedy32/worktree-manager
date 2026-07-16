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
  getFileDiff: (req) => ipcRenderer.invoke(IPC.getFileDiff, req),
  stage: (req) => ipcRenderer.invoke(IPC.stage, req),
  stagePath: (req) => ipcRenderer.invoke(IPC.stagePath, req),
  commit: (req) => ipcRenderer.invoke(IPC.commit, req),
  openLazygit: (p) => ipcRenderer.send(IPC.openLazygit, p),
  termStart: (p) => ipcRenderer.send(IPC.termStart, p),
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
  }
}
contextBridge.exposeInMainWorld('api', api)
