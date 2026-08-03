import { spawn, spawnSync } from 'node:child_process'

export interface CommandRun {
  code: number
  output: string
}

// pnpm, gt and node are not on the bare PATH an Electron app inherits from the
// macOS launcher, and version managers (nvm, volta, fnm) put them in per-user
// directories no hardcoded list can guess. Ask the login shell for the real PATH
// once, and fall back to the common package-manager prefixes if that fails.
const FALLBACK_PATH = `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`

let cachedPath: string | undefined

function toolPath(): string {
  if (cachedPath !== undefined) return cachedPath
  cachedPath = FALLBACK_PATH
  const shell = process.env.SHELL
  if (shell) {
    try {
      const res = spawnSync(shell, ['-lic', 'command -p echo "$PATH"'], {
        encoding: 'utf8',
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'ignore']
      })
      const resolved = res.stdout?.trim().split('\n').pop()?.trim()
      if (resolved) cachedPath = `${resolved}:${FALLBACK_PATH}`
    } catch {
      // keep the fallback
    }
  }
  return cachedPath
}

// stdin is /dev/null rather than the default pipe: repo scripts that read a hook
// payload with `INPUT=$(cat)` block forever on an inherited pipe that never
// closes. Non-zero exits resolve rather than reject — every caller here treats
// the code as an outcome to report, not an exception.
export function runCommand(
  cwd: string,
  file: string,
  args: string[],
  onOutput?: (chunk: string) => void
): Promise<CommandRun> {
  return new Promise(resolve => {
    onOutput?.(`$ ${file} ${args.join(' ')}\n`)

    const child = spawn(file, args, {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, PATH: toolPath() }
    })

    let output = ''
    const collect = (buf: Buffer) => {
      const chunk = buf.toString()
      output += chunk
      onOutput?.(chunk)
    }
    child.stdout.on('data', collect)
    child.stderr.on('data', collect)

    child.on('error', err => {
      const chunk = `${err.message}\n`
      output += chunk
      onOutput?.(chunk)
      resolve({ code: 1, output })
    })
    child.on('close', code => resolve({ code: code ?? 1, output }))
  })
}

// Last line of real output, for a one-line outcome message. Command failures put
// the useful part at the end (git and pnpm both do), and the popout has the rest.
export function lastLine(output: string): string {
  const lines = output.split('\n').map(l => l.trim()).filter(Boolean)
  return lines[lines.length - 1] ?? ''
}
