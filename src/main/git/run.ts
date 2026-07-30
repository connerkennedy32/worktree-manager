import { spawn } from 'node:child_process'
import { pushEnv } from './push'

export interface GitRun {
  code: number
  output: string   // stdout and stderr interleaved, as a terminal would show it
}

// Run a git command and stream its output as it arrives.
//
// simple-git buffers until the process exits, which is fine for a diff but
// useless for showing progress: a `fetch` against a slow remote would sit
// silent and then dump everything at once. This is spawn-based so each chunk
// reaches the renderer live. It also reports the exit code rather than
// rejecting, since a non-zero git exit (a conflicted merge) is an outcome the
// caller interprets, not an exception.
export function runGit(
  cwd: string,
  args: string[],
  onOutput?: (chunk: string) => void
): Promise<GitRun> {
  return new Promise(resolve => {
    // Echo the command first so the popout reads like a terminal session
    // rather than bare output with no context.
    onOutput?.(`$ git ${args.join(' ')}\n`)

    // Same env as push: git needs PATH/HOME/SSH_AUTH_SOCK to reach a remote,
    // and the no-prompt vars so a credential prompt fails fast instead of
    // blocking on a terminal that isn't there.
    const child = spawn('git', args, { cwd, env: pushEnv() })

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
