// Typing a line before the previous one has produced a shell ready to receive
// it sends keystrokes somewhere unintended — `cc` arriving before tmux exists.
// Waiting for the pty to fall silent is the closest available proxy for "ready".
export const QUIET_MS = 250
// A program that never stops printing would otherwise stall the sequence
// forever. Past this point we type anyway and accept the race; the one-line
// `tmux new … \; send-keys …` form avoids the question entirely.
export const MAX_WAIT_MS = 2_000

export interface LineSink {
  write(data: string): void
  // Called on every chunk of pty output; returns an unsubscribe.
  onData(cb: () => void): () => void
}

function waitForQuiet(sink: LineSink, quietMs: number, maxMs: number): Promise<void> {
  return new Promise(resolve => {
    let quietTimer: ReturnType<typeof setTimeout>
    let off: () => void = () => {}
    const finish = (): void => {
      clearTimeout(quietTimer)
      clearTimeout(capTimer)
      off()
      resolve()
    }
    const restart = (): void => {
      clearTimeout(quietTimer)
      quietTimer = setTimeout(finish, quietMs)
    }
    const capTimer = setTimeout(finish, maxMs)
    off = sink.onData(restart)
    restart()
  })
}

export async function sendLines(
  lines: string[],
  sink: LineSink,
  opts: { quietMs?: number; maxMs?: number } = {}
): Promise<void> {
  const { quietMs = QUIET_MS, maxMs = MAX_WAIT_MS } = opts
  for (let i = 0; i < lines.length; i++) {
    // Not before the first line: the pty buffers input written before the shell
    // is up, which is how the lazygit button has always worked.
    if (i > 0) await waitForQuiet(sink, quietMs, maxMs)
    sink.write(`${lines[i]}\r`)
  }
}
