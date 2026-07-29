import { app, BrowserWindow, nativeImage, protocol, net } from 'electron'
import { join, basename } from 'path'
import { pathToFileURL } from 'url'
import { registerIpc } from './ipc'
import { buildAppMenu } from './menu'
import { attachShortcuts } from './shortcuts'
import { installAgentHooks } from './agent-hooks/install'
import { backgroundsDir } from './config'
import { registerPreviewProtocol } from './preview'

// The renderer can't load arbitrary file:// paths under the default CSP, and
// data-URLing a multi-MB video is a non-starter. A custom scheme streams the
// file from disk with range-request support (needed for <video> seeking).
protocol.registerSchemesAsPrivileged([
  { scheme: 'wtm-bg', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: true } },
  // In-app HTML preview. A custom scheme (rather than a file:// iframe, which the
  // dev server's http:// origin cannot frame) serves the page from its worktree so
  // its relative stylesheets, scripts and images resolve the way a browser's would.
  { scheme: 'wtm-preview', privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true } }
])

function registerBackgroundProtocol() {
  protocol.handle('wtm-bg', (req) => {
    // URL shape: wtm-bg://bg/<filename>. basename() blocks path traversal.
    const name = basename(decodeURIComponent(new URL(req.url).pathname))
    return net.fetch(pathToFileURL(join(backgroundsDir(), name)).toString())
  })
}

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
  await buildAppMenu(win)
  attachShortcuts(win)
  if (process.env['ELECTRON_RENDERER_URL']) win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  else win.loadFile(join(__dirname, '../renderer/index.html'))
}

app.whenReady().then(() => {
  // Idempotent, never throws — the app must start even if hook install fails.
  installAgentHooks()
  registerBackgroundProtocol()
  registerPreviewProtocol()
  createWindow()
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow() })
})
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
