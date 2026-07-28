// electron-builder afterSign hook.
//
// Apple revoked the notarization for the prebuilt Electron 31.7.7 binaries this
// app is built on. macOS then treats the packaged app as malware and trashes it
// on launch ("... will damage your computer"). electron-builder's own ad-hoc
// signing leaves the revoked notarized signature partially in place on the
// nested Electron Framework / Helper apps, so the flag survives.
//
// This hook does a clean, complete deep ad-hoc re-sign of the whole bundle,
// replacing every revoked signature with a fresh ad-hoc one so there is no
// revoked notarization ticket left for Gatekeeper to check. It also strips
// quarantine. This is local ad-hoc signing only — not a substitute for a real
// Developer ID + notarization if the app is ever distributed publicly.
const { execFileSync } = require('child_process')
const path = require('path')

exports.default = async function afterSign(context) {
  if (context.electronPlatformName !== 'darwin') return

  const appName = `${context.packager.appInfo.productFilename}.app`
  const appPath = path.join(context.appOutDir, appName)
  const entitlements = path.join(__dirname, 'entitlements.mac.plist')

  console.log(`[afterSign] deep ad-hoc re-signing ${appPath}`)

  // Strip quarantine (best-effort; ignore if absent).
  try {
    execFileSync('xattr', ['-rd', 'com.apple.quarantine', appPath], { stdio: 'ignore' })
  } catch {}

  // Deep ad-hoc re-sign the entire bundle. --deep signs nested components
  // inside-out, --force replaces the revoked signatures.
  execFileSync(
    'codesign',
    ['--force', '--deep', '--sign', '-', '--entitlements', entitlements, appPath],
    { stdio: 'inherit' }
  )

  // Verify the seal is valid before it gets wrapped into the DMG.
  execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: 'inherit' })
  console.log('[afterSign] re-sign verified OK')
}
