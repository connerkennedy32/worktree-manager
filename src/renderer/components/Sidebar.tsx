import { useState } from 'react'
import { useStore } from '../state/store'
import { NewWorktreeForm } from './NewWorktreeForm'
import { ConfirmModal } from './ConfirmModal'
import { disposeTerminal } from './TerminalView'
import type { Worktree } from '@shared/ipc-types'

export function Sidebar() {
  const { worktrees, statuses, selected, select, refreshWorktrees, repos } = useStore()
  const [pending, setPending] = useState<Worktree | null>(null)
  const [pendingRepo, setPendingRepo] = useState<string | null>(null)
  const [pickError, setPickError] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string>()

  const addRepo = async () => {
    try {
      await window.api.pickRepo()
      await useStore.getState().init()
    } catch (e: any) {
      // strip Electron's "Error invoking remote method '...':" prefix
      const msg = (e?.message ?? String(e)).replace(/^Error invoking remote method '[^']*':\s*Error:\s*/, '')
      setPickError(msg)
    }
  }

  const doDisconnectRepo = async () => {
    if (!pendingRepo) return
    setBusy(true); setError(undefined)
    try {
      const repos = await window.api.removeRepo(pendingRepo)
      useStore.setState({ repos })
      await refreshWorktrees()
      // Clear selection if the active worktree belonged to the disconnected repo.
      const stillThere = useStore.getState().worktrees.some(w => w.path === selected)
      if (!stillThere) useStore.setState({ selected: undefined })
      setPendingRepo(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally { setBusy(false) }
  }

  const pendingCount = pending ? (statuses[pending.path]?.changeCount ?? 0) : 0

  const doRemove = async () => {
    if (!pending) return
    setBusy(true); setError(undefined)
    try {
      await window.api.removeWorktree(pending.path, pendingCount > 0)
      disposeTerminal(pending.path)
      if (selected === pending.path) useStore.setState({ selected: undefined })
      await refreshWorktrees()
      setPending(null)
    } catch (e: any) {
      setError(e?.message ?? String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ width: 260, borderRight: '1px solid #333', display: 'flex', flexDirection: 'column',
                  background: 'rgba(30, 30, 30, 0.55)', color: '#ddd', fontFamily: 'system-ui', fontSize: 13 }}>
      <div style={{ padding: 8, fontWeight: 600, borderBottom: '1px solid #333',
                    display: 'flex', alignItems: 'center' }}>
        <span style={{ flex: 1 }}>WORKTREES</span>
        <button onClick={addRepo} style={{ fontSize: 11 }}>+ Repo</button>
      </div>
      {repos.length > 0 && (
        <div style={{ borderBottom: '1px solid #333', padding: '4px 0' }}>
          {repos.map(repo => {
            const name = repo.split('/').filter(Boolean).pop() ?? repo
            return (
              <div key={repo} title={repo}
                   style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '3px 10px',
                            fontSize: 11, color: '#9aa' }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {name}
                </span>
                <span title="Disconnect repo" onClick={() => setPendingRepo(repo)}
                      style={{ color: '#888', cursor: 'pointer' }}>✕</span>
              </div>
            )
          })}
        </div>
      )}
      <div style={{ flex: 1, overflowY: 'auto' }}>
        {worktrees.length === 0 && (
          <div style={{ padding: 10, color: '#888', fontSize: 12 }}>
            No repos yet. Click "+ Repo" to add a git repository.
          </div>
        )}
        {worktrees.map(w => {
          const count = statuses[w.path]?.changeCount ?? 0
          return (
            <div key={w.path} onClick={() => select(w.path)}
                 style={{ padding: '6px 10px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between',
                          background: selected === w.path ? '#094771' : 'transparent' }}>
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {w.isMain ? '● ' : '▸ '}{w.branch}
              </span>
              <span style={{ display: 'flex', gap: 6, alignItems: 'center', flexShrink: 0 }}>
                {count > 0 && <span style={{ background: '#c93', color: '#000', borderRadius: 8,
                                             padding: '0 6px', fontSize: 11 }}>{count}</span>}
                {!w.isMain && <span title="Remove worktree" onClick={(e) => {
                  e.stopPropagation()
                  setError(undefined); setPending(w)
                }} style={{ color: '#888', cursor: 'pointer' }}>✕</span>}
              </span>
            </div>
          )
        })}
      </div>
      {repos[0] && <NewWorktreeForm repoPath={repos[0]} />}

      {pending && (
        <ConfirmModal
          title="Remove worktree?"
          body={
            `This will remove the "${pending.branch}" worktree at:\n${pending.path}\n\nThe "${pending.branch}" branch will also be deleted.` +
            (pendingCount > 0
              ? `\n\nThis worktree has ${pendingCount} uncommitted change${pendingCount === 1 ? '' : 's'}, which will be discarded.`
              : '')
          }
          confirmLabel="Remove"
          danger
          busy={busy}
          error={error}
          onConfirm={doRemove}
          onCancel={() => { if (!busy) { setPending(null); setError(undefined) } }}
        />
      )}

      {pendingRepo && (
        <ConfirmModal
          title="Disconnect repo?"
          body={`Stop tracking this repository in the app:\n${pendingRepo}\n\nThis only removes it from the app — no files, worktrees, or branches on disk are touched.`}
          confirmLabel="Disconnect"
          busy={busy}
          error={error}
          onConfirm={doDisconnectRepo}
          onCancel={() => { if (!busy) { setPendingRepo(null); setError(undefined) } }}
        />
      )}

      {pickError && (
        <ConfirmModal
          title="Can't add that folder"
          body={pickError}
          confirmLabel="OK"
          onConfirm={() => setPickError(undefined)}
          onCancel={() => setPickError(undefined)}
        />
      )}
    </div>
  )
}
