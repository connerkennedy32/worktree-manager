import { app, BrowserWindow, nativeImage } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { attachShortcuts } from './shortcuts'

const icon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
// Set the dock icon explicitly since dev/preview runs are unpackaged and would
// otherwise show Electron's default icon instead of the app's.
if (process.platform === 'darwin' && !icon.isEmpty()) app.dock.setIcon(icon)

async function createWindow() {
  const win = new BrowserWindow({
    width: 1300, height: 850,
    icon,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  await registerIpc(win)
  buildAppMenu(win)
  attachShortcuts(win)
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
