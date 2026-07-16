import { useEffect, useState } from 'react'
import { useStore } from './state/store'
import { Sidebar } from './components/Sidebar'
import { TerminalView } from './components/TerminalView'
import { DiffPanel } from './components/DiffPanel'

export function App() {
  const init = useStore(s => s.init)
  const selected = useStore(s => s.selected)
  const [diffCollapsed, setDiffCollapsed] = useState(false)
  useEffect(() => { init() }, [init])
  return (
    <div style={{ display: 'flex', height: '100vh', background: '#252526' }}>
      <Sidebar />
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0 }}>
        <div style={{ padding: 6, borderBottom: '1px solid #333', display: 'flex', gap: 8,
                      color: '#ddd', fontFamily: 'system-ui', fontSize: 12, alignItems: 'center' }}>
          <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {selected ?? 'No worktree selected'}
          </span>
        </div>
        <div style={{ flex: 1, minHeight: 0 }}>
          {selected && <TerminalView />}
        </div>
      </div>
      <DiffPanel collapsed={diffCollapsed} onToggle={() => setDiffCollapsed(c => !c)} />
    </div>
  )
}
