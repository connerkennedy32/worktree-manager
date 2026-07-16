import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { useStore } from '../state/store'

interface Entry { term: Terminal; fit: FitAddon; container: HTMLDivElement }

// Each worktree gets its own xterm instance opened once into its own container
// div. Switching worktrees only toggles which container is visible — an xterm
// terminal must never be re-open()ed or moved to a new element, or it stops
// rendering. Containers persist across React re-renders (module-level map).
const terms = new Map<string, Entry>()
let dataBound = false

export function disposeTerminal(worktreePath: string) {
  const entry = terms.get(worktreePath)
  if (entry) {
    try { entry.term.dispose() } catch { /* ignore */ }
    entry.container.remove()
  }
  terms.delete(worktreePath)
}

// Reset a wedged terminal: clear the on-screen xterm, then have main kill the
// shell and spawn a fresh one whose output streams into the same xterm.
export async function resetTerminal(worktreePath: string) {
  terms.get(worktreePath)?.term.reset()
  await window.api.termReset(worktreePath)
}

function ensureDataBound() {
  if (dataBound) return
  window.api.onTermData((p, d) => terms.get(p)?.term.write(d))
  dataBound = true
}

function fitEntry(entry: Entry, worktreePath: string) {
  if (!entry.container.clientWidth || !entry.container.clientHeight) return
  try { entry.fit.fit() } catch { /* ignore transient sizing errors */ }
  window.api.termResize(worktreePath, entry.term.cols, entry.term.rows)
}

export function TerminalView() {
  const selected = useStore(s => s.selected)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrap = wrapRef.current
    if (!selected || !wrap) return
    ensureDataBound()

    let entry = terms.get(selected)
    if (!entry) {
      const container = document.createElement('div')
      container.style.position = 'absolute'
      container.style.inset = '0'
      wrap.appendChild(container)
      const term = new Terminal({ fontFamily: 'Menlo, monospace', fontSize: 13,
        allowTransparency: true, theme: { background: 'rgba(0, 0, 0, 0)' }, cursorBlink: true })
      const fit = new FitAddon(); term.loadAddon(fit)
      term.onData(d => window.api.termInput(selected, d))
      term.open(container)
      entry = { term, fit, container }
      terms.set(selected, entry)
      // Start the pty only now that the terminal exists and onTermData is bound.
      window.api.termStart(selected)
    } else if (entry.container.parentElement !== wrap) {
      // Component remounted (e.g. after selection was cleared): re-attach the
      // existing container rather than creating a new terminal.
      wrap.appendChild(entry.container)
    }

    // Show the selected worktree's terminal, hide the rest.
    for (const [p, e] of terms) {
      e.container.style.display = p === selected ? 'block' : 'none'
    }

    fitEntry(entry, selected)
    entry.term.focus()

    // Refit whenever the wrapper resizes — including when it goes from hidden
    // (diff tab / 0-size) to visible, which a window resize listener would miss.
    const ro = new ResizeObserver(() => {
      const e = terms.get(selected)
      if (e) fitEntry(e, selected)
    })
    ro.observe(wrap)
    return () => ro.disconnect()
  }, [selected])

  return <div ref={wrapRef} style={{ position: 'relative', height: '100%', width: '100%' }} />
}
