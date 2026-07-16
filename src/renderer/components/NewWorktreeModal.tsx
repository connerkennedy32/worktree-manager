import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'

export function NewWorktreeModal({ repoPath, onClose }: { repoPath: string; onClose: () => void }) {
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()
  const inputRef = useRef<HTMLInputElement>(null)
  const refresh = useStore(s => s.refreshWorktrees)
  const select = useStore(s => s.select)

  useEffect(() => { inputRef.current?.focus() }, [])

  // Suppress worktree navigation while open — Cmd+Up/Down would otherwise fire
  // while you're typing a branch name.
  useEffect(() => {
    useStore.getState().pushModal()
    return () => useStore.getState().popModal()
  }, [])

  const create = async () => {
    const name = branch.trim()
    if (!name || busy) return
    setBusy(true); setError(undefined)
    try {
      const worktrees = await window.api.createWorktree({ repoPath, branch: name, createBranch: true })
      await refresh()
      const created = worktrees.find(w => w.branch === name.replace(/\s+/g, '-'))
      if (created) select(created.path)
      onClose()
    } catch (e: any) {
      const msg = (e?.message ?? String(e)).replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, '')
      setError(msg)
      setBusy(false)
    }
  }

  return (
    <div onClick={() => { if (!busy) onClose() }}
         style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)', zIndex: 1000,
                  display: 'flex', alignItems: 'flex-start', justifyContent: 'center', paddingTop: '18vh' }}>
      <div onClick={e => e.stopPropagation()}
           style={{ background: '#2d2d2d', color: '#ddd', fontFamily: 'system-ui',
                    border: '1px solid #444', borderRadius: 8, padding: 18, width: 460,
                    boxShadow: '0 12px 40px rgba(0,0,0,0.55)' }}>
        <div style={{ fontSize: 14, fontWeight: 600, marginBottom: 4 }}>New worktree</div>
        <div style={{ fontSize: 11, color: '#888', marginBottom: 12, overflow: 'hidden',
                      textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          in {repoPath.split('/').filter(Boolean).pop()}
        </div>
        <input ref={inputRef} value={branch} placeholder="branch name"
               onChange={e => setBranch(e.target.value)}
               onKeyDown={e => {
                 if (e.key === 'Enter') create()
                 else if (e.key === 'Escape' && !busy) onClose()
               }}
               style={{ width: '100%', background: '#1e1e1e', color: '#eee', border: '1px solid #555',
                        borderRadius: 5, padding: '8px 10px', fontSize: 14, fontFamily: 'system-ui' }} />
        {error && <div style={{ color: '#f28b82', fontSize: 12, marginTop: 10, whiteSpace: 'pre-wrap' }}>{error}</div>}
        <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 14 }}>
          <button onClick={() => { if (!busy) onClose() }} disabled={busy}>Cancel</button>
          <button onClick={create} disabled={busy || !branch.trim()}
                  style={{ background: branch.trim() ? '#0e639c' : '#3a3a3a', color: '#fff', border: 'none',
                           padding: '5px 14px', borderRadius: 4, cursor: busy ? 'default' : 'pointer' }}>
            {busy ? 'Creating…' : 'Create'}
          </button>
        </div>
      </div>
    </div>
  )
}
