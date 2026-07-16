import { useState } from 'react'
import { useStore } from '../state/store'
import './sidebar-theme.css'

export function NewWorktreeForm({ repoPath }: { repoPath: string }) {
  const [branch, setBranch] = useState('')
  const [busy, setBusy] = useState(false)
  const refresh = useStore(s => s.refreshWorktrees)
  const select = useStore(s => s.select)

  const create = async () => {
    if (!branch.trim() || busy) return
    setBusy(true)
    try {
      const name = branch.trim().replace(/\s+/g, '-')
      const worktrees = await window.api.createWorktree({ repoPath, branch: branch.trim(), createBranch: true })
      setBranch('')
      await refresh()
      // Navigate to the newly created worktree so its terminal opens automatically.
      const created = worktrees.find(w => w.branch === name)
      if (created) select(created.path)
    } finally { setBusy(false) }
  }

  return (
    <div style={{ display: 'flex', gap: 6, padding: 8, borderTop: '1px solid #333' }}>
      <input className="wt-input" placeholder="new branch" value={branch} onChange={e => setBranch(e.target.value)}
             onKeyDown={e => { if (e.key === 'Enter') create() }}
             style={{ flex: 1, minWidth: 0 }} />
      <button className="wt-btn wt-btn-primary" onClick={create} disabled={busy}>+ WT</button>
    </div>
  )
}
