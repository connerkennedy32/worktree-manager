import { Menu, BrowserWindow, type MenuItemConstructorOptions } from 'electron'
import { IPC } from '@shared/ipc-types'

// Build the application (menu bar) menu, including a Terminal menu with Reset.
export function buildAppMenu(win: BrowserWindow) {
  const isMac = process.platform === 'darwin'
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Worktree',
      submenu: [
        {
          label: 'New Worktree…',
          accelerator: 'CmdOrCtrl+N',
          click: () => win.webContents.send(IPC.menuNewWorktree)
        },
        {
          label: 'New Worktree… (Ctrl+W)',
          accelerator: 'Ctrl+W',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuNewWorktree)
        },
        { type: 'separator' },
        // registerAccelerator: false — these shortcuts are handled in
        // shortcuts.ts via before-input-event, because a registered accelerator
        // never fires while the terminal has focus (xterm eats Cmd+Arrow first).
        // The accelerator is still declared so the menu displays it, and clicking
        // the item still works.
        {
          label: 'Previous Worktree',
          accelerator: 'CmdOrCtrl+Up',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectPrev)
        },
        {
          label: 'Next Worktree',
          accelerator: 'CmdOrCtrl+Down',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectNext)
        },
        {
          label: 'Previous Worktree (Ctrl+K)',
          accelerator: 'Ctrl+K',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectPrev)
        },
        {
          label: 'Next Worktree (Ctrl+J)',
          accelerator: 'Ctrl+J',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectNext)
        }
      ]
    },
    {
      label: 'Terminal',
      submenu: [
        {
          label: 'Reset',
          accelerator: 'CmdOrCtrl+Shift+R',
          click: () => win.webContents.send(IPC.menuResetTerminal)
        }
      ]
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
