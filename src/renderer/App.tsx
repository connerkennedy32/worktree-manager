import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TerminalView, resetTerminal } from './components/TerminalView'
import { DiffPanel } from './components/DiffPanel'
import { DiffModal } from './components/DiffModal'
import { NewWorktreeModal } from './components/NewWorktreeModal'
import blackholeVideo from './assets/blackhole-backdrop.mp4'
import voyageImage from './assets/voyage-backdrop.jpg'

const VIDEO_EXTS = ['.mp4', '.webm', '.mov', '.m4v', '.ogv']
const isVideo = (name: string) => VIDEO_EXTS.some(e => name.toLowerCase().endsWith(e))
// Built-in backdrops, keyed by the `builtin:<id>` selection value from the menu.
const BUILTINS: Record<string, { src: string; video: boolean }> = {
  'builtin:voyage': { src: voyageImage, video: false },
  'builtin:blackhole': { src: blackholeVideo, video: true }
}
// Resolve the active backdrop. '' = blank (no element). A `builtin:` value maps
// to a bundled asset; anything else is a user-added file served over wtm-bg://.
function useBackdrop() {
  const selected = useStore(s => s.selectedBackground)
  if (!selected) return null
  if (selected in BUILTINS) return BUILTINS[selected]
  return { src: `wtm-bg://bg/${encodeURIComponent(selected)}`, video: isVideo(selected) }
}

const MIN_DIFF_WIDTH = 280
const MAX_DIFF_WIDTH = 900

const backdropStyle: React.CSSProperties = {
  position: 'fixed', inset: 0, zIndex: -1,
  width: '100%', height: '100%', objectFit: 'cover', filter: 'brightness(0.5)'
}

function Backdrop() {
  const backdrop = useBackdrop()
  if (!backdrop) return null // blank
  const { src, video } = backdrop
  // key=src forces a fresh element on switch so the new source actually loads.
  return video
    ? <video key={src} src={src} autoPlay loop muted playsInline style={backdropStyle} />
    : <img key={src} src={src} style={backdropStyle} />
}

export function App() {
  const init = useStore(s => s.init)
  const selected = useStore(s => s.selected)
  const [diffCollapsed, setDiffCollapsed] = useState(false)
  const [diffWidth, setDiffWidth] = useState(MIN_DIFF_WIDTH)
  const [newRepo, setNewRepo] = useState<string | null>(null)
  const dragging = useRef(false)

  // Resolve which repo a new worktree should be created in: the selected
  // worktree's repo root (its main worktree), else the first connected repo.
  const repoForNew = () => {
    const s = useStore.getState()
    const sel = s.worktrees.find(w => w.path === s.selected)
    if (sel) {
      const main = s.worktrees.find(w => w.isMain && w.repoName === sel.repoName)
      if (main) return main.path
    }
    return s.repos[0]
  }

  useEffect(() => { init() }, [init])

  // Reset the active terminal when the Terminal › Reset menu item is chosen.
  useEffect(() => {
    return window.api.onMenuResetTerminal(() => {
      const sel = useStore.getState().selected
      if (sel) resetTerminal(sel)
    })
  }, [])

  // Open the new-worktree dialog from the Worktree › New menu item (Cmd+N).
  useEffect(() => {
    return window.api.onMenuNewWorktree(() => {
      const repo = repoForNew()
      if (repo) setNewRepo(repo)
    })
  }, [])

  // Step through worktrees from the Worktree menu (Cmd+Up / Cmd+Down). These are
  // menu accelerators rather than a keydown listener so Electron consumes them
  // before the focused terminal can send them to the shell.
  useEffect(() => {
    const prev = window.api.onMenuSelectPrev(() => useStore.getState().selectRelative(-1))
    const next = window.api.onMenuSelectNext(() => useStore.getState().selectRelative(1))
    return () => { prev(); next() }
  }, [])

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      if (!dragging.current) return
      const w = Math.min(Math.max(window.innerWidth - e.clientX, MIN_DIFF_WIDTH), MAX_DIFF_WIDTH)
      setDiffWidth(w)
    }
    const onUp = () => {
      if (!dragging.current) return
      dragging.current = false
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
    return () => { window.removeEventListener('mousemove', onMove); window.removeEventListener('mouseup', onUp) }
  }, [])

  const startDrag = () => {
    dragging.current = true
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
  }

  return (
    <div style={{ display: 'flex', height: '100vh', position: 'relative' }}>
      {/* Wezterm-style backdrop: darkened image/video + #282c35 overlay, faded behind the UI */}
      <Backdrop />
      <div style={{ position: 'fixed', inset: 0, zIndex: -1, background: 'rgba(40, 44, 53, 0.72)' }} />
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ flex: 1, minHeight: 0 }}>
          {selected && <TerminalView />}
        </div>
      </div>
      {!diffCollapsed && (
        <div onMouseDown={startDrag} title="Drag to resize"
             style={{ width: 5, cursor: 'col-resize', background: '#333', flexShrink: 0 }} />
      )}
      <DiffPanel collapsed={diffCollapsed} width={diffWidth}
                 onToggle={() => setDiffCollapsed(c => !c)} />
      {newRepo && <NewWorktreeModal repoPath={newRepo} onClose={() => setNewRepo(null)} />}
      <DiffModal />
    </div>
  )
}
