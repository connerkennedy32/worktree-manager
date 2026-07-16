import { useState } from 'react'
import { useStore } from '../state/store'

export function NewWorktreeForm({ repoPath }: { repoPath: string }) {
  const [branch, setBranch] = useState('')
  const refresh = useStore(s => s.refreshWorktrees)
  return (
    <div style={{ display: 'flex', gap: 4, padding: 8, borderTop: '1px solid #333' }}>
      <input placeholder="new branch" value={branch} onChange={e => setBranch(e.target.value)}
             style={{ flex: 1, minWidth: 0 }} />
      <button onClick={async () => {
        if (!branch) return
        await window.api.createWorktree({ repoPath, branch, createBranch: true })
        setBranch(''); refresh()
      }}>+ WT</button>
    </div>
  )
}
