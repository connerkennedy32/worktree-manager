import { useEffect, useRef, useState } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TerminalView, resetTerminal } from './components/TerminalView'
import { DiffPanel } from './components/DiffPanel'
import backdrop from './assets/voyage-backdrop.jpg'

const MIN_DIFF_WIDTH = 280
const MAX_DIFF_WIDTH = 900

export function App() {
  const init = useStore(s => s.init)
  const selected = useStore(s => s.selected)
  const [diffCollapsed, setDiffCollapsed] = useState(false)
  const [diffWidth, setDiffWidth] = useState(MIN_DIFF_WIDTH)
  const dragging = useRef(false)

  useEffect(() => { init() }, [init])

  // Reset the active terminal when the Terminal › Reset menu item is chosen.
  useEffect(() => {
    return window.api.onMenuResetTerminal(() => {
      const sel = useStore.getState().selected
      if (sel) resetTerminal(sel)
    })
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
      {/* Wezterm-style backdrop: darkened image + #282c35 overlay, faded behind the UI */}
      <div style={{ position: 'fixed', inset: 0, zIndex: -1,
                    backgroundImage: `url(${backdrop})`, backgroundSize: 'cover',
                    backgroundPosition: 'center', filter: 'brightness(0.5)' }} />
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
    </div>
  )
}
