import { useEffect, useRef, type DragEvent } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import './terminal-theme.css'
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

// Wrap a path in single quotes so spaces and shell metacharacters survive being
// typed at a prompt; an embedded single quote is closed, escaped, and reopened.
function shellQuote(path: string): string {
  return `'${path.replace(/'/g, `'\\''`)}'`
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
        allowTransparency: true, cursorBlink: true,
        // ANSI palette matched to macOS Terminal.app's "Basic" profile so
        // indexed colors (e.g. orange) render the same as the native terminal.
        theme: {
          background: 'rgba(0, 0, 0, 0)',
          black: '#000000', red: '#990000', green: '#00a600', yellow: '#999900',
          blue: '#0000b2', magenta: '#b200b2', cyan: '#00a6b2', white: '#bfbfbf',
          brightBlack: '#666666', brightRed: '#e50000', brightGreen: '#00d900',
          brightYellow: '#e5e500', brightBlue: '#0000ff', brightMagenta: '#e500e5',
          brightCyan: '#00e5e5', brightWhite: '#e5e5e5'
        } })
      const fit = new FitAddon(); term.loadAddon(fit)
      term.onData(d => window.api.termInput(selected, d))
      // Shift+Enter → send Ctrl+J (line feed, 0x0a) instead of a plain CR (0x0d).
      // xterm.js sends the same byte for Enter and Shift+Enter by default; line
      // feed is Claude Code's universal "insert newline" (chat:newline) signal,
      // while CR remains submit.
      term.attachCustomKeyEventHandler(e => {
        if (e.type === 'keydown' && e.key === 'Enter' && e.shiftKey && !e.altKey && !e.ctrlKey && !e.metaKey) {
          // preventDefault stops the follow-up keypress event, otherwise xterm
          // would also send a plain CR (submit) right after our line feed.
          e.preventDefault()
          window.api.termInput(selected, '\x0a')
          return false
        }
        return true
      })
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

  // Dragging files onto the terminal types their quoted absolute paths at the
  // prompt (space-separated), so e.g. Claude Code receives real file references.
  // Both handlers must preventDefault: without it Electron navigates the window
  // to the dropped file, blowing away the app.
  const onDragOver = (e: DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) e.preventDefault()
  }
  // Pull the app to the foreground as soon as a file drag enters, so a drop
  // works even when Worktree Manager isn't the active app. Chromium still
  // delivers drag events to an unfocused window, so this fires without a click.
  const onDragEnter = (e: DragEvent) => {
    if (Array.from(e.dataTransfer.types).includes('Files')) window.api.focusWindow()
  }
  const onDrop = (e: DragEvent) => {
    if (!selected) return
    const files = Array.from(e.dataTransfer.files)
    if (files.length === 0) return
    e.preventDefault()
    const text = files.map(f => shellQuote(window.api.getPathForFile(f))).join(' ') + ' '
    window.api.termInput(selected, text)
    terms.get(selected)?.term.focus()
  }

  return <div ref={wrapRef} onDragEnter={onDragEnter} onDragOver={onDragOver} onDrop={onDrop}
              style={{ position: 'relative', height: '100%', width: '100%' }} />
}
