import { Menu, BrowserWindow, dialog, type MenuItemConstructorOptions } from 'electron'
import { IPC, BUILTIN_BACKGROUNDS } from '@shared/ipc-types'
import * as config from './config'
import { validateRepoSelection } from './git/repo'

const BG_EXTENSIONS = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif', 'mp4', 'webm', 'mov', 'm4v', 'ogv']

// Build the Background submenu: Add…, then a radio list of Default + every
// added file (the current one checked), then Remove for the current selection.
// Changing a background rebuilds the whole menu so the checkmark/list refresh.
function backgroundSubmenu(win: BrowserWindow, backgrounds: string[], selected: string): MenuItemConstructorOptions[] {
  const rebuild = () => buildAppMenu(win)
  const notify = () => win.webContents.send(IPC.backgroundChanged)

  const items: MenuItemConstructorOptions[] = [
    {
      label: 'Add Background…',
      click: async () => {
        const r = await dialog.showOpenDialog(win, {
          properties: ['openFile', 'multiSelections'],
          filters: [{ name: 'Images & Videos', extensions: BG_EXTENSIONS }]
        })
        if (r.canceled || r.filePaths.length === 0) return
        let lastAdded = ''
        for (const p of r.filePaths) lastAdded = await config.addBackground(p)
        // Adding a background also selects it, so it takes effect immediately.
        if (lastAdded) await config.setSelectedBackground(lastAdded)
        await rebuild()
        notify()
      }
    },
    { type: 'separator' },
    {
      label: 'None',
      type: 'radio',
      checked: selected === '',
      click: async () => { await config.setSelectedBackground(''); await rebuild(); notify() }
    },
    ...BUILTIN_BACKGROUNDS.map((b): MenuItemConstructorOptions => {
      const value = `builtin:${b.id}`
      return {
        label: b.label,
        type: 'radio',
        checked: selected === value,
        click: async () => { await config.setSelectedBackground(value); await rebuild(); notify() }
      }
    }),
    ...backgrounds.map((name): MenuItemConstructorOptions => ({
      label: name,
      type: 'radio',
      checked: selected === name,
      click: async () => { await config.setSelectedBackground(name); await rebuild(); notify() }
    }))
  ]

  // Remove only applies to user-added files, not the built-ins or None.
  const isUserFile = selected !== '' && !selected.startsWith('builtin:')
  if (isUserFile) {
    items.push(
      { type: 'separator' },
      {
        label: `Remove "${selected}"`,
        click: async () => { await config.removeBackground(selected); await rebuild(); notify() }
      }
    )
  }
  return items
}

// The Repos submenu: add one, and disconnect any that are connected. This is
// the only way in or out now that the sidebar is gone, so both live here rather
// than one being a renderer affordance. Disconnecting only forgets the repo —
// nothing on disk is touched — so it needs no confirmation beyond its label.
function reposSubmenu(win: BrowserWindow, repos: string[]): MenuItemConstructorOptions[] {
  const done = async () => { await buildAppMenu(win); win.webContents.send(IPC.reposChanged) }
  const items: MenuItemConstructorOptions[] = [
    {
      label: 'Add Repo…',
      accelerator: 'CmdOrCtrl+Shift+O',
      click: async () => {
        const r = await dialog.showOpenDialog(win, { properties: ['openDirectory'] })
        if (r.canceled || !r.filePaths[0]) return
        try {
          await config.addRepo(await validateRepoSelection(r.filePaths[0]))
          await done()
        } catch (e: any) {
          // The picker is the only surface here, so the error has to be shown
          // here too — there is no sidebar left to render it into.
          await dialog.showMessageBox(win, {
            type: 'warning', message: "Can't add that folder",
            detail: (e?.message ?? String(e)).trim()
          })
        }
      }
    }
  ]
  if (repos.length) {
    items.push({ type: 'separator' }, {
      label: 'Disconnect',
      submenu: repos.map((repo): MenuItemConstructorOptions => ({
        label: repo,
        click: async () => { await config.removeRepo(repo); await done() }
      }))
    })
  }
  return items
}

// Build the application (menu bar) menu, including a Terminal menu with Reset
// and a Background menu for choosing the app backdrop.
export async function buildAppMenu(win: BrowserWindow) {
  const isMac = process.platform === 'darwin'
  const backgrounds = await config.listBackgrounds()
  const repos = await config.listRepos()
  const selected = await config.getSelectedBackground()
  // Only the layout is read out of the tasks document here — the menu is the
  // one place the setting is visible, so it needs the checkmark's state.
  const { layout } = await config.readTasks()
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{ role: 'appMenu' as const }] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'Worktree',
      submenu: [
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
        },
        { type: 'separator' },
        {
          label: 'Previous Column',
          accelerator: 'CmdOrCtrl+Left',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectPrevLane)
        },
        {
          label: 'Next Column',
          accelerator: 'CmdOrCtrl+Right',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectNextLane)
        },
        {
          label: 'Previous Column (Ctrl+H)',
          accelerator: 'Ctrl+H',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectPrevLane)
        },
        {
          label: 'Next Column (Ctrl+L)',
          accelerator: 'Ctrl+L',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuSelectNextLane)
        },
        { type: 'separator' },
        {
          // Handled in shortcuts.ts like the items above, so the accelerator is
          // only declared for display. Ctrl+U on every platform (not CmdOrCtrl),
          // matching the Ctrl+J/Ctrl+K it sits beside.
          label: 'Mark Unread',
          accelerator: 'Ctrl+U',
          registerAccelerator: false,
          click: () => win.webContents.send(IPC.menuMarkUnread)
        }
      ]
    },
    {
      label: 'Layout',
      submenu: [
        // A checkbox rather than two radio items: there are exactly two layouts,
        // and "is it the list?" is the whole question. The renderer owns the
        // flip (the setting lives in tasks.json with the split height); main
        // rebuilds this menu when the answer changes, in ipc.ts.
        {
          label: 'Task List on the Left',
          type: 'checkbox',
          checked: layout === 'list',
          accelerator: 'CmdOrCtrl+Shift+L',
          click: () => win.webContents.send(IPC.menuToggleLayout)
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
    {
      label: 'Commands',
      submenu: [
        {
          label: 'Edit Repo Commands…',
          accelerator: 'CmdOrCtrl+Shift+K',
          click: () => win.webContents.send(IPC.menuEditCommands)
        },
        // The editor writes the same file, so the raw JSON stays available for
        // anything the form doesn't cover.
        {
          label: 'Open commands.json',
          click: () => { void config.openRepoCommandsFile() }
        }
      ]
    },
    { label: 'Repos', submenu: reposSubmenu(win, repos) },
    { label: 'Background', submenu: backgroundSubmenu(win, backgrounds, selected) },
    { role: 'viewMenu' },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
