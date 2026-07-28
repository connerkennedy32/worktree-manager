// node-pty ships prebuilt macOS binaries (`pty.node`, `spawn-helper`) that cause
// two problems in local development on Apple Silicon:
//   1. The `spawn-helper` exec bit is sometimes dropped during extraction,
//      causing `posix_spawnp failed` at runtime.
//   2. The binaries are unsigned and may carry a `com.apple.quarantine` xattr,
//      so macOS Gatekeeper blocks them with an "unidentified developer / malware"
//      dialog and refuses to load the native module.
// This postinstall step restores the exec bit, strips quarantine, and applies an
// ad-hoc code signature so the binaries load. Safe no-op on non-macOS platforms.
import { chmodSync, existsSync, statSync } from 'fs'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')

if (process.platform !== 'darwin') {
  process.exit(0)
}

// Native binaries that must be executable, de-quarantined, and ad-hoc signed.
const binaries = [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-arm64/pty.node',
  'node_modules/node-pty/prebuilds/darwin-x64/pty.node',
  'node_modules/node-pty/build/Release/pty.node'
]

function run(cmd, args) {
  try {
    execFileSync(cmd, args, { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// Apple revoked the notarization for some prebuilt Electron releases (e.g.
// 31.7.7). macOS then treats the binary as malware and TRASHES it on launch
// ("... will damage your computer"). Deep ad-hoc re-signing replaces the
// revoked notarized signature so Gatekeeper stops flagging it. Runs before the
// node-pty fixes because a missing Electron.app blocks `dev` entirely.
const electronApp = join(root, 'node_modules/electron/dist/Electron.app')
if (existsSync(electronApp)) {
  run('xattr', ['-rd', 'com.apple.quarantine', electronApp])
  if (run('codesign', ['--force', '--deep', '--sign', '-', electronApp])) {
    console.log('[fix-pty-perms] deep ad-hoc re-signed Electron.app')
  } else {
    console.warn('[fix-pty-perms] could not re-sign Electron.app')
  }
}

for (const rel of binaries) {
  const p = join(root, rel)
  if (!existsSync(p)) continue

  // 1. Restore exec bit (spawn-helper needs it).
  try {
    const mode = statSync(p).mode
    if (!(mode & 0o111)) {
      chmodSync(p, 0o755)
      console.log(`[fix-pty-perms] chmod +x ${rel}`)
    }
  } catch (e) {
    console.warn(`[fix-pty-perms] could not chmod ${rel}: ${e.message}`)
  }

  // 2. Strip quarantine (ignore if attribute is absent).
  run('xattr', ['-d', 'com.apple.quarantine', p])

  // 3. Ad-hoc code sign so Gatekeeper allows loading the unsigned binary.
  if (run('codesign', ['--force', '--sign', '-', p])) {
    console.log(`[fix-pty-perms] ad-hoc signed ${rel}`)
  } else {
    console.warn(`[fix-pty-perms] could not codesign ${rel}`)
  }
}
