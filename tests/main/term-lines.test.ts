import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { sendLines } from '../../src/main/term-lines'

function fakeSink() {
  const written: string[] = []
  const listeners = new Set<() => void>()
  return {
    written,
    emit: () => listeners.forEach(l => l()),
    sink: {
      write: (d: string) => { written.push(d) },
      onData: (cb: () => void) => { listeners.add(cb); return () => listeners.delete(cb) }
    }
  }
}

describe('sendLines', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('sends the first line immediately, each with Enter', async () => {
    const { sink, written } = fakeSink()
    void sendLines(['tmux'], sink)
    expect(written).toEqual(['tmux\r'])
  })

  it('waits for quiet before each subsequent line', async () => {
    const { sink, written, emit } = fakeSink()
    const done = sendLines(['tmux', 'cc go'], sink, { quietMs: 250, maxMs: 2000 })
    expect(written).toEqual(['tmux\r'])

    // Output keeps arriving: the quiet window keeps restarting.
    await vi.advanceTimersByTimeAsync(200); emit()
    await vi.advanceTimersByTimeAsync(200)
    expect(written).toEqual(['tmux\r'])

    await vi.advanceTimersByTimeAsync(250)
    await done
    expect(written).toEqual(['tmux\r', 'cc go\r'])
  })

  it('gives up waiting at the cap when output never stops', async () => {
    const { sink, written, emit } = fakeSink()
    const done = sendLines(['tmux', 'cc go'], sink, { quietMs: 250, maxMs: 2000 })
    const chatty = setInterval(emit, 100)
    await vi.advanceTimersByTimeAsync(2000)
    clearInterval(chatty)
    await done
    expect(written).toEqual(['tmux\r', 'cc go\r'])
  })

  it('unsubscribes from output when finished', async () => {
    const { sink, emit } = fakeSink()
    const off = vi.fn()
    const spied = { ...sink, onData: (cb: () => void) => { sink.onData(cb); return off } }
    const done = sendLines(['a', 'b'], spied, { quietMs: 250, maxMs: 2000 })
    await vi.advanceTimersByTimeAsync(250)
    await done
    emit()
    expect(off).toHaveBeenCalled()
  })

  it('does nothing for an empty list', async () => {
    const { sink, written } = fakeSink()
    await sendLines([], sink)
    expect(written).toEqual([])
  })
})
