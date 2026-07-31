import { spawn } from 'node:child_process'

export interface CommandRun {
  code: number
  output: string
}

// pnpm, gt and node are not on the bare PATH an Electron app inherits from the
// macOS launcher.
const PATH_WITH_TOOLS = `${process.env.PATH ?? ''}:/opt/homebrew/bin:/usr/local/bin`

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
      env: { ...process.env, PATH: PATH_WITH_TOOLS }
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
