// node-pty ships a macOS `spawn-helper` binary that must be executable, but some
// npm/prebuild extractions drop the exec bit, causing `posix_spawnp failed` at
// runtime. This postinstall step restores it. Safe no-op on other platforms.
import { chmodSync, existsSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const candidates = [
  'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper',
  'node_modules/node-pty/prebuilds/darwin-x64/spawn-helper',
  'node_modules/node-pty/build/Release/spawn-helper'
]

for (const rel of candidates) {
  const p = join(root, rel)
  if (!existsSync(p)) continue
  try {
    const mode = statSync(p).mode
    if (!(mode & 0o111)) {
      chmodSync(p, 0o755)
      console.log(`[fix-pty-perms] chmod +x ${rel}`)
    }
  } catch (e) {
    console.warn(`[fix-pty-perms] could not chmod ${rel}: ${e.message}`)
  }
}
