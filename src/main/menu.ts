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
