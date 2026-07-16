import { app, BrowserWindow } from 'electron'
import { join } from 'path'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'

function createWindow() {
  const win = new BrowserWindow({
    width: 1300, height: 850,
    webPreferences: { preload: join(__dirname, '../preload/index.js'), sandbox: false }
  })
  registerIpc(win)
  buildAppMenu(win)
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
